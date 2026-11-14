'use strict';
// Copyright (C) 2026 Employee Jukebox contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Employee Jukebox — one shared, anonymous, always-on playlist.
// Songs are pulled from YouTube with yt-dlp, saved as MP3s, and served from this box.
// No npm dependencies. Needs Node 18+, yt-dlp and ffmpeg on the PATH.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------- settings (env vars) ----------
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';                   // 127.0.0.1 when a tunnel/proxy on the same box fronts it
const RATE_LIMIT = process.env.RATE_LIMIT === undefined ? 30 : Number(process.env.RATE_LIMIT); // adds per hour per IP, 0 = unlimited
const MAX_MINUTES = process.env.MAX_MINUTES === undefined ? 20 : Number(process.env.MAX_MINUTES); // longest song, 0 = no cap
const TRUST_PROXY = process.env.TRUST_PROXY === '1';          // set to 1 behind Caddy/nginx/Cloudflare
const YTDLP = process.env.YTDLP || 'yt-dlp';                 // path to yt-dlp if it isn't on the PATH
const MAX_SONGS = Number(process.env.MAX_SONGS) || 3000;      // library cap (~3.5 MB each), so the disk can't be filled
const SKIP_LIMIT = Number(process.env.SKIP_LIMIT) || 60;      // skips per hour per IP
const SHUFFLE_LIMIT = Number(process.env.SHUFFLE_LIMIT) || 20; // shuffles per hour per IP
const REMOVE_LIMIT = Number(process.env.REMOVE_LIMIT) || 20;  // removals per hour per IP
const MAX_LISTENERS = 300, MAX_LISTENERS_PER_IP = 10, MAX_PENDING_ADDS = 10;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'jukebox.json');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
// fingerprint of this version of the app; when it changes (a new deployment), removed songs are allowed back
const DEPLOY = crypto.createHash('sha256')
  .update(['server.js', 'public/app.js', 'public/index.html'].map(f => { try { return fs.readFileSync(path.join(__dirname, f)); } catch { return ''; } }).join('\0'))
  .digest('hex').slice(0, 16);
const PUBLIC_DIR = path.join(__dirname, 'public');

class UserError extends Error {}
class UserWarning extends UserError {} // the user can fix it themselves (shown as a warning, not an error)
const isId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
const has = id => isId(id) && Object.prototype.hasOwnProperty.call(state.songs, id);
// strip control and text-direction characters from anything shown to listeners
const clean = (t, max) => String(t || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
const audioPath = id => path.join(AUDIO_DIR, id + '.mp3');
const hasAudio = id => fs.existsSync(audioPath(id));

// ---------- state ----------
// songs: { [videoId]: {id, title, author, duration, dedication, addedAt, fails} }
// queue: newly added songs, played first (FIFO)
// rotation: the rest of the current shuffled pass through the whole library
// current: {id, startedAt}
// removed: { [videoId]: removedAt } — songs taken out; they can't be added again until the next deployment
let state = { songs: {}, queue: [], rotation: [], current: null, removed: {}, deploy: null };

function load() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = { songs: s.songs || {}, queue: s.queue || [], rotation: s.rotation || [], current: s.current || null, removed: s.removed || {}, deploy: s.deploy };
    if (state.deploy !== DEPLOY && Object.keys(state.removed).length) {
      console.log(`New version deployed: ${Object.keys(state.removed).length} removed song(s) can be added again`);
      state.removed = {};
    }
    console.log(`Loaded ${Object.keys(state.songs).length} songs`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read data file:', e.message);
  }
}

let saveTimer = null;
function writeNow() {
  clearTimeout(saveTimer);
  state.deploy = DEPLOY;
  saveTimer = null;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 300);
}
// don't lose the last change when the service is stopped or Ctrl+C'd
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (saveTimer) writeNow(); process.exit(0); });

// ---------- playback engine ----------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const playable = id => has(id) && !!state.songs[id].duration && hasAudio(id);

function pickNext() {
  state.queue = state.queue.filter(has);
  state.rotation = state.rotation.filter(has);
  const q = state.queue.findIndex(playable);
  if (q !== -1) return state.queue.splice(q, 1)[0];
  if (!state.rotation.some(playable)) {
    const curId = state.current && state.current.id;
    let pool = Object.keys(state.songs).filter(id => id !== curId && playable(id));
    if (!pool.length) pool = Object.keys(state.songs).filter(playable); // only one song: repeat it
    state.rotation = shuffle(pool);
  }
  const r = state.rotation.findIndex(playable);
  return r === -1 ? null : state.rotation.splice(r, 1)[0];
}

function advance() {
  // skipped or removed mid-song: finish the current audio frame (a few ms) so the cut is clean
  if (onAir && onAir.pos < onAir.buf.length) {
    const end = nextFrame(onAir.buf, onAir.pos);
    if (end > onAir.pos) send(onAir.buf.subarray(onAir.pos, end));
  }
  const id = pickNext();
  state.current = id ? { id, startedAt: Date.now() } : null;
  goOnAir(false);
  save();
  broadcast();
}

// ---------- the broadcast ----------
// Like a radio station: the server plays the current song out at exactly real-time speed and
// every listener receives the same bytes. Every MP3 is 128 kbps CBR, 44.1 kHz stereo, so songs
// join into one continuous stream and byte count = playing time.
const BYTES_PER_SEC = 128000 / 8;
const LEAD_IN = 2 * BYTES_PER_SEC;   // new listeners get the last 2 s so playback starts right away
let onAir = null;                    // { id, buf, pos }
let recent = Buffer.alloc(0);
const listeners = new Set();

function stripTags(buf) {
  let start = 0, end = buf.length;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  if (end - start > 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  return buf.subarray(start, end);
}

// true if the file is the format the stream needs (MPEG-1 Layer III, 128 kbps, 44.1 kHz)
function audioOk(id) {
  try {
    const fd = fs.openSync(audioPath(id), 'r');
    const head = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const b = stripTags(head.subarray(0, n));
    for (let o = 0; o < Math.min(b.length - 4, 8192); o++) {
      if (b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0) {
        return ((b[o + 1] >> 3) & 3) === 3 && ((b[o + 1] >> 1) & 3) === 1 && (b[o + 2] >> 4) === 9 && ((b[o + 2] >> 2) & 3) === 0;
      }
    }
  } catch {}
  return false;
}

// index of the next MP3 frame header at or after `from` (our frames: fffb9x)
function nextFrame(buf, from) {
  for (let o = Math.max(0, from); o < buf.length - 3; o++) {
    if (buf[o] === 0xff && buf[o + 1] === 0xfb && (buf[o + 2] & 0xfc) === 0x90) return o;
  }
  return buf.length;
}

function goOnAir(resume = true) {
  onAir = null;
  if (!state.current) return;
  const id = state.current.id;
  if (!audioOk(id)) { fs.rmSync(audioPath(id), { force: true }); return advance(); } // old format: re-downloaded by backfill
  let buf;
  try { buf = stripTags(fs.readFileSync(audioPath(id))); }
  catch { console.log(`Can't read audio for ${id}, skipping it`); delete state.songs[id]; return advance(); }
  // a new song starts at its first byte; after a restart, pick up where it would be now, on a frame boundary
  const pos = resume ? nextFrame(buf, Math.floor((Date.now() - state.current.startedAt) / 1000 * BYTES_PER_SEC)) : 0;
  if (pos >= buf.length) return advance();
  onAir = { id, buf, pos };
}

function send(chunk) {
  recent = recent.length + chunk.length > LEAD_IN
    ? Buffer.concat([recent, chunk]).subarray(-LEAD_IN)
    : Buffer.concat([recent, chunk]);
  for (const res of listeners) {
    if (res.writableLength > 1024 * 1024) { res.destroy(); listeners.delete(res); continue; } // can't keep up: drop
    res.write(chunk);
  }
}

// every 100 ms, send whatever the clock says is due
setInterval(() => {
  if (!onAir) {
    if (!state.current && Object.keys(state.songs).some(playable)) advance();
    return;
  }
  const due = Math.min(onAir.buf.length, Math.floor((Date.now() - state.current.startedAt) / 1000 * BYTES_PER_SEC));
  if (due > onAir.pos) { send(onAir.buf.subarray(onAir.pos, due)); onAir.pos = due; }
  if (onAir.pos >= onAir.buf.length) advance();
}, 100);

// ---------- yt-dlp ----------
function run(args, timeoutMs) {
  if (!isId(args[args.length - 1])) return Promise.reject(new UserError('That doesn’t look like a YouTube link.'));
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new UserError('YouTube took too long to answer. Try again in a minute.')); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => {
      clearTimeout(t);
      if (e.code === 'ENOENT') {
        console.error(`yt-dlp not found (looked for "${YTDLP}"). Install it or set YTDLP=/path/to/yt-dlp`);
        reject(new UserError('The jukebox server is missing yt-dlp. Ask whoever runs it to install it.'));
      } else reject(e);
    });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(err.trim() || `yt-dlp exited ${code}`), { stderr: err }));
    });
  });
}

function friendly(e) {
  if (e instanceof UserError) return e;
  const msg = String(e.stderr || e.message || '');
  console.error('yt-dlp:', msg.split('\n').filter(Boolean).slice(-2).join(' | '));
  if (/private video/i.test(msg)) return new UserError('That video is private.');
  if (/confirm your age|age-restricted/i.test(msg)) return new UserError('That video is age-restricted, so it can’t be added.');
  if (/not a bot/i.test(msg)) return new UserError('YouTube is blocking downloads from the jukebox server right now. Try again later.');
  if (/ffmpeg|ffprobe/i.test(msg)) return new UserError('The jukebox server is missing ffmpeg. Ask whoever runs it to install it.');
  if (/unavailable|does not exist|removed/i.test(msg)) return new UserError('That video doesn’t exist or isn’t available.');
  return new UserError('Couldn’t get that song from YouTube. Try a different upload of it.');
}

async function lookup(id) {
  let info;
  try { info = JSON.parse(await run(['--ignore-config', '--no-cache-dir', '-J', '--no-playlist', '--no-warnings', '--', id], 45000)); }
  catch (e) { throw friendly(e); }
  if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw new UserError('Live streams can’t be added.');
  const duration = Math.round(Number(info.duration) || 0);
  if (!duration) throw new UserError('Couldn’t tell how long that video is, so it can’t be added.');
  if (MAX_MINUTES > 0 && duration > MAX_MINUTES * 60) throw new UserError(`That one’s too long (limit is ${MAX_MINUTES} minutes).`);
  return { id, title: clean(info.title, 200) || id, author: clean(info.channel || info.uploader, 100), duration };
}

function cleanupPartial(id) {
  for (const f of fs.readdirSync(AUDIO_DIR)) {
    if (f.startsWith(id + '.') && f !== id + '.mp3') fs.rmSync(path.join(AUDIO_DIR, f), { force: true });
  }
}

// playing length of a downloaded MP3, from its size (128 kbps CBR = 16,000 bytes a second)
function audioSeconds(id) {
  try { return stripTags(fs.readFileSync(audioPath(id))).length / (128000 / 8); } catch { return 0; }
}

// downloads the whole song (never a section of it), checks it's all there, retries once if not
async function download(id, expectedSeconds) {
  if (hasAudio(id)) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await run(['--ignore-config', '--no-cache-dir', '--no-playlist', '--no-warnings', '--no-progress',
        '--no-continue', '-f', 'bestaudio/best',
        '-x', '--audio-format', 'mp3', '--audio-quality', '128K', // the stream's format: 128 kbps CBR...
        '--postprocessor-args', 'ExtractAudio:-ar 44100 -ac 2',  // ...44.1 kHz stereo
        '-o', path.join(AUDIO_DIR, id + '.%(ext)s'), '--', id], 300000);
    } catch (e) { cleanupPartial(id); throw friendly(e); }
    cleanupPartial(id);
    if (!hasAudio(id)) throw new UserError('The download finished but no audio came out. Try a different upload.');
    if (!audioOk(id)) { fs.rmSync(audioPath(id), { force: true }); throw new UserError('That song came out in an odd format. Try a different upload.'); }
    const got = audioSeconds(id);
    if (!expectedSeconds || got >= expectedSeconds - 3) return;
    console.log(`Download of ${id} was short (${Math.round(got)}s of ${expectedSeconds}s), attempt ${attempt}`);
    fs.rmSync(audioPath(id), { force: true });
    if (attempt >= 2) throw new UserError('Only part of that song would download. Try again later or use a different upload.');
  }
}

// one download at a time, so a burst of adds doesn't swamp the box
let line = Promise.resolve();
function inLine(fn) {
  const p = line.then(fn, fn);
  line = p.catch(() => {});
  return p;
}

// ---------- adding and removing ----------
const pending = new Set();

async function addSong(id, dedication = '') {
  if (has(id)) throw new UserError('That song is already in the playlist.');
  if (wasRemoved(id)) throw new UserError('That song was removed from the jukebox, so it can’t be added back for now.');
  if (pending.has(id)) throw new UserError('That song is being added right now.');
  if (pending.size >= MAX_PENDING_ADDS) throw new UserError('Lots of songs are downloading right now. Try again in a minute.');
  if (Object.keys(state.songs).length >= MAX_SONGS) throw new UserError('The playlist is full. Remove a few songs first.');
  pending.add(id);
  try {
    const info = await lookup(id);
    await inLine(() => download(id, info.duration));
    if (has(id)) throw new UserError('That song is already in the playlist.');
    if (wasRemoved(id)) throw new UserError('That song was removed from the jukebox, so it can’t be added back for now.');
    state.songs[id] = { ...info, dedication: clean(dedication, 80), addedAt: Date.now(), fails: 0 };
    state.queue.push(id);
    console.log(`Added: ${info.title}`);
    if (!state.current) advance(); else { save(); broadcast(); }
    return state.songs[id];
  } finally { pending.delete(id); }
}

const wasRemoved = id => Object.prototype.hasOwnProperty.call(state.removed, id);

// gone for good: out of the playlist, file deleted, and blocked from being added again
function removeSong(id) {
  if (!has(id)) return;
  delete state.songs[id];
  state.removed[id] = Date.now();
  fs.rmSync(audioPath(id), { force: true });
  if (state.current && state.current.id === id) advance(); else { save(); broadcast(); }
}

// songs from the older YouTube-player version (or a wiped audio folder) download in the background
function backfill() {
  for (const id of Object.keys(state.songs)) {
    if (isId(id) && hasAudio(id) && !audioOk(id) && !(state.current && state.current.id === id)) fs.rmSync(audioPath(id), { force: true });
  }
  const missing = Object.keys(state.songs).filter(id => !hasAudio(id));
  if (!missing.length) return;
  console.log(`Downloading ${missing.length} song(s) that have no audio file yet…`);
  for (const id of missing) {
    if (!isId(id)) { delete state.songs[id]; continue; }
    inLine(async () => {
      if (!has(id)) return;
      if (!state.songs[id].duration) Object.assign(state.songs[id], await lookup(id));
      await download(id, state.songs[id].duration);
    }).then(
      () => { save(); if (!state.current) advance(); else broadcast(); },
      e => { console.log(`Dropping ${id}: ${e.message}`); delete state.songs[id]; save(); broadcast(); },
    );
  }
}

// ---------- anonymous rate limit (memory only, nothing stored) ----------
const SALT = crypto.randomBytes(16);
const hits = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    const f = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || '';
}
const ipKey = req => crypto.createHash('sha256').update(SALT).update(clientIp(req)).digest('hex');
// limits: add, skip, remove — counted per action, per (hashed) IP, over the last hour
function limited(req, action, max) {
  if (!max) return false;
  const key = action + ':' + ipKey(req);
  const list = (hits.get(key) || []).filter(t => Date.now() - t < 3600e3);
  hits.set(key, list);
  return list.length >= max;
}
function count(req, action) {
  const key = action + ':' + ipKey(req);
  hits.set(key, [...(hits.get(key) || []), Date.now()]);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- live updates (Server-Sent Events) ----------
const clients = new Map(); // clientId -> response

function publicState() {
  const c = state.current && state.songs[state.current.id];
  const pick = s => ({ id: s.id, title: s.title, author: s.author, duration: s.duration, dedication: s.dedication, addedAt: s.addedAt });
  return {
    now: Date.now(),
    current: c ? { ...pick(c), startedAt: state.current.startedAt } : null,
    upNext: [...state.queue, ...state.rotation].filter(playable).slice(0, UPCOMING).map(id => pick(state.songs[id])),
    queued: state.queue.filter(playable).length,
    total: Object.keys(state.songs).length,
    listeners: clients.size,
  };
}

// keep at least UPCOMING songs lined up, dealing out the next shuffled pass early, so Up Next is never empty
const UPCOMING = 8;
function ensureUpcoming() {
  const cur = state.current && state.current.id;
  const upcoming = [...state.queue, ...state.rotation].filter(playable);
  if (upcoming.length >= UPCOMING) return;
  const lined = new Set([...upcoming, cur]);
  state.rotation.push(...shuffle(Object.keys(state.songs).filter(id => playable(id) && !lined.has(id))));
}

function broadcast() {
  ensureUpcoming();
  const msg = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients.values()) res.write(msg);
}

const perIp = new Map();
function events(req, res) {
  const ip = ipKey(req);
  if (clients.size >= MAX_LISTENERS || (perIp.get(ip) || 0) >= MAX_LISTENERS_PER_IP) return json(res, 429, { error: 'Too many connections.' });
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const cid = crypto.randomBytes(9).toString('base64url');
  clients.set(cid, res);
  res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ clientId: cid })}\n\n`);
  broadcast();
  req.on('close', () => {
    clients.delete(cid);
    const n = (perIp.get(ip) || 1) - 1;
    if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
    broadcast();
  });
}
setInterval(() => { for (const res of clients.values()) res.write(': ping\n\n'); }, 25e3).unref();

// ---------- HTTP ----------
function readJson(req, limit = 4000) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > limit) { reject(new UserError('Too much data.')); req.destroy(); } });
    req.on('end', () => {
      try { const v = d ? JSON.parse(d) : {}; if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; resolve(v); }
      catch { reject(new UserError('Bad request.')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// the station: one endless MP3 stream that everyone shares
const streamPerIp = new Map();
function stream(req, res) {
  const ip = ipKey(req);
  if (listeners.size >= MAX_LISTENERS || (streamPerIp.get(ip) || 0) >= MAX_LISTENERS_PER_IP) return json(res, 429, { error: 'Too many connections.' });
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  if (req.method === 'HEAD') return res.end();
  streamPerIp.set(ip, (streamPerIp.get(ip) || 0) + 1);
  if (recent.length) res.write(recent.subarray(nextFrame(recent, 0))); // catch-up burst, starting on a whole frame
  listeners.add(res);
  res.on('error', () => {});
  req.on('close', () => {
    listeners.delete(res);
    const n = (streamPerIp.get(ip) || 1) - 1;
    if (n > 0) streamPerIp.set(ip, n); else streamPerIp.delete(ip);
  });
}

// only these files are ever served; nothing else on disk is reachable
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
function serveStatic(req, res, urlPath) {
  const entry = STATIC[urlPath];
  if (!entry) return json(res, 404, { error: 'Not found' });
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, buf) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

// sent with every response
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https://i.ytimg.com",
    "media-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

// changes only come from this site's own page, as JSON (blocks cross-site form posts and scripted CSRF)
function sameSiteJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}

// links that start partway through a video (or clips) are turned away with directions
function timestampProblem(text) {
  const t = String(text || '').trim();
  if (/youtube\.com\/clip\//i.test(t)) {
    return 'That’s a YouTube clip, which is only part of a video. Open the clip, click the video’s title to go to the full video, and paste that link instead.';
  }
  let u;
  try { u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); } catch { return null; }
  const stamped = ['t', 'start', 'time_continue'].some(k => u.searchParams.has(k)) || /(^|[#&])t=/.test(u.hash.slice(1));
  if (!stamped) return null;
  const v = u.searchParams.get('t') || u.searchParams.get('start') || u.searchParams.get('time_continue') || (u.hash.match(/t=([^&]+)/) || [])[1] || '';
  return `That link starts partway into the video${v ? ` (at ${String(v).slice(0, 12)})` : ''}. ` +
    'The jukebox always plays songs from the beginning, so it needs the plain link. On YouTube, click Share and untick “Start at”, ' +
    'or delete the “t=…” part from the end of the link, then paste it again.';
}

function parseId(text) {
  const t = String(text || '').trim().slice(0, 300);
  const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(t);
  if (m) return m[1];
  return isId(t) ? t : null;
}

const tooMany = what => new UserError(`That’s a lot of ${what} from your connection. Try again in a bit.`);

async function route(req, res) {
  let p;
  try { p = new URL(req.url, 'http://x').pathname; } catch { return json(res, 400, { error: 'Bad request.' }); }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (p === '/api/events') return events(req, res);
    if (p === '/api/state') return json(res, 200, publicState());
    if (p === '/stream') return stream(req, res);
    return serveStatic(req, res, p);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Not allowed.' });
  if (!sameSiteJson(req)) return json(res, 403, { error: 'Not allowed.' });
  const body = await readJson(req);
  const listener = typeof body.clientId === 'string' && clients.has(body.clientId);

  if (p === '/api/add') {
    const problem = timestampProblem(body.link);
    if (problem) throw new UserWarning(problem);
    const id = parseId(body.link);
    if (!id) throw new UserError('That doesn’t look like a YouTube link.');
    if (limited(req, 'add', RATE_LIMIT)) throw new UserError(`You’ve hit the limit of ${RATE_LIMIT} songs per hour. Try again later.`);
    const s = await addSong(id, body.dedication);
    count(req, 'add');
    return json(res, 200, { ok: true, title: s.title, position: state.queue.indexOf(s.id) + 1 });
  }

  // anyone listening can shuffle what's coming up (new requests included) into a random order, for everyone
  if (p === '/api/shuffle') {
    if (!listener) throw new UserError('Reload the page and try again.');
    if (limited(req, 'shuffle', SHUFFLE_LIMIT)) throw tooMany('shuffles');
    count(req, 'shuffle');
    const cur = state.current && state.current.id;
    let pool = [...new Set([...state.queue, ...state.rotation])].filter(id => has(id) && id !== cur);
    if (!pool.length) pool = Object.keys(state.songs).filter(id => has(id) && id !== cur);
    state.queue = [];
    state.rotation = shuffle(pool);
    console.log('Up next shuffled by a listener');
    save();
    broadcast();
    return json(res, 200, { ok: true });
  }

  // anyone listening can skip the song that's playing, or one coming up (it stays in the playlist)
  if (p === '/api/skip') {
    if (!listener) throw new UserError('Reload the page and try again.');
    if (limited(req, 'skip', SKIP_LIMIT)) throw tooMany('skips');
    if (state.current && state.current.id === body.id) { count(req, 'skip'); advance(); } // ignore double-clicks
    else if (has(body.id) && (state.queue.includes(body.id) || state.rotation.includes(body.id))) {
      // skipping an upcoming song: it's dropped from this pass and comes around again later
      count(req, 'skip');
      state.queue = state.queue.filter(id => id !== body.id);
      state.rotation = state.rotation.filter(id => id !== body.id);
      save();
      broadcast();
    }
    return json(res, 200, { ok: true });
  }

  // anyone listening can remove a song; removing the one playing skips to the next
  if (p === '/api/remove') {
    if (!listener) throw new UserError('Reload the page and try again.');
    if (limited(req, 'remove', REMOVE_LIMIT)) throw tooMany('removals');
    if (has(body.id)) {
      console.log(`Removed by a listener: ${state.songs[body.id].title}`);
      count(req, 'remove');
      removeSong(body.id);
    }
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  route(req, res).catch(e => {
    if (res.headersSent) return res.end();
    if (e instanceof UserError) return json(res, 400, { error: e.message, warning: e instanceof UserWarning });
    console.error(e);
    json(res, 500, { error: 'Something went wrong.' });
  });
});
// slow or stalled clients get dropped (a song download only delays the *response*, not these)
server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.maxHeadersCount = 50;

load();
goOnAir();
if (!state.current) advance();
backfill();
server.listen(PORT, HOST, () => console.log(`Employee Jukebox on http://${HOST}:${PORT}`));

// Copyright (C) 2026 Employee Jukebox contributors
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const $ = id => document.getElementById(id);
$('art').addEventListener('error', () => { $('art').hidden = true; });
let tuned = false, state = null, view = null, offset = 0, clientId = null;
const serverNow = () => Date.now() + offset;
const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const count = new Intl.NumberFormat();
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
// "added just now", "added 5 minutes ago", "added yesterday", "added 3 days ago"
function added(ts) {
  if (!ts) return '';
  const sec = (Date.now() + offset - ts) / 1000;
  if (sec < 60) return 'added just now';
  const steps = [[60, 'minute', 60], [3600, 'hour', 24], [86400, 'day', 7], [604800, 'week', 5], [2629800, 'month', 12], [31557600, 'year', Infinity]];
  for (const [unit, name, limit] of steps) {
    const n = Math.floor(sec / unit);
    if (n < limit) return 'added ' + relative.format(-n, name);
  }
  return '';
}

// ---- audio: tune in to the station's live stream, like a radio ----
const audio = new Audio();
audio.preload = 'none';
let volume = 0.8, muted = false, gain = null;
function applyVolume() {
  const v = muted ? 0 : volume;
  if (gain) { audio.volume = 1; gain.gain.value = v; } else { audio.volume = volume; audio.muted = muted; }
}
applyVolume();

function tuneIn() {
  audio.src = '/stream?' + Date.now(); // always join the broadcast live
  audio.play().catch(() => {});
}

// how many seconds behind the live broadcast this listener hears (the browser's small buffer)
function lag() {
  if (!tuned || audio.paused || !audio.buffered.length) return 0;
  return Math.max(0, Math.min(10, audio.buffered.end(audio.buffered.length - 1) - audio.currentTime));
}

let stallTimer = null, pausedAt = 0;
audio.addEventListener('playing', () => { document.body.classList.add('playing'); clearTimeout(stallTimer); });
['pause', 'ended', 'emptied'].forEach(ev => audio.addEventListener(ev, () => document.body.classList.remove('playing')));
// paused from the keyboard or lock screen? resuming jumps back to live, like a radio
audio.addEventListener('pause', () => { pausedAt = Date.now(); });
audio.addEventListener('play', () => {
  if (pausedAt && Date.now() - pausedAt > 2000) { pausedAt = 0; tuneIn(); }
  pausedAt = 0;
});
// dropped connection or a long stall: reconnect
audio.addEventListener('error', () => { if (tuned) setTimeout(tuneIn, 2000); });
audio.addEventListener('ended', () => { if (tuned) setTimeout(tuneIn, 1000); });
['waiting', 'stalled'].forEach(ev => audio.addEventListener(ev, () => {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => { if (tuned && state && state.current) tuneIn(); }, 10000);
}));

$('tuneBtn').onclick = () => { tuned = true; $('tunein').remove(); startAnalyser(); tuneIn(); $('muteBtn').focus(); };
$('vol').oninput = e => { volume = +e.target.value / 100; muted = false; applyVolume(); setMuted(false); };
function setMuted(m) { $('muteBtn').textContent = m ? 'Unmute' : 'Mute'; $('muteBtn').setAttribute('aria-pressed', String(m)); }
$('muteBtn').onclick = () => { muted = !muted; applyVolume(); setMuted(muted); };

// ---- live state ----
// The page shows what *you* are hearing: when the station changes songs, the title waits the
// couple of seconds it takes the new song to reach your speakers.
let switchPending = false;
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', e => { clientId = JSON.parse(e.data).clientId; });
  es.onmessage = e => {
    state = JSON.parse(e.data);
    offset = state.now - Date.now();
    const id = s => s && s.current && s.current.id;
    if (view && id(view) !== id(state) && lag() > 0.3) {
      if (!switchPending) {
        switchPending = true;
        setTimeout(() => { switchPending = false; view = state; render(); }, lag() * 1000);
      }
      return;
    }
    if (!switchPending) { view = state; render(); }
  };
}
connect();

function render() {
  const c = view.current;
  $('liveText').textContent = c ? 'On air' : 'Off air';
  $('stats').textContent = `${count.format(view.listeners)} listening, ${count.format(view.total)} ${view.total === 1 ? 'song' : 'songs'}`;
  $('nowTitle').textContent = c ? c.title : 'Nothing playing yet';
  $('nowAuthor').textContent = c ? (c.author || 'Unknown') + (c.addedAt ? ', ' + added(c.addedAt) : '') : 'Add the first song to start the station.';
  $('ytLink').hidden = !c;
  const art = $('art');
  art.hidden = !c;
  if (c && art.dataset.id !== c.id) { art.dataset.id = c.id; art.hidden = false; art.src = 'https://i.ytimg.com/vi/' + c.id + '/hqdefault.jpg'; }
  if (c) $('ytLink').href = 'https://www.youtube.com/watch?v=' + c.id;

  $('nowDedication').textContent = c && c.dedication ? '“' + c.dedication + '”' : '';
  $('removeBtn').disabled = !c;
  $('skipBtn').disabled = !c;
  $('shuffleBtn').disabled = view.total < 3;
  document.title = c ? c.title + ' – Employee Jukebox' : 'Employee Jukebox';
  renderOrder();
  tick();
}

// running order with the clock time each song starts
function renderOrder() {
  const c = view.current;
  const ol = $('upNext');
  ol.textContent = '';
  let at = c && c.duration ? c.startedAt + c.duration * 1000 - offset + lag() * 1000 : null;
  view.upNext.forEach((s, i) => {
    const li = document.createElement('li');
    const time = document.createElement('span'); time.className = 'at';
    time.textContent = at ? clock.format(at) : '–';
    const body = document.createElement('div');
    const t = document.createElement('div'); t.className = 't'; t.textContent = s.title;
    if (i < view.queued) { const n = document.createElement('span'); n.className = 'new'; n.textContent = 'New'; t.appendChild(n); }
    const by = document.createElement('div'); by.className = 'by'; by.textContent = (s.author || 'Unknown') + (s.addedAt ? ', ' + added(s.addedAt) : '');
    body.append(t, by);
    if (s.dedication) { const d = document.createElement('div'); d.className = 'ded'; d.textContent = '“' + s.dedication + '”'; body.appendChild(d); }
    const len = document.createElement('span'); len.className = 'len'; len.textContent = s.duration ? fmt(s.duration) : '';
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm'; rm.textContent = '× Remove';
    rm.setAttribute('aria-label', 'Remove ' + s.title);
    rm.onclick = () => removeSong(s.id, s.title);
    const sk = document.createElement('button');
    sk.type = 'button'; sk.className = 'rm'; sk.textContent = 'Skip';
    sk.setAttribute('aria-label', 'Skip ' + s.title);
    sk.onclick = async () => {
      sk.disabled = true;
      try { await post('/api/skip', { clientId, id: s.id }); } catch (err) { alert(err.message); sk.disabled = false; }
    };
    const btns = document.createElement('div'); btns.className = 'btns';
    btns.append(sk, rm);
    const end = document.createElement('div'); end.className = 'end';
    end.append(len, btns);
    li.append(time, body, end);
    ol.appendChild(li);
    at = at && s.duration ? at + s.duration * 1000 : null;
  });
  $('loopNote').textContent = view.upNext.length ? '' :
    view.total ? 'That’s every song for now. Add more above.' : 'Nothing in line yet. Paste a YouTube link above to start.';
}

function tick() {
  const c = view && view.current;
  if (!c) { $('progress').style.width = '0'; $('elapsed').textContent = ''; $('remaining').textContent = ''; return; }
  const pos = Math.min(c.duration || Infinity, (serverNow() - c.startedAt) / 1000 - lag());
  $('elapsed').textContent = fmt(pos);
  if (c.duration) {
    $('progress').style.width = Math.min(100, pos / c.duration * 100) + '%';
    $('remaining').textContent = '−' + fmt(c.duration - pos);
  } else { $('remaining').textContent = ''; }
}
setInterval(tick, 1000);

// ---- actions ----
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'The jukebox didn’t respond. Check your connection and try again.'), { warning: !!j.warning });
  return j;
}

async function removeSong(id, title) {
  if (!confirm(`Remove “${title}” for good?\n\nIt’s deleted for everyone and can’t be added back until the jukebox is next updated.`)) return;
  try { await post('/api/remove', { clientId, id }); }
  catch (err) { alert(err.message); }
}
$('removeBtn').onclick = () => { const c = view && view.current; if (c) removeSong(c.id, c.title); };
$('shuffleBtn').onclick = async () => {
  $('shuffleBtn').disabled = true;
  try { await post('/api/shuffle', { clientId }); } catch (err) { alert(err.message); }
  finally { $('shuffleBtn').disabled = false; }
};
setInterval(() => { if (view) render(); }, 60000); // keep "added … ago" current

$('skipBtn').onclick = async () => {
  const c = view && view.current;
  if (!c) return;
  $('skipBtn').disabled = true;
  try { await post('/api/skip', { clientId, id: c.id }); } catch (err) { alert(err.message); $('skipBtn').disabled = false; }
};

// ---- the waveform shows what you're hearing ----
// Silence (nothing on, not tuned in, muted) = a straight line. Louder = closer to the full logo shape.
// The centre bar follows the bass and the outer bars the higher frequencies, mirrored like the logo.
const bars = [...document.querySelectorAll('.wave rect')];
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const CENTRE = 256;                   // shared middle line, so the bars sit perfectly straight when flat
const FLAT = 12;                      // bar height (logo units) in silence
const logo = bars.map(b => {
  const y = +b.getAttribute('y'), h = +b.getAttribute('height');
  return { h, mid: y + h / 2 };
});
// which frequency band drives each bar (0 = bass … 3 = treble), mirrored around the centre
const BAND = [2, 3, 1, 0, 1, 3, 2];
// band edges in Hz, and the loudness (dB) that counts as "silent" and "full" for each band
const BANDS = [
  { lo: 40, hi: 160, quiet: -70, loud: -28 },
  { lo: 160, hi: 600, quiet: -75, loud: -32 },
  { lo: 600, hi: 2500, quiet: -82, loud: -40 },
  { lo: 2500, hi: 9000, quiet: -92, loud: -52 },
];
const shown = bars.map(() => 0);      // what's on screen now (0 = flat, 1 = full logo)
let analyser = null, spectrum = null, wave = null, rate = 44100;

function startAnalyser() {
  if (analyser || calm.matches) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.45;
    gain = ctx.createGain();
    src.connect(gain);                // your volume and mute come first...
    gain.connect(analyser);           // ...so the waveform reacts to what you hear
    analyser.connect(ctx.destination);
    applyVolume();
    rate = ctx.sampleRate;
    spectrum = new Float32Array(analyser.frequencyBinCount);
    wave = new Float32Array(analyser.fftSize);
    audio.addEventListener('play', () => ctx.resume());
  } catch { analyser = null; }
}

const clamp01 = v => Math.max(0, Math.min(1, v));

function setBar(i, p) {
  const h = FLAT + (logo[i].h - FLAT) * p;
  const mid = CENTRE + (logo[i].mid - CENTRE) * p;   // straight line when flat, true logo when full
  bars[i].setAttribute('height', h.toFixed(1));
  bars[i].setAttribute('y', (mid - h / 2).toFixed(1));
}

// Two layers:
//   size     — overall loudness, followed slowly: volume, quiet passages and silence shrink the whole logo
//   movement — how far each band is above or below its own level over the last ~half second,
//              so hits (kick, snare, vocals) make the bars jump even on loud, flat-mastered songs
const bandAvg = BANDS.map(() => null);
let size = 0;

function levels() {
  if (!analyser || !document.body.classList.contains('playing')) return null;
  analyser.getFloatTimeDomainData(wave);
  let sum = 0;
  for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
  const db = 20 * Math.log10(Math.sqrt(sum / wave.length) + 1e-9);
  const loud = db < -60 ? 0 : clamp01((db + 44) / 26);   // -44 dB = flat, -18 dB = full size
  size += (loud - size) * (loud > size ? 0.12 : 0.04);

  analyser.getFloatFrequencyData(spectrum);
  const hz = rate / analyser.fftSize;
  return BANDS.map((b, k) => {
    let p = 0, n = 0;
    for (let i = Math.max(1, Math.floor(b.lo / hz)); i <= Math.min(spectrum.length - 1, Math.ceil(b.hi / hz)); i++) {
      p += Math.pow(10, spectrum[i] / 10); n++;
    }
    const bandDb = 10 * Math.log10(p / Math.max(1, n) + 1e-12);
    if (bandAvg[k] === null) bandAvg[k] = bandDb;
    bandAvg[k] += (bandDb - bandAvg[k]) * 0.04;            // this band's recent level
    const jump = clamp01((bandDb - bandAvg[k] + 3) / 7);    // 3 dB below usual = low, 4 dB above = peak
    return size * (0.15 + 0.85 * jump);
  });
}

function draw() {
  requestAnimationFrame(draw);
  if (document.hidden) return;
  const lv = levels();
  bars.forEach((b, i) => {
    const target = lv ? lv[BAND[i]] : 0;
    shown[i] += (target - shown[i]) * (target > shown[i] ? 0.55 : 0.18); // snap up, fall back quickly
    setBar(i, shown[i]);
  });
}
// reduced motion: the logo just stays as it is; otherwise start flat and follow the music
if (!calm.matches) requestAnimationFrame(draw);
$('add').onsubmit = async e => {
  e.preventDefault();
  const msg = $('msg'), link = $('link');
  if (!link.value.trim()) { msg.className = 'err'; msg.textContent = 'Paste a YouTube link first.'; link.focus(); return; }
  $('addBtn').disabled = true;
  msg.className = ''; msg.textContent = 'Downloading… this can take 10–30 seconds.';
  try {
    const r = await post('/api/add', { link: link.value, dedication: $('dedication').value });
    msg.className = 'ok';
    msg.textContent = r.position > 0 ? `Added. It’s #${r.position} in line.` : 'Added. It’s playing now.';
    link.value = ''; $('dedication').value = '';
  } catch (err) {
    msg.className = err.warning ? 'warn' : 'err'; msg.textContent = err.message;
    link.focus();
    link.select();
  } finally { $('addBtn').disabled = false; }
};

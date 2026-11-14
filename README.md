# Employee Jukebox

One shared, anonymous, always-on playlist. Anyone with the link pastes a YouTube URL; the server downloads the audio and broadcasts one live stream that everybody tunes into, like a radio station. New songs play first; when they run out, the whole library shuffles and plays again, 24/7.

- No accounts, no names, no admin page. Anyone can add or remove songs.
- Nothing about who added or removed a song is saved (the rate limiter keeps only a salted hash, in memory).
- Everything lives in `data/`: `jukebox.json` (the playlist) and `audio/` (the MP3s). Back up that folder and you've backed up the station.

**Keep it private.** The server stores and re-serves copies of songs pulled from YouTube, which YouTube's terms don't allow. Keep it on your network or behind a sign-in (see below), not on an open public link.

## Requirements

- Node.js 18 or newer
- `yt-dlp` (downloads from YouTube)
- `ffmpeg` (converts to MP3)

## Try it on a Mac

```bash
brew install node yt-dlp ffmpeg
cd jukebox
node server.js
```

Open http://localhost:8080 and click **Start Listening**.

## Install on the NUC / VM (Debian or Ubuntu)

```bash
# 1. Node.js, ffmpeg, yt-dlp
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# 2. Copy the app and create a service user
sudo mkdir -p /opt/jukebox/data
sudo cp -r server.js package.json public /opt/jukebox/
sudo cp jukebox.env.example /opt/jukebox/jukebox.env
sudo useradd --system --home /opt/jukebox jukebox
sudo chown -R jukebox:jukebox /opt/jukebox

# 3. Run it as a service (starts on boot, restarts if it crashes)
sudo cp jukebox.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jukebox
sudo journalctl -u jukebox -f              # watch the log
```

On your network it's at `http://<nuc-ip>:8080`.

### Keep yt-dlp current

YouTube changes often and old yt-dlp versions stop working. Update it weekly:

```bash
echo '0 4 * * 1 root /usr/local/bin/yt-dlp -U' | sudo tee /etc/cron.d/yt-dlp-update
```

If adding songs suddenly fails for everything, run `sudo yt-dlp -U` first.

### Putting it on the internet

What's built in:
- Strict security headers and a content-security policy, so injected script can't run even if something slipped through. All song titles and messages are shown as plain text.
- Only the page's own JSON requests can change anything (cross-site forms and other sites' scripts are rejected).
- Only the page, its script and the live stream are served — no other file on the box is reachable, and individual songs can't be downloaded.
- yt-dlp only ever gets a validated 11-character video ID, never a URL or option from a visitor, and never through a shell.
- Per-IP hourly limits on adding, skipping and removing; caps on connections, downloads in progress, song length and library size; slow or stalled requests are dropped.
- The systemd service is sandboxed: it runs as its own user and can only write to `/opt/jukebox/data`.

What you should still do:
1. **Put a sign-in in front of it.** Anyone who can open the page can remove songs, so don't leave it on an open link. Use **Cloudflare Tunnel + Cloudflare Access**: install `cloudflared` on the NUC, point a hostname at `http://localhost:8080`, and add an Access policy that only allows your coworkers' email domain. No open ports, HTTPS included, and the jukebox still never learns who did what.
2. In `jukebox.env`, set `HOST=127.0.0.1` (only the tunnel can reach it) and `TRUST_PROXY=1` (so limits see real IPs). Leave `TRUST_PROXY=0` if nothing sits in front of it, or people could fake their IP.
3. Keep the OS, Node and yt-dlp updated.

## Using it

- **Add a song:** paste any YouTube link. The server downloads the whole song (usually 10–30 seconds), checks nothing is missing, then it joins the line. Links with a timestamp (`?t=95`) and YouTube clips are turned away with a note on how to get the plain link.
- **Skip:** anyone can skip the song that's playing, or any song in Up Next. Skipped songs stay in the playlist and come around again later.
- **Up Next** always shows the next 8 songs: new requests first, then the shuffled playlist.
- **Remove:** anyone can remove the song that's playing or anything in Up Next. It's deleted for everyone and can't be added back — until the next deployment (when the app's files change), which clears the removed list. A plain restart or reboot keeps it.
- **Shuffle:** anyone can shuffle everything coming up into a random order, for everyone.
- **Added time:** each song shows when it was added ("added 2 hours ago").
- **Message:** optional short note shown while the song plays.

Storage: roughly 3–5 MB per song, so 1,000 songs is about 4 GB.

## Settings (`jukebox.env`)

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | 8080 | Port to listen on |
| `HOST` | 0.0.0.0 | `127.0.0.1` when a tunnel/proxy on the same box fronts it |
| `RATE_LIMIT` | 30 | Songs one IP can add per hour; 0 = unlimited |
| `SKIP_LIMIT` | 60 | Skips per IP per hour |
| `SHUFFLE_LIMIT` | 20 | Shuffles per IP per hour |
| `REMOVE_LIMIT` | 20 | Removals per IP per hour |
| `MAX_MINUTES` | 20 | Longest song allowed; 0 = no limit |
| `MAX_SONGS` | 3000 | Most songs kept (about 3.5 MB each) |
| `TRUST_PROXY` | 0 | Set to 1 only behind Cloudflare Tunnel / Caddy / nginx |
| `YTDLP` | yt-dlp | Path to yt-dlp if it isn't on the PATH |
| `DATA_DIR` | ./data | Where the playlist and MP3s are kept |

After changing settings: `sudo systemctl restart jukebox`.

## How it works

It's a radio station. The server plays the current song out as one continuous 128 kbps MP3 stream at exactly real-time speed, and flows straight into the next song when it ends. Every listener connects to `/stream` and receives the same bytes, so everyone hears the same thing (give or take the second or two a browser buffers). Tuning in joins the broadcast live. Pausing and resuming jumps back to live, like a radio.

Skip and Remove change what's on air for everyone. Remove is permanent: the song is deleted and can't be added again.

All songs are stored as 128 kbps / 44.1 kHz MP3 so they join into one seamless stream. Songs from older versions of the jukebox are re-downloaded in that format automatically the first time the server starts.

Browsers won't autoplay sound, so each listener clicks **Start Listening** once.

## License

GPL-3.0-or-later. You can use, change and share it, but if you distribute a modified version you have to share its source under the same license. See [LICENSE](LICENSE).

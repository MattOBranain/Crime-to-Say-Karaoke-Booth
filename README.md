# Crime to Say Karaoke Booth

A single-page virtual karaoke booth. Open it, allow camera & mic, hit
**START**, sing along to the synced lyrics and bouncing ball, and save the
finished `.mp4` straight to your phone.

## Files

- `index.html` / `styles.css` / `app.js` — the whole app (no build step, no framework).
- `Crime2Say-Oke-Short-wIntro.mp3` — backing track, with a 1-bar (4-beat,
  80bpm) intro baked into the start of the file.
- `crime-2-say-oke-shortest.lrc` — enhanced (word-level) LRC lyric timing,
  relative to where the file's intro ends and the song content starts.
- `favicon.ico`

## How it works

- Camera + mic permission is requested on load; the live preview is drawn
  (mirrored, cropped to fill like `object-fit: cover`) onto a `<canvas>`
  each frame, with the lyric line, bouncing ball, and title/end cards
  composited on top live.
- Pressing **START** begins recording immediately (so the encoder is warmed
  up before anything sync-critical happens) and starts the backing track
  playing essentially straight away. The track's own baked-in 1-bar intro
  doubles as the count-in — a 3/2/1/GO countdown is shown on screen in time
  with it, ending exactly when the song's real content begins.
- The mic and backing track are mixed via the Web Audio API with several
  sync/quality corrections applied to the *recorded* copy only (never to
  what the singer hears live): a small delay so the music lines up with the
  mic's own capture latency, a further delay so the whole mix lines up with
  the camera's capture latency, gain + compression + makeup-gain on the mic
  so quiet devices are still audible, and light auto-ducking (music dips
  while singing). All mixed together and recorded with the canvas video via
  `MediaRecorder`.
- Every recording is remuxed through `ffmpeg.wasm` before saving — even
  "native" mp4 output — since MediaRecorder output commonly lacks a
  properly finalized duration/moov atom that strict native players (e.g.
  iOS Photos) can refuse even though in-browser playback tolerates it fine.
  mp4 sources get a fast lossless stream-copy remux; webm sources get a
  full re-encode.
- Saving uses the Web Share API where available (native "Save Video" sheet),
  falling back to a direct download.

External dependency loaded from CDN at runtime (no install needed):
`@ffmpeg/ffmpeg` for the remux/conversion step above. An internet
connection is required for its first load.

## Deployment (GitHub Pages)

1. In the repo settings, set GitHub Pages source to the `main` branch (root).
2. The site is fully static — `index.html` at the repo root is the entire app.
3. Keep `Crime2Say-Oke-Short-wIntro.mp3`, `crime-2-say-oke-shortest.lrc`,
   and `favicon.ico` at the repo root (the app fetches them by relative path).
4. Commit & push; Pages publishes automatically (may take a minute).
5. Custom domain: `crime2say.uk` via a `CNAME` file, pointed at GitHub Pages
   with four `A` records (185.199.108/109/110/111.153) and `Enforce HTTPS`
   enabled in Pages settings.

## Notes

- Deliberately no login, song picker, or settings page — one screen, one song.
- The `savannah` git tag marks a known-good checkpoint prior to the red
  color-accent pass, animated title cards, and the intro-music file switch.

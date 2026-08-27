# Crime to Say Karaoke Booth

A single-page virtual karaoke booth. Open it, allow camera & mic, hit
**START**, sing along to the synced lyrics and bouncing ball, and save the
finished `.mp4` straight to your phone.

## Files

- `index.html` / `styles.css` / `app.js` — the whole app (no build step, no framework).
- `crime-2-say-oke-shortest.mp3` — backing track.
- `crime-2-say-oke-shortest.lrc` — enhanced (word-level) LRC lyric timing.
- `favicon.ico`

## How it works

- Camera + mic permission is requested on load; the live preview is drawn
  (mirrored) onto a `<canvas>` each frame, with the lyric line, bouncing
  ball, and optional UK-flag mouth-gag effect (via on-device face tracking)
  composited on top live.
- Pressing **START** runs a 4-beat, 80bpm count-in (synthesized tones, not
  recorded). Camera/mic recording begins on the 4th beat; the backing track
  starts sample-accurately on the following downbeat.
- The mic and backing track are mixed with light auto-ducking (music dips
  slightly while you're singing) via the Web Audio API, and recorded
  together with the canvas video through `MediaRecorder`.
- On Safari/iOS, `MediaRecorder` already outputs `.mp4` natively. On
  browsers that only support WebM (e.g. Android Chrome), the clip is
  transcoded to `.mp4` in-browser with `ffmpeg.wasm` before saving.
- Saving uses the Web Share API where available (native "Save Video" sheet),
  falling back to a direct download.

External dependencies are loaded from CDN at runtime (no install needed):
`@mediapipe/tasks-vision` (face tracking) and `@ffmpeg/ffmpeg` (MP4
conversion fallback). An internet connection is required for the first load
of each.

## Deployment (GitHub Pages)

1. In the repo settings, set GitHub Pages source to the `main` branch (root).
2. The site is fully static — `index.html` at the repo root is the entire app.
3. Keep `crime-2-say-oke-shortest.mp3`, `crime-2-say-oke-shortest.lrc`, and
   `favicon.ico` at the repo root (the app fetches them by relative path).
4. Commit & push; Pages publishes automatically (may take a minute).

## Notes

- Deliberately no login, song picker, or settings page — one screen, one song.

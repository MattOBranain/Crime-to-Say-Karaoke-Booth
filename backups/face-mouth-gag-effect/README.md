# UK flag mouth-gag AR effect (shelved)

Removed from the live app on 2026-08-27. It never reliably appeared for the
user in testing, and — more importantly — its dependency (`@mediapipe/tasks-vision`)
was imported as a **top-level static `import`** in `app.js`. On at least one
older device (iPhone 7 / Firefox) that import likely failed to load or parse,
which silently killed the *entire* module — meaning no camera init, no
lyrics, no music, nothing. That's the most probable explanation for "iPhone 7
didn't get that far" and "didn't hear the music at all" from the first round
of testing. The per-frame face-landmark detection was also almost certainly
the single heaviest thing running in the render loop, a likely contributor to
the mic audio drop-outs and A/V sync drift reported on iPad 5th gen.

`face-gag-snapshot.js` below is the extracted logic (face landmark loading,
smoothing, Union Jack sprite, drawing) as it stood when removed, kept for
reference in case this is worth revisiting later — e.g. behind a
dynamically-`import()`-ed, opt-in toggle (never a top-level import) with a
lighter-weight detector, and only after core recording/sync is rock solid.

## If reviving this

- Never use a top-level `import` for it — use a dynamic `import()` inside a
  try/catch, gated behind explicit user opt-in, so a failure to load can
  never take down the rest of the app.
- Throttle detection more aggressively (e.g. every 3rd–4th frame, or a fixed
  low-Hz interval) and test on genuinely old/low-end hardware before shipping.
- Re-verify it actually renders — in the last test it never appeared at all,
  which was never root-caused.

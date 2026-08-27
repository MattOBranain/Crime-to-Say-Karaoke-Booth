# Crime to Say Karaoke Challenge

This repository has been rebuilt in-place. The original site files were moved into the backups/ folder.

Deployment (GitHub Pages)

1. Ensure the repo's GitHub Pages source is set to the `main` branch (root) in repository settings.
2. The site is fully static; the root index.html serves the single-page app. If you prefer `/docs` folder, move the site files into `/docs` and set Pages source to `main` branch / `/docs` folder.
3. The app expects the following files at the repo root:
   - crime-2-say-oke-shortest.mp3
   - crime-2-say-oke-shortest.lrc
   - favicon.ico
4. Commit & push; Pages will publish automatically (may take a minute).

Accessibility & notes

- Large touch targets, ARIA attributes, and clear contrast have been applied.
- The app is client-side only and uses the Web Audio API + MediaRecorder.

If you want, I can now:
- Move any additional files into the backup folder.
- Create a separate branch instead of committing to main.
- Further refine the MP4 muxing (WebCodecs approach) for better performance.

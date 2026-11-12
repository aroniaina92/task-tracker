# Task Tracker

Installable phone app (PWA) for my project and task tracker.
Data stays in the Google Sheet; the Sheet → Google Tasks → Reclaim sync is unchanged.

- `index.html`, `styles.css`, `app.js`: the app
- `config.js`: the Apps Script `/exec` URL (empty = demo mode)
- `sw.js`, `manifest.webmanifest`, `icons/`: make it installable
- `apps-script/Api.gs`: copy of the backend (lives in the sheet's Apps Script project)

After each change: bump `VERSION` in `sw.js`, commit, push. Phones update on the next open.

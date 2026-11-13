# Task Tracker

Installable phone app (PWA) for my project and task tracker.
Data stays in the Google Sheet; the Sheet → Google Tasks → Reclaim sync is unchanged.

- `index.html`, `styles.css`, `app.js`: the app
- `config.js`: the Apps Script `/exec` URL (empty = demo mode)
- `sw.js`, `manifest.webmanifest`, `icons/`: make it installable
- `book.html`, `book.js`: public page where people request a meeting
- `lib/fullcalendar.min.js`: calendar library (FullCalendar 6.1.15, MIT licence)
- `apps-script/Api.gs`, `Scheduler.gs`, `Booking.gs`: copies of the backend (they live in the sheet's Apps Script project)

After each change: bump `VERSION` in `sw.js`, commit, push. Phones update on the next open.

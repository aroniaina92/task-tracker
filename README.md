# My Steps

Installable phone app (PWA) for projects, tasks and ideas, with automatic scheduling into Google Calendar and a public booking page.
Data and server logic run on Supabase; the app is hosted on GitHub Pages.

- `index.html`, `styles.css`, `app.js`: the app
- `supa.js`: connection to Supabase (login, data, server functions)
- `config.js`: Supabase URL + publishable key (empty = demo mode). Never put secret keys here.
- `book.html`, `book.js`: public page where people request a meeting
- `sw.js`, `manifest.webmanifest`, `icons/`, `bg/`: make it installable
- `lib/`: supabase-js 2.119.0 (MIT licence)
- `supabase/schema.sql`: database tables and privacy rules
- `supabase/functions/owner`, `supabase/functions/booking`: server functions (scheduler, calendar, booking)
- `supabase/cron.sql`: hourly and nightly re-planning
- `apps-script/Migrate.gs`: one-time import from the Google Sheet + nightly backup into it
- `apps-script/Api.gs`, `Scheduler.gs`, `Booking.gs`: the old Apps Script backend (kept for reference)

Setup: see `SETUP-SUPABASE.md`.
After each change: bump `VERSION` in `sw.js`, commit, push. Phones update on the next open.

# Moving My Steps to Supabase – setup steps

About 45–60 minutes, once. Do the steps in this order.
Placeholders: `REF` = your Supabase project ref (the part before `.supabase.co`), `APP` = `https://aroniaina92.github.io/task-tracker/`.

What lives where after the move:

| Part | Where |
|---|---|
| Tasks, goals, ideas, meeting requests | Supabase database (`supabase/schema.sql`) |
| Scheduler, calendar, accept/decline | Edge Function `owner` |
| Public booking page data | Edge Function `booking` |
| Hourly re-plan + nightly full re-plan | Supabase Cron (`supabase/cron.sql`) |
| App | GitHub Pages (unchanged) |
| Google Sheet | One-time import + optional nightly backup |

Keep these **secret** (never in GitHub, never in `config.js`): the database password, the `secret`/`service_role` key, the Google client secret, `CRON_SECRET`.

---

## 1. Create the Supabase project
1. supabase.com → sign in with GitHub or Google → **New project** (Free plan).
2. Name `my-steps`; choose a strong database password (save it in your password manager); region: the closest one offered (e.g. Mumbai or Frankfurt).
3. When it is ready: **Project Settings → API Keys**. Note:
   - the **Project URL** (`https://REF.supabase.co`)
   - the **publishable** key (`sb_publishable_…`) – or, if only legacy keys are shown, the **anon** key.

## 2. Create the database
**SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. It should say "Success. No rows returned".

## 3. Google Cloud (calendar + email permission)
In console.cloud.google.com (you can reuse an existing project or create `My Steps`):
1. **APIs & Services → Library**: enable **Google Calendar API** and **Gmail API**.
2. **Google Auth Platform → Branding / Audience** (older menu: *OAuth consent screen*): User type **External**, app name `My Steps`, your email as support and developer contact.
3. **Data access** (or *Scopes*): add `.../auth/calendar` and `.../auth/gmail.send`.
4. **Audience**: click **Publish app** (status *In production*).
   Important: in *Testing* mode Google cancels the access after 7 days and scheduling stops. You will see a "Google hasn't verified this app" screen when you connect – that is normal for a personal app: **Advanced → Go to My Steps**.
5. **Clients → Create client** → *Web application*:
   - Authorized JavaScript origins: `https://aroniaina92.github.io`
   - Authorized redirect URIs: the callback URL shown in Supabase → **Authentication → Sign In / Providers → Google** (it looks like `https://REF.supabase.co/auth/v1/callback`).
   - Save the **Client ID** and **Client secret**.

## 4. Supabase sign-in settings
1. **Authentication → Sign In / Providers → Google**: enable, paste Client ID and Client secret, save.
2. **Authentication → URL Configuration**: Site URL = `APP`; Redirect URLs: add `APP` and `APP` + `index.html`.

## 5. Connect the app to Supabase
1. Unzip the update into your `task-tracker-pwa` folder. This time `config.js` **is** replaced: the Apps Script URL is no longer used.
2. Open `config.js` and fill in:
   ```js
   SUPABASE_URL: 'https://REF.supabase.co',
   SUPABASE_ANON_KEY: 'sb_publishable_...'   // publishable/anon key ONLY
   ```
3. Commit and push (RStudio Git panel, or `git add -A && git commit -m "Move to Supabase" && git push`).

## 6. Your account (owner) and the second person
1. Open the app (close and reopen it on the phone so it updates) → **Continue with Google** with your own Google account.
2. Supabase → **SQL Editor**, run (with your email):
   ```sql
   update public.profiles set role = 'admin' where email = 'YOUR_EMAIL@gmail.com';
   ```
3. **Authentication → Users**: copy your **User UID** (needed in step 8).
4. Second person: **Authentication → Users → Add user → Create new user**, their email + a temporary password, tick **Auto Confirm User**. They log in with email + password and can change it in Me → Change password (or use "Forgot password?").
5. **Authentication → Sign In / Providers**: turn off **Allow new users to sign up**, so nobody else can create an account.

## 7. Import the Google Sheet (one time)
1. Open the sheet → **Extensions → Apps Script**. Add a file `Migrate.gs` with the content of `apps-script/Migrate.gs`.
2. **Project Settings (gear) → Script properties**: add
   - `SUPABASE_URL` = `https://REF.supabase.co`
   - `SUPABASE_SERVICE_KEY` = the **secret** key (`sb_secret_…`, Project Settings → API Keys) or the legacy `service_role` key.
3. Ask the second person to log in once first (their tasks are skipped until their account exists).
4. Select `mgExportToSupabase` → **Run** → allow access. The log shows how many rows were copied. Safe to run again.
5. Select `mgStopOldScheduler` → **Run** (removes the old Apps Script timers so two schedulers don't fight).
6. Optional: `mgSetupDailyBackup` → **Run**: every night Supabase data is copied into "Backup …" tabs.

The import also copies your time categories, goal → time category choices, booking options and the existing "My Steps" calendar, so blocks already planned are kept.

## 8. Server functions
1. **Edge Functions → Secrets** → add:
   | Name | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | from step 3 |
   | `GOOGLE_CLIENT_SECRET` | from step 3 |
   | `CRON_SECRET` | a long random text (e.g. 40 letters/numbers you make up) |
   | `OWNER_ID` | your User UID from step 6 |
2. **Edge Functions → Deploy a new function → Via Editor**:
   - Name `owner`, replace the sample code with all of `supabase/functions/owner/index.ts` → **Deploy**.
   - Again for `booking` with `supabase/functions/booking/index.ts`.
3. For **each** function: open it → **Details/Settings** → turn **off** "Verify JWT" (wording may be "Enforce JWT verification") → save.
   Why: the booking page and the hourly timer don't send a login. The functions check access themselves (owner login, or `CRON_SECRET`).
   If you can't find the switch, deploy from your computer instead (in the project folder):
   ```bash
   npx supabase login
   npx supabase functions deploy owner   --no-verify-jwt --project-ref REF
   npx supabase functions deploy booking --no-verify-jwt --project-ref REF
   ```
   (this needs the files at `supabase/functions/<name>/index.ts`, which they are.)

## 9. Connect Google Calendar
In the app: **Me → Google Calendar → connect** (or the button on the Calendar page). Choose your Google account, tick **all** boxes (Calendar and "Send email on your behalf"). Back in the app you should see "Google Calendar connected · planning your tasks", and the Calendar page shows your week.

## 10. Automatic re-planning
1. **Integrations → Cron** (or **Database → Extensions**): enable **pg_cron** and **pg_net**.
2. Open `supabase/cron.sql`, replace `YOUR-PROJECT-REF` and `YOUR-CRON-SECRET` (same value as the secret), paste in **SQL Editor** → **Run**.
   It re-plans every hour at :07 and does a full re-plan at 02:15 Madagascar time.

## 11. Check
- Tick a scheduled task done → its future blocks disappear, the next task moves up (a few seconds).
- Open `APP` + `book.html` in a private window → free times appear; send a test request → you get an email; accept it in Calendar → Meet invite is sent.
- Supabase → **Edge Functions → owner → Logs** shows errors if something fails.

## Good to know
- **Free plan pauses** a project after about a week without activity. Normal daily use keeps it awake; if it pauses, open the Supabase dashboard and click *Restore* (data is kept).
- **"Google refused access"** in the app: Me → Google Calendar → reconnect. If it happens every week, the consent screen is still in *Testing* (step 3.4).
- **Edit data by hand**: Supabase → **Table Editor** (like a spreadsheet).
- Keep the old Apps Script deployment for a week as a fallback, then you can archive it. Keep the sheet (backup tabs).

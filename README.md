# Salah Sync

A timezone-aware Islamic prayer board with location search, calculation settings and a stable iCalendar feed that can be subscribed to in Google Calendar.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

The local Express server binds to `0.0.0.0` so it also works behind a hosted preview or a normal reverse proxy.

## Publish the complete app on Netlify

This project is already prepared for Netlify:

- `public/` is the static frontend.
- `netlify/functions/api.mjs` wraps the Express API as a Netlify Function.
- `netlify.toml` configures the publish directory, function directory and `/api/*` rewrite.
- Netlify Blobs stores the stable profile settings so the calendar feed survives serverless cold starts and new deploys.

### Option A: GitHub + Netlify dashboard

1. Create a GitHub repository and upload this project, including `package.json`, `package-lock.json`, `netlify.toml`, `server.js`, `public/` and `netlify/functions/`.
2. In Netlify, choose **Add new project → Import an existing project → GitHub**.
3. Select the repository.
4. Keep the build settings from `netlify.toml`. If Netlify asks for them, use:
   - **Build command:** `echo "Salah Sync: static frontend + Netlify Function"`
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`
5. Before deploying, open **Project configuration → Environment variables** and add:
   - Key: `USE_NETLIFY_BLOBS`
   - Value: `true`
   - Scope: **Functions** (and **Builds** if Netlify asks for a scope)
6. Click **Deploy site** and wait for the deploy to finish.
7. Open `https://YOUR-SITE-NAME.netlify.app/api/health`. You should see JSON containing `"ok":true`.
8. Open the site homepage, choose a location, review the calculation method and time zone, then click **Update prayer times**.

Do not put `USE_NETLIFY_BLOBS=true` only in `netlify.toml`; runtime function variables should be created in Netlify's environment-variable UI.

### Option B: Netlify CLI

From the project directory:

```bash
npm install -g netlify-cli
netlify login
netlify init
netlify deploy --prod
```

When prompted, create or link a Netlify site. The CLI will use `netlify.toml`. Add `USE_NETLIFY_BLOBS=true` in the Netlify dashboard afterward, then trigger a new deploy.

## Add the calendar to Google Calendar

1. Open the deployed site.
2. Select the location, calculation method, Asr school and time zone.
3. Click **Update prayer times**.
4. Click **Subscribe in Google Calendar**.
5. In Google Calendar, confirm the feed subscription.

You can also click **Copy** beside the private feed URL and add it manually in Google Calendar under **Other calendars → From URL**. Use the feed URL ending with `download=0` for a subscription.

Use **Download .ics** only for a one-time import. Use the subscription for ongoing updates.

## How ongoing updates work

Each browser gets a stable profile URL. When settings are saved, the profile in Netlify Blobs is updated without changing that URL. The feed regenerates future prayer events using the selected location, method, event duration and IANA time zone whenever it is fetched.

Google Calendar controls its own refresh interval for subscribed calendars, so changes are periodic rather than instant. The same URL will eventually reflect new locations, calculation methods and time zones. Google may not be able to fetch a local `localhost` URL, so use the deployed HTTPS Netlify URL.

## Custom domain

In Netlify, open **Domain management → Add a domain** and follow the DNS instructions. Netlify provisions HTTPS for the domain. Use the final HTTPS URL when subscribing to Google Calendar.

## What is included

- Location search through OpenStreetMap Nominatim, with a use-my-location option.
- Prayer times and Hijri dates from AlAdhan, using the selected calculation method, Asr school, high-latitude adjustment and Hijri adjustment.
- An explicit IANA time-zone field. The selected zone is used for display, countdowns and calendar timestamps, even if the device is in another zone.
- A seven-day view, live countdown, date navigation, 12/24-hour display and one-click individual Google Calendar event links.
- A stable profile-based `.ics` feed at `/api/feed/:profileId.ics`.
- A one-time `.ics` download option.

## API routes

- `GET /api/health`
- `GET /api/search?q=...`
- `GET /api/resolve?latitude=...&longitude=...`
- `GET /api/prayer?profile=...&date=YYYY-MM-DD`
- `GET /api/forecast?profile=...&start=YYYY-MM-DD&days=7`
- `GET /api/feed/:profileId.ics?days=180&download=0`
- `GET|PUT /api/profile/:profileId`

## Important platform note

Netlify Functions are serverless rather than a permanently running Express process. This project uses the function adapter and Netlify Blobs to make the API and profile feed work on Netlify. Functions still have platform execution and resource limits, and Google Calendar decides how frequently it refreshes external subscriptions. No hosting platform can guarantee unlimited traffic or instant third-party calendar refreshes.

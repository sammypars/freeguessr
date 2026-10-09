# FreeGuessr

A free, multiplayer take on GeoGuessr. You're dropped on a real street somewhere in the world; look around, put a pin on the map, and score up to 5,000 points depending on how close you are.

**Modes**

- **Solo**: 3–10 rounds, optional timer, moving or no-moving.
- **Party room**: up to 16 players guess the same places live. Share a 6-letter code or invite link. Host picks rounds, timer and movement.
- **Duel**: 1v1, 6,000 health each. Whoever is farther from the flag loses health equal to the score gap. Damage multiplies from round 5 onward. After the first guess, the other player has 15 seconds.
- **Daily challenge**: the same five places for everyone each UTC day, one attempt, with a leaderboard.

Players create an account with a username and password.

## How it's built

- Static site (plain HTML/CSS/JS, no build step), hosted free on **GitHub Pages**.
- **Supabase** (free tier) for accounts, the database and realtime updates. All game rules — scoring, timers, duel damage, who can start rounds — run inside the database (`supabase/schema.sql`), so players can't edit their own scores. The true location of a round stays hidden until the round ends.
- Street photos from two free sources: **Mapillary** (most places) and **Panoramax** (open 360° imagery hosted by OpenStreetMap groups). **Leaflet** + OpenStreetMap tiles for the maps.

## Setup (about 15 minutes, one time)

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. It should finish with "Success. No rows returned".
3. Go to **Authentication → Sign In / Providers → Email** and turn **off** "Confirm email". (Players sign in with a username, so there's no inbox to confirm.)
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon / publishable key**.

### 2. Mapillary

1. Sign up at [mapillary.com](https://www.mapillary.com) and open the [developer dashboard](https://www.mapillary.com/dashboard/developers).
2. **Register application** (any name; tick "Read" access), then copy the **Client Token** — it starts with `MLY|`.

### 3. Add the keys

Edit [`js/config.js`](js/config.js) and fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `MAPILLARY_TOKEN`. All three are designed to be public, so committing them is fine. Leave `AUTH_EMAIL_DOMAIN` alone once people have accounts — changing it breaks existing logins.

### 4. Publish

On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**. After a minute the game is live at `https://sammypars.github.io/freeguessr/`.

## Running locally

Any static server works, e.g. `python3 -m http.server 8000` in this folder, then open http://localhost:8000.

## Good to know

- The host's browser picks each round's location from Mapillary, so a determined player could dig the coordinates out of their browser's network tab. It's built for playing with friends, not for prize money.
- **Street photos setting** (solo setup and the room lobby): *Automatic* uses Mapillary when your browser can load its photos and Panoramax when it can't. Mapillary's photos come from Facebook's servers, which many school and office networks block; Panoramax loads there. In a room, the host's setting decides, so on a school network pick **Panoramax** so everyone's photos load.
- Panoramax coverage is thinner than Mapillary's and strongest in France and the rest of Europe, so Panoramax games lean European. The daily challenge always uses Panoramax so it works on every network.
- Both sources are crowd-sourced. The location picker favours 360° photos and falls back to flat photos if it can't find one quickly.
- **Playing on a school or work laptop?** Open `https://sammypars.github.io/freeguessr/#/check`. It tests everything the game needs and says what's blocked. The game's code libraries are hosted with the site (in `vendor/`) so filters that block code CDNs can't break it, and if a laptop has 3D graphics (WebGL) switched off, 360° photos show as a wide picture you drag sideways instead.
- Supabase pauses free projects after a week with no activity; open the dashboard and click **Restore** if the game stops loading after a long break.

## Files

| Path | What it does |
| --- | --- |
| `index.html` | Page shell |
| `css/styles.css` | All styling |
| `js/app.js` | Accounts, routing, home and daily screens |
| `js/game.js` | Lobby, rounds, results and final standings |
| `js/api.js` | Supabase calls and realtime subscriptions |
| `js/locations.js` | Random Mapillary location picker |
| `js/viewer.js` | Street-level viewer |
| `js/maps.js` | Guess map and results maps |
| `supabase/schema.sql` | Database tables, security rules and game logic |

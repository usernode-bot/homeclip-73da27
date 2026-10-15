# HomeClip

Watch your homeroom's own serial drama together. HomeClip is a
mobile-first drama streaming app built on Homeroom: browse an original
sample catalog, read about each show, play episodes, keep a personal
list, and pick up any episode where you left off.

Phase 1 covers the full loop with no sign-up friction and no payments:

- **Home** — auto-sliding featured banner, search with live suggestions,
  genre chips, and rows for Continue Watching, Trending Now, New
  Episodes and Top 10 (rank badges included).
- **Discover** — filter by genre, country and year; sort by popularity
  or newest; paginated grid.
- **Drama detail** — poster, rating, year, country, genres, synopsis,
  cast, episode list, Play (or Continue from your last minute) and
  Add to My List.
- **Player** — play/pause, seek bar, fullscreen, episode switcher, next
  episode, playback speed and subtitle language selector (English and
  Bahasa Indonesia). Playback resumes from the viewer's last minute,
  and progress is saved while watching.
- **My List** — saved dramas and watch history, with remove actions.
- **Profile** — language (English / Bahasa Indonesia), theme (follows
  the viewer's Homeroom setting by default), notifications toggle,
  About.

The group also keeps a shared **drama tracker** at `/tracker` (see below).

## Content

All 30 dramas in `data/catalog.js` are invented for this app: original
titles, synopses and cast names, with placeholder poster and banner
artwork generated as SVG from the drama itself (`/poster/:id.svg`,
`/banner/:id.svg`). Episode video is one committed royalty-free sample
clip (`public/sample/`, CC0, served as both `.webm` and `.mp4`) and
sample subtitle files (`/subtitles/:lang.vtt`). Nothing copyrighted is
used anywhere.

## Running it

The app is a Node/Express server (`server.js`) with its own Postgres
database and a vanilla-JS single-page frontend in `public/js/`, styled
with precompiled Tailwind (`npm run build` compiles
`styles/tailwind-input.css` to `public/tailwind.css`).

- `npm run build` then `node server.js` (needs `DATABASE_URL`,
  `USERNODE_JWT_PUBLIC_KEY`, `USERNODE_APP_ID`; the platform injects
  all of them).
- Staging previews seed the shared catalog on boot; `?demo=1` on any
  screen adds the viewer demo rows (My List entries and half-watched
  episodes marked `is_demo`) so populated screens can be reviewed. The
  plain routes stay the production shape without `?demo=1`.

## Drama tracker

A smaller, separate feature lives at `/tracker`: the group adds the serial
dramas it watches, season by season and episode by episode. Each person
follows the shows they like, marks episodes watched and sees which episode
comes next ("Next to watch"). Anyone in the group can add a drama and
episodes (season, number, title, optional length and link); the person who
added something can remove it, and a drama or episode can be reported to the
group's admins. An episode with a video link plays in the tracker's own
player (resume, skip intro, captions, quality, next-episode countdown); one
with only an external link opens it in a new tab. VIP members can save an
episode on their own device and watch it offline (nothing is stored
server-side). The tracker is available in seven languages and its shell is
installable. It uses its own `tracker_*`
tables and `/api/tracker/*` routes. The staging preview opened with
`/tracker?demo=1` shows five made-up dramas with their episodes, follows and
watches.

### VIP (drama tracker)

The tracker at `/tracker` carries a VIP subscription (`#/vip`,
`#/vip/manage`, `#/vip/payments`).

- **Plans** — Monthly (Rp 59.000), 3 Months (Rp 149.000) and Yearly
  (Rp 499.000), billed in rupiah. Benefits: no ads, early access, HD/4K and
  offline download.
- **Checkout** — Stripe in sandbox (test) mode on Stripe's own hosted page;
  no card numbers ever reach HomeClip. The provider structure is ready for
  Midtrans and Xendit (Indonesian e-wallets, bank transfer) — see
  `providers/`.
- **Access levels** — each episode is Free, VIP or Free with ads, set when
  the episode is added. A free user tapping a VIP episode gets the paywall
  sheet; a Free-with-ads episode shows a short pre-roll ad placeholder
  first. VIP members skip the ad and see every episode.
- **Subscription state** — active, canceled (still VIP until the renewal
  date) or expired, with the renewal date. Unlocking VIP content is
  enforced on the server: a locked episode's payload omits its watch URL
  and the watch endpoint refuses the write.
- **Coupons** — a promo-code field on the VIP page; the server validates
  the code and computes the discounted amount.
- **Payment history** and **Manage subscription** pages — every charge with
  its status, and cancel/resume for the subscription.

Stripe test keys are declared in `dapp.json` and set through the
platform's Secrets UI — never committed. Stripe returns the browser to
`/tracker/vip/return`.

## Development

- `npm run build` compiles `styles/tailwind-input.css` (Tailwind, with the
  app's colour tokens) to `public/tailwind.css`; the image build runs it on
  every deploy.
- `npm start` runs `server.js` (Express + Postgres). Schema is applied
  idempotently on boot.
- Secrets (Stripe test keys) are declared in `dapp.json` and set through
  the platform's Secrets UI — never committed.

To change the app, ask Homeroom bot (open the app on Homeroom, tap the
Homeroom icon, then **Suggest an improvement**), or run Claude Code against
this repo directly; `CLAUDE.md` carries the app-specific notes and points
at the platform rules.

The staging preview opened with `/tracker?demo=1` shows five made-up dramas
with their episodes, follows and watches, two episodes playable in the player,
and VIP enabled so Downloads can be tried. See `CLAUDE.md` for the app's
design notes and its data model.

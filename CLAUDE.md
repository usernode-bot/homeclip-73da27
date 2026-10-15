# HomeClip — notes for Claude Code

This app runs on **Homeroom**. The platform conventions are the single
source of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.):

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

**Inside Homeroom** (its dev chat, and Homeroom bot's builds), do not
fetch that URL: what applies to your change is already in your
instructions, and the `homeroom` MCP server's
`get_platform_conventions` reads any one section of the conventions
when you need it. The two sections below are for working outside
Homeroom; skip them there.

**Anywhere else** (Claude Code run against this repo locally, or another
harness), fetch it at the start of each session. The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

## Connector permission prompts (outside Homeroom)

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) once you accept the workspace trust dialog.
See `.claude/README.md` for the whole story, including what to do if you
are still being prompted.

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom (its dev
chat, and Homeroom bot's builds) the platform fixes the base commit, and none
of this applies.

## Starter template

The screen this app currently ships — the "Starter template" hero with
the app's thumbnail tile and the plain-English note on how the app gets
built (by asking Homeroom bot) — is placeholder content from the
Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About HomeClip

Watch your homeroom's own serial drama together. HomeClip is a
mobile-first drama streaming app: an original sample catalog of 30
invented dramas, detail pages, a real video player with progress
saving and resume, Discover filters, My List and watch history, and a
Profile with language and theme settings. The whole UI is bilingual
(English / Bahasa Indonesia). No sign-up beyond the platform identity,
no payments. All content is invented for the app: no real show, poster
or licensed video is used (see `data/catalog.js`).

## Design

- **Palette:** accent is a violet-blue (`#5c4aeb` light / `#7e6cff`
  dark) on calm neutral surfaces; dark look is a deep indigo ground
  (`#0a0a14`), light look a near-white lilac ground. All colours come
  from the tokens in `styles/tailwind-input.css` (`--ground`,
  `--surface`, `--raised`, `--fg`, `--muted`, `--line`, `--accent`).
- **Signature element:** the generated SVG poster and banner artwork
  (`/poster/:id.svg`, `/banner/:id.svg`): each drama gets
  deterministic genre-hued art with a play-glyph badge, so the catalog
  reads as a streaming wall without any licensed imagery. The
  Continue Watching row carries a thin accent progress bar
  (`.hc-progress`) under the title.
- **Type scale:** `text-title`, `text-heading`, `text-body`,
  `text-small`, nothing in between.
- **Both looks:** the app follows the viewer's Homeroom theme (in-app
  theme setting on Profile wins over it when set). Every new screen
  gets both a light and a dark value per token.

### Drama tracker (also on this app)

The app also carries a smaller feature from main: a shared drama tracker at
`/tracker`. The group adds serial dramas season by season and episode by
episode; each person follows the shows they like, marks episodes watched and
sees which episode comes next. An episode can carry
a link to wherever it is watched, which Watch opens in a new tab, or a video
link that plays inside the tracker's own player (resume, skip intro, captions,
quality, next-episode countdown); VIP members can save an episode for offline
viewing, with nothing stored server-side. It is
separate from the streaming catalog above: its own tables (`tracker_*`), API
(`/api/tracker/*`), page (`public/tracker.html`, `public/app.js`,
`public/screens.css`) and hash routing.

Its design: the main screen's one job is to start the next episode, so its
one filled button is Watch, in warm amber (the `action` token with
`on-action`, and `action-soft` for the "New episode" tint); Follow buttons
stay outlined and quiet. The signature element is the TV: next-to-watch and
upcoming episodes are drawn as TV screens, and progress is always one thin
amber bar. Posters there are flat colour tiles; a drama MAY carry a
`poster_url` (uploaded through the platform's storage from the Add drama
sheet, or pasted as a link), which is lazy-loaded into the tile everywhere
it is drawn.

The tracker also sells VIP: its access chip (`chip-vip` with a lock icon,
on the `accent` token) marks VIP episodes and a quiet `chip-soft` marks
"Free with ads".

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `chip`, `chip-vip`, `chip-soft`, `section-label`, `skeleton`,
`state-empty`, `state-error`). Re-theme by changing the token values there,
keeping every text pair at 4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Each screen sits in `page-column`, one centred column on a wide window.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry. Loading has the content's
  own shape (its rows, with `skeleton` bars for their text).
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.
- A header that shows the app's own mark shows the project's icon there
  (the emoji in `dapp.json`'s `icon` block) or no mark at all: never an
  empty tile, and never `brand/icon.png`, which the app does not serve.

## App-specific conventions

- **No new dependencies** (hls.js, for the tracker player, is the one exception). The frontend is vanilla ES modules in
  `public/js/` with path-based routing in `router.js` (History API);
  styling is precompiled Tailwind only. No framework, no runtime CSS.
- **Generated art is served outside `/api/`.** `<img>` and `<track>`
  elements cannot attach the auth header, and the poster, banner and
  subtitle routes return non-sensitive generated content, so they live
  at `/poster/:id.svg`, `/banner/:id.svg` and `/subtitles/:lang.vtt`.
  Never move them under `/api/` and never serve user data there.
- **Video strategy:** every episode points at one committed
  extensionless URL (`/sample/clip`); the player appends `.webm` and
  `.mp4` and offers both as `<source>` elements, so the browser picks a
  codec it supports.
- **Per-user tables are `staging:private`:** `my_list`, `watch_progress`,
  `settings` and `profiles`. `?demo=1` (staging) seeds the viewing account
  demo rows marked `is_demo`; responses without `?demo=1` exclude those
  rows so plain routes stay production-shaped.
- **Profiles and Add a drama (catalog side):** `/profiles` is the signed-in
  account's "Who's watching?" picker (per-account `profiles` table,
  `/api/profiles` CRUD, cap of 5, last-profile guard; selection kept in
  `localStorage hc:profile`, a profile's language applied on pick).
  `/add` is a catalog-side form that adds a drama to the shared tracker
  via `POST /api/tracker/dramas` (the tracker's own Add drama sheet is the
  other entry point; same rules). Both are reached from the Profile screen.
- **Progress saving is throttled** (every 5 s while playing, plus on
  pause, pagehide and view unmount) and only stored for signed-in
  viewers; guests can browse and watch but never write.
- **Drama tracker data:** `tracker_follows`, `tracker_watches` and
  `tracker_reports` are marked `staging:private` (each person's own data).
  `tracker_dramas` and `tracker_episodes` are public: the group's shared
  feed. These tables were named `dramas` / `episodes` / `follows` / `watches`
  / `reports` before the streaming catalog arrived; `migrateLegacyTrackerTables`
  (server.js) renames them on boot when a database still has them under the
  old names, keeping the group's data and freeing the names for the catalog.
  The five tracker demo dramas and their episodes are seeded on boot in
  staging with fixed ids and `is_demo = true`; every `/api/tracker/*` response
  without `?demo=1` leaves `is_demo` rows out. The viewing account's own
  follows and watches are written once, on its first `?demo=1` request.
- **Tracker vocabulary:** drama, season, episode, Follow, Following, Watch,
  watched, Next to watch, Continue this season, Drama feed, Add drama, Add
  episode, Report, Remove. One idea, one word, everywhere.
- **Tracker VIP and payments** (all under `/api/tracker/*` except the
  webhook). Tables `subscriptions`, `payments` (both `staging:private`),
  `coupons`, plus `comments`, `comment_likes` and `reviews` (private) keep
  their own names; they reference the `tracker_*` tables. Staging seeds
  fake subscriptions, payments and the `STAGE10` coupon for the shots'
  fixture accounts, and demo episodes carry mixed access levels.
- **Money is integer rupiah, never floats** (IDR is zero-decimal in
  Stripe), shown as "Rp 59.000" with dot separators, formatted by hand.
- **VIP is decided on the server only.** `vipStatus()` reads
  `subscriptions` against `req.now`; `gateEpisode()` strips a locked
  episode's `watch_url`, and marking a VIP episode watched answers 403
  `vip_required`. The client cannot unlock anything. Decision code reads
  `req.now`, never `new Date()`.
- **Payments add no runtime dependency:** Stripe goes over `fetch` against
  its REST API and webhook signatures are verified with node `crypto`
  (adapters in `providers/`; midtrans/xendit are 501 stubs). The webhook
  `/api/webhooks/stripe` is the one public API path; Stripe returns the
  browser to `/tracker/vip/return` (no hash), which the tracker page's
  router handles alongside the hash routes.
- **Comments, likes and reviews** on the tracker are moderated with
  `moderation.js` (profanity and spam checks).
- **Tracker vocabulary** also includes VIP, Free, Free with ads.
- **Tracker sample dramas:** twelve more made-up dramas (ids 910001-910012
  in `tracker_dramas`, their episodes from 9200001 up) are seeded on boot in
  staging alongside the demo, with full metadata (country, year, genres, an
  editorial rating out of 10, fictional cast, a mix of Free, VIP and
  Free-with-ads access). The tracker's Home rows (Trending Now, New Episodes,
  Top 10, one row per genre) are built server-side in `/api/tracker/feed`
  from whatever dramas the route can see. Trending orders by follow count;
  the sample dramas' seeded follows (Priya, Sam, Jun) are its demo signal.
- **Tracker player, downloads and offline** (all tracker-side, none of it touches
  the streaming catalog). `public/tracker.html` is one page with four views
  (`#view-home`, `#view-drama`, `#view-watch`, `#view-downloads`) routed by
  `public/app.js` on the hash (`#/drama/:id`, ...) and on the path under
  `/tracker` (`/tracker/drama/:id`, `/tracker/watch/:id`, `/tracker/downloads`,
  `/tracker/vip/...`); `server.js` serves the drama and watch paths with
  per-request meta (Open Graph, JSON-LD) injected into `tracker.html`. The watch
  and downloads logic lives in `public/watch.js` and `public/downloads.js`,
  loaded only when those views open; hls.js (accepted exception to "no new
  dependencies", for `.m3u8` only) is served at `/vendor/hls.min.js`. An
  episode's `media_url` plays in the in-app player; `watch_url` still opens in a
  new tab. Demo episode 9000012 (Harbour Lights S2E6) carries an HLS test stream
  and the fake captions in `public/demo/demo-subs.vtt`; 9000063 (Copper Hill
  S2E14) carries the small VP9 WebM `public/demo/demo-video.webm` (Big Buck
  Bunny, CC BY, Blender Foundation). `?demo=1` makes the viewing account VIP in
  memory only so Downloads can be tried.
- **Tracker private tables** also include `playback`, `events` and
  `client_errors` (marked `staging:private`); `playback` references
  `tracker_episodes`. Tracker analytics is first-party only: whitelisted event
  names server-side, batched client-side, no third-party analytics.
- **Tracker i18n and offline:** all tracker words live in `public/i18n.js`
  (7 locales; server responses carry numbers and names, never sentence words).
  The service worker `public/sw.js` is registered with scope `/tracker`,
  precaches the tracker shell only and never serves `/api/*`. Cached reads and
  the write queue live in localStorage (`hc-cache:<userId>...`,
  `hc-queue:<userId>`), downloads in IndexedDB (`hc-downloads:<userId>`).
- **Tracker API routes added with the player** (`/api/tracker/watch/:episodeId`,
  `/episodes/:id/progress`, `/subscription`, `/events`) sit on the tracker
  router; `/api/client-errors` and `/api/webhooks/stripe` stay on `app`.
- Legal pages live at `/terms`, `/privacy`, `/copyright` (static under
  `public/legal/`); `/robots.txt` and `/sitemap.xml` list the tracker dramas.

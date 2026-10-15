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

## Platform blocks to keep in `public/index.html`

The starter screen was replaced by the real app in the first version;
these blocks from the template stay and must never be removed:

- the `usernode-dev-console@1` forwarder `<script>` (platform
  infrastructure — it feeds the in-app Dev Console),
- the bridge `<script>` and the theme `<script>` right after it (the
  theme script sets the `dark` class on `<html>` from the viewer's
  Homeroom setting, and the app's own Settings override lives beside it).

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About HomeClip

Watch your homeroom's own serial drama together. The group adds dramas
(seasons, episodes, genres, cast), everyone watches on their own profile,
and Home keeps each person's place in each drama. One episode at a time
is the unit of watching; a drama's "Next up" episode is the first one
after what the profile has already finished.

The frontend is vanilla classic scripts on `window.HC` (`store`, `api`,
`screens`, `player`, `router`, `app`) — no bundler. Tailwind is
precompiled at image build from `styles/tailwind-input.css` +
`tailwind.config.js` into `public/tailwind.css`; never special-case that
path in `server.js`.

## Design

This app's look. The first real version filled in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** accent deep teal (the `--color-accent` token, a
  lighthouse-lamp teal that reads clearly in both looks); neutrals are the
  kit's warm greys. Colour comes only from the tokens.
- **Signature element:** the "Next up" card — one large card at the top of
  Home naming the exact episode to watch next, with the progress of that
  season under it ("watched 1 of 6"). No other app has a next-episode card.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
- Both looks: light and dark, following the viewer's Homeroom theme. The
  in-app override in Settings (auto/light/dark) writes `hc:ui:theme` and
  wins over the platform value; "Follow Homeroom" clears it.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`, plus
`avatar`/`avatar-sm`/`profile-chip` for profile identity).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

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

- **Data model:** catalog tables (`dramas`, `seasons`, `episodes`,
  `genres`, `drama_genres`, `cast_members`, `drama_cast`) are public.
  Every per-profile table (`profiles`, `follows`, `episode_watches`,
  `my_list`, `ratings`, `profile_settings`, `search_history`) is marked
  `staging:private` — it holds one person's viewing data.
- **Staging seeds** (`server/seed.js`): fixed ids in the 900000/930000
  ranges, "Staging demo:" title prefix, a fake "Demo mate" profile owned
  by a made-up account id. Never seed the signed-in visitor; the one
  exception is the `usernode-capture` shots fixture, created lazily by
  username in `ensureShotsFixtures`.
- **Watch positions** are saved with `PUT /api/watches`, an idempotent
  upsert: position advances only when the new value is greater, so an
  offline-replayed older position cannot roll a watch back.
- **Identity/token:** the frontend keeps the iframe token in
  `localStorage['hc:token']` and strips it from the URL; namespaces
  (cache, offline queue) are keyed by account id so switching accounts
  never leaks one person's data to another.
- **Mature filtering is server-side.** A Kids profile never receives
  mature rows from any read route; direct detail requests answer
  `403 { error: 'mature_hidden' }`. Never re-implement it client-side.
- **No new npm dependencies** without saying why in the dev-chat reply.

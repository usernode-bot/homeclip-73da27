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

Watch your homeroom's own serial drama together. The group adds the serial
dramas it watches, season by season and episode by episode; each person
follows the shows they like, marks episodes watched and sees which episode
comes next. HomeClip plays no video itself: an episode can carry a link to
wherever it is watched, which Watch opens in a new tab.

## Design

The main screen's one job is to start the next episode, so its one filled
button is Watch, in warm amber. The feed below is for browsing: Follow
buttons stay outlined and quiet, and the posters and titles get the room. A
drama's page is for reading its episode list; its only filled button is
Watch, on the next episode.

- **Palette:** warm greys and white for the page (ground, surface, raised,
  line), deep teal as the accent (the TV screen, Following, the group's
  notes, the `accent` token with `on-accent` on it), warm amber as the
  action colour (the `action` token with `on-action` on it, and
  `action-soft` for the "New episode" tint). Danger stays the kit's red.
  Both looks follow the viewer's Homeroom theme; the token values live in
  `styles/tailwind-input.css`.
- **Signature element:** the TV. Next-to-watch and the upcoming episodes are
  drawn as TV screens with a dark bezel and a small stand; the episode
  numbers on a drama's page sit in small TV screens. Progress is always one
  thin amber bar. Posters are flat colour tiles: each drama gets one of four
  colours (teal, amber, ink, slate) in turn, so nobody has to upload
  anything.
- **Type scale:** `text-title` (28), `text-heading` (20), `text-body` (16),
  `text-small` (14). The typeface is the system's rounded face
  (`fontFamily` ui-rounded in `tailwind.config.js`), which feels friendly
  like a living-room screen.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
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

- **Private tables:** `follows`, `watches` and `reports` are marked
  `staging:private` (each person's own data). `dramas` and `episodes` are
  public: the group's shared feed.
- **Demo data:** the five demo dramas and their episodes are seeded on boot
  in staging with fixed ids and `is_demo = true`; every API response without
  `?demo=1` leaves `is_demo` rows out, so the plain route stays
  production-shaped. The viewing account's own follows and watches are
  written once, on its first `?demo=1` request.
- **Vocabulary:** drama, season, episode, Follow, Following, Watch,
  watched, Next to watch, Continue this season, Drama feed, Add drama,
  Add episode, Report, Remove. One idea, one word, everywhere.
- Avoid adding new dependencies; the stack is Express, pg and Tailwind.

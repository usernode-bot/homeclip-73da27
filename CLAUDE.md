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
dramas it watches, season by season and episode by episode; everyone
follows the shows they like, marks episodes watched and sees which episode
comes next ("Next to watch"). Since Phase 3, episodes carry access levels —
Free, VIP, Free with ads — and a HomeClip VIP subscription (Monthly /
3 Months / Yearly, billed in rupiah through Stripe in sandbox mode) unlocks
VIP episodes, skips the pre-roll ad placeholder, and is managed from the
VIP, Manage-subscription and Payment-history pages.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** the starter kit as shipped — quiet warm greys with one teal
  accent; the token values live in `styles/tailwind-input.css`.
- **Signature element:** episodes drawn as little TV screens — rounded
  screens with a thick frame border, the "Next to watch" hero is the big
  one — and the accent VIP chip with a lock icon wherever access matters.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  _(change their sizes in `tailwind.config.js` if you must, not their number)_
- **One fixed look:** _(only for an app drawn as its own scene, such as a
  game: which look, and why. Otherwise delete this line.)_

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `chip`, `chip-vip`, `chip-soft`, `section-label`, `skeleton`,
`state-empty`, `state-error`). Re-theme by changing the token values there,
keeping every text pair at 4.5:1 or more in both looks.

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

- **Money is integer rupiah, never floats.** IDR is zero-decimal in Stripe;
  the `subscriptions`/`payments` tables and all display use whole rupiah
  ("Rp 59.000", dot separators, formatted by hand so the format never
  depends on the browser's Intl data).
- **VIP is decided on the server only.** `vipStatus()` in `server.js` reads
  the private `subscriptions` table against `req.now`; the client renders
  what it is given and cannot unlock anything.
- **`subscriptions` and `payments` are `staging:private`** (financial data).
  Staging seeds fake rows for the shots' fixture accounts only.
- **"Now" comes from `req.now`** (already set by the platform middleware) —
  renewal dates, expiry and coupon windows included — never `new Date()`
  in decision code.
- **No new runtime dependencies** for payments: Stripe goes over `fetch`
  against its REST API; webhook signatures are verified with node `crypto`.
  Adapters live in `providers/` (stripe implemented; midtrans/xendit are
  structured stubs that answer 501 until built).

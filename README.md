# HomeClip

Watch your homeroom's own serial drama together. HomeClip is a small
watch-together app for a Homeroom group: the group adds dramas (seasons,
episodes), everyone watches on their own profile, and Home keeps each
person's place, list and ratings.

## What's in the app

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build. Signed-out visitors browse as guests;
  every write asks them to make an account.
- **Profiles** — up to 4 per account, each with its own history, list,
  ratings and searches. A Kids profile hides mature dramas everywhere,
  enforced server-side.
- **Real database** — Postgres, migrated idempotently on boot. The
  catalog tables (dramas, seasons, episodes, genres, cast) are public;
  every per-profile table is marked `staging:private`.
- **Home** — Next up, Continue watching, My list, "Because you watched"
  recommendations, and the whole catalog with keyset pagination.
- **Search** — suggestions as you type, recent searches, results across
  dramas and cast.
- **Player** — plays episode clips it hosts; episodes that live on
  another site open there and still record that you started them.
- **Offline-friendly** — reads are cached and served stale while
  revalidating; writes made offline queue on the device and replay in
  order when the connection returns.

## Styling

Tailwind CSS, precompiled by `npm run build` during image creation with
either Kubernetes/Paketo or standalone Docker, in a light and a dark
look that follow the viewer's Homeroom theme (with an optional in-app
override in Settings).

## Staging

Staging previews seed a fake demo catalog ("Staging demo: …" titles),
a fake "Demo mate" viewer so who-else-watched and group ratings show
activity, and — for the before/after shots' fixture account — a small
viewing history. Production starts with an empty catalog the group
fills in the app. See `CLAUDE.md` and the platform conventions for the
rules these follow.

## Working on the app

Start with `CLAUDE.md`, which carries the app-specific notes and points
at the platform rules. To change the app, ask Homeroom bot, or run
Claude Code against this repo directly.

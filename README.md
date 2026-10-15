# HomeClip

Watch your homeroom's own serial drama together.

The group adds the serial dramas it watches, season by season and episode by
episode. Each person follows the shows they like, marks episodes watched and
sees which episode comes next — the main screen's one job is to start that
next episode.

- **Drama feed** — every drama the group has added, newest first, each with a
  note: your progress through the season you are on, "New episode" for one
  added this week, who else has watched it, or "You finished it".
- **Next to watch** — the first episode you have not watched in the show you
  watched most recently, drawn as a TV screen with a thin amber bar for how
  far through the season you are.
- **Follow** — shows you follow make up "Next to watch".
- **Watch** — an episode with a video link plays inside the app's player
  (resume from where you stopped, skip intro, captions, quality, next-episode
  countdown); an episode with only an external link opens it in a new tab.
- **Downloads** — VIP members save an episode's video and subtitles on their
  own device and watch it with no connection. Nothing is stored server-side.
- **Add and remove** — anyone in the group can add a drama and episodes
  (season, number, title, optional length, link and video link); the person
  who added something can remove it.
- **Report** — a drama or an episode can be reported to the group's admins
  with an optional reason. Nothing is hidden automatically.
- **Seven languages** — English, Bahasa Indonesia, Español, العربية (right to
  left), 中文, 한국어 and 日本語, chosen from the header; the viewer's Homeroom
  language seeds the first choice.
- **Installable** — the app can be installed to a home screen, and its shell
  opens with no connection showing the last thing you had open.

Anyone in the group can add to the feed; episodes are organised by season,
then episode number. Watched status is tracked per person, and the group can
see who has watched each episode — which is how people watch together.

## VIP

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

The staging preview opened with `?demo=1` shows five made-up dramas with
their episodes, follows and watches, two episodes playable in the player,
and VIP enabled so Downloads can be tried. See `CLAUDE.md` for the app's
design notes and its data model.

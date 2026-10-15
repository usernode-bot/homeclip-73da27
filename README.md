# HomeClip

Watch your homeroom's own serial drama together. The group adds the serial
dramas it watches, season by season and episode by episode; everyone follows
the shows they like, marks episodes watched and sees which episode comes
next.

## Watching

- **Drama feed** — every drama the group added, newest first, with its
  season and episode counts and an access chip: **Free**, **VIP** (accent
  chip with a lock), or **Free with ads**.
- **Follow** — follow the shows you like; **Next to watch** on the home
  screen is the first episode you have not watched in the show you watched
  most recently.
- **Watch** — marks an episode watched and, when whoever added it gave a
  link, opens that link in a new tab. Tap the circle again to unmark it.
- **Access levels** — each episode is Free, VIP or Free with ads, set when
  the episode is added. A free user tapping a VIP episode gets the paywall
  screen; a Free-with-ads episode shows a short pre-roll ad placeholder
  before the watch controls.

## VIP

- **Plans** — Monthly (Rp 59.000), 3 Months (Rp 149.000) and Yearly
  (Rp 499.000), billed in rupiah. Benefits: no ads, early access, HD/4K and
  offline download.
- **Checkout** — Stripe in sandbox (test) mode on Stripe's own hosted page;
  no card numbers ever reach HomeClip. The provider structure is ready for
  Midtrans and Xendit (Indonesian e-wallets, bank transfer) — see
  `providers/`.
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

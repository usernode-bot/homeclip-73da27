const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { isProfane, isSpam, loose } = require('./moderation');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT. The Stripe webhook
// is called by Stripe's servers, which carry no platform token; it is
// authenticated by its own HMAC signature instead (see the route below).
const PUBLIC_API_PATHS = new Set(['/health', '/api/webhooks/stripe']);

// Keep the raw request body alongside the parsed one: Stripe webhook
// signatures are computed over the exact bytes on the wire, so re-serialising
// the parsed object would break verification.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline,
// a subscription's renewal date.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

/* ── HomeClip: dramas, episodes and VIP access ────────────────────────────
 *
 * The app's own API. Every VIP decision is made HERE, from the private
 * `subscriptions` table, using `req.now` — never in the browser: the client
 * only ever receives already-gated payloads (a locked VIP episode arrives
 * without its watch_url, an ad episode arrives with `requiresAd`).
 */

// The plans. Prices are integer rupiah (IDR is zero-decimal in Stripe, so
// no cents exist anywhere in this app). The per-month and save figures are
// display-only; the charged amount is exactly `priceIdr`.
const PLANS = {
  monthly: {
    id: 'monthly', name: 'Monthly', months: 1, priceIdr: 59000,
    interval: { unit: 'month', count: 1 }, perMonthIdr: 59000, save: null,
  },
  quarterly: {
    id: 'quarterly', name: '3 Months', months: 3, priceIdr: 149000,
    interval: { unit: 'month', count: 3 }, perMonthIdr: 49667, save: 16,
  },
  yearly: {
    id: 'yearly', name: 'Yearly', months: 12, priceIdr: 499000,
    interval: { unit: 'year', count: 1 }, perMonthIdr: 41583, save: 29,
  },
};

const { currentProvider } = require('./providers');

function paymentConfigured() {
  return currentProvider().id === 'stripe'
    ? Boolean(process.env.STRIPE_SECRET_KEY)
    : true; // other providers decide inside their own adapter
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Wrap an async handler so a rejected promise answers 500 JSON instead of
// hanging the request.
const h = (fn) => (req, res) => {
  fn(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });
};

/* ── Subscription state ─────────────────────────────────────────────────── */

// The one place that decides who is a VIP. Picks the user's newest
// subscription row and reads it against `req.now`: "active" and "canceled"
// are both VIP until their renewal date passes, then everything reads
// expired. No background reaper needed.
async function vipStatus(req) {
  if (!req.user) return { vip: false, status: 'expired', row: null };
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id = $1
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [req.user.id]
  );
  const row = rows[0] || null;
  if (!row) return { vip: false, status: 'expired', row: null };
  if (row.renewal_date && new Date(row.renewal_date) > req.now) {
    return { vip: true, status: row.status === 'canceled' ? 'canceled' : 'active', row };
  }
  return { vip: false, status: 'expired', row };
}

function subscriptionPayload(s) {
  const plan = s.row ? PLANS[s.row.plan_id] : null;
  return {
    vip: s.vip,
    status: s.status, // 'active' | 'canceled' | 'expired', for display
    plan: plan ? { id: plan.id, name: plan.name, priceIdr: plan.priceIdr } : null,
    renewalDate: s.row ? s.row.renewal_date : null,
    startedAt: s.row ? s.row.started_at : null,
    canceledAt: s.row ? s.row.canceled_at : null,
    provider: s.row ? s.row.provider : null,
    canCancel: Boolean(s.vip && s.row && s.row.status === 'active'),
    canResume: Boolean(s.row && s.row.status === 'canceled' && s.vip),
  };
}

// Record a paid subscription: one new row. Older rows stay as history; the
// newest row is always the one `vipStatus` reads.
async function activateSubscription(userId, planId, provider, providerRef, now) {
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan_id, status, provider, provider_ref, started_at, renewal_date)
     VALUES ($1, $2, 'active', $3, $4, $5, $6)`,
    [userId, planId, provider, providerRef, now, addMonths(now, PLANS[planId].months)]
  );
}

/* ── Coupons ────────────────────────────────────────────────────────────── */

// Returns { discount, code } or { error }. The server owns the arithmetic;
// the client only displays what it is told.
async function couponDiscount(code, plan, now) {
  if (!code || !String(code).trim()) return { error: 'missing' };
  const { rows } = await pool.query(
    `SELECT * FROM coupons WHERE upper(code) = upper($1)`,
    [String(code).trim()]
  );
  const c = rows[0];
  if (!c || !c.active) return { error: 'invalid' };
  if (c.expires_at && new Date(c.expires_at) <= now) return { error: 'expired' };
  if (c.max_uses != null && c.uses_count >= c.max_uses) return { error: 'used_up' };
  const discount = c.kind === 'percent'
    ? Math.round(plan.priceIdr * c.value / 100)
    : c.value;
  return { discount: Math.min(discount, plan.priceIdr), code: c.code };
}

/* ── Episode access: the VIP gate ───────────────────────────────────────── */

// A locked VIP episode leaves WITHOUT its watch_url, so no amount of
// client-side editing can unlock it. Ad episodes keep their watch_url but
// carry `requiresAd` so the page shows the pre-roll; VIP users never get
// the flag.
function gateEpisode(e, vip) {
  const access = e.access || 'free';
  const locked = access === 'vip' && !vip;
  return {
    ...e,
    access,
    locked,
    requiresAd: access === 'ads' && !vip,
    watch_url: locked ? null : (e.watch_url || null),
  };
}

/* ── Plans, subscription management, payment history ────────────────────── */

app.get('/api/plans', (_req, res) => {
  res.json({
    provider: currentProvider().id,
    paymentConfigured: paymentConfigured(),
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, name: p.name, priceIdr: p.priceIdr,
      perMonthIdr: p.perMonthIdr, save: p.save, months: p.months,
    })),
  });
});

app.get('/api/me/subscription', h(async (req, res) => {
  res.json(subscriptionPayload(await vipStatus(req)));
}));

app.post('/api/subscription/cancel', h(async (req, res) => {
  const s = await vipStatus(req);
  if (!s.row || !s.vip) return res.status(409).json({ error: 'not_active' });
  // Cancelling keeps VIP until the renewal date already paid for.
  await pool.query(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = $3
     WHERE id = $1 AND user_id = $2`,
    [s.row.id, req.user.id, req.now]
  );
  res.json(subscriptionPayload(await vipStatus(req)));
}));

app.post('/api/subscription/resume', h(async (req, res) => {
  const s = await vipStatus(req);
  if (!s.row || s.row.status !== 'canceled' || !s.vip) {
    return res.status(409).json({ error: 'not_canceled' });
  }
  await pool.query(
    `UPDATE subscriptions SET status = 'active', canceled_at = NULL
     WHERE id = $1 AND user_id = $2`,
    [s.row.id, req.user.id]
  );
  res.json(subscriptionPayload(await vipStatus(req)));
}));

app.get('/api/payments', h(async (req, res) => {
  if (!req.user) return res.json({ payments: [] });
  const { rows } = await pool.query(
    `SELECT id, plan_id, provider, provider_ref, amount_idr, discount_idr,
            coupon_code, method, status, created_at, paid_at
     FROM payments WHERE user_id = $1
     ORDER BY created_at DESC, id DESC`,
    [req.user.id]
  );
  res.json({
    payments: rows.map((p) => ({
      id: p.id, planId: p.plan_id, provider: p.provider,
      providerRef: p.provider_ref, amountIdr: p.amount_idr,
      discountIdr: p.discount_idr, couponCode: p.coupon_code,
      method: p.method, status: p.status,
      createdAt: p.created_at, paidAt: p.paid_at,
    })),
  });
}));

app.post('/api/coupon/validate', h(async (req, res) => {
  const plan = PLANS[req.body.planId];
  if (!plan) return res.status(400).json({ error: 'unknown_plan' });
  const r = await couponDiscount(req.body.couponCode, plan, req.now);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({
    ok: true, code: r.code, discountIdr: r.discount,
    amountIdr: plan.priceIdr - r.discount,
  });
}));

/* ── Checkout: Stripe sandbox, Midtrans/Xendit-ready ────────────────────── */

// Where Stripe should send the browser after payment. Built from the
// request's own host so no hostname is baked into the app.
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

app.post('/api/checkout', h(async (req, res) => {
  const plan = PLANS[req.body.planId];
  if (!plan) return res.status(400).json({ error: 'unknown_plan' });
  const s = await vipStatus(req);
  if (s.vip) return res.status(409).json({ error: 'already_vip' });
  if (!paymentConfigured()) {
    return res.status(503).json({ error: 'payments_not_configured' });
  }

  let discount = 0;
  let couponCode = null;
  if (req.body.couponCode) {
    const c = await couponDiscount(req.body.couponCode, plan, req.now);
    if (c.error) return res.status(400).json({ error: 'coupon_' + c.error });
    discount = c.discount;
    couponCode = c.code;
  }
  const amountIdr = plan.priceIdr - discount;

  const payment = await pool.query(
    `INSERT INTO payments (user_id, plan_id, provider, amount_idr, discount_idr, coupon_code, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
    [req.user.id, plan.id, currentProvider().id, amountIdr, discount, couponCode]
  );
  const paymentId = payment.rows[0].id;
  if (couponCode) {
    await pool.query(
      `UPDATE coupons SET uses_count = uses_count + 1 WHERE upper(code) = upper($1)`,
      [couponCode]
    );
  }

  try {
    const out = await currentProvider().createCheckout({
      plan, amountIdr, origin: requestOrigin(req),
      userId: req.user.id, paymentId,
    });
    res.json({ url: out.url, sessionId: out.sessionId });
  } catch (err) {
    if (err.code === 'provider_not_configured') {
      await pool.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
      return res.status(503).json({ error: 'provider_not_configured' });
    }
    console.error(err);
    await pool.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
    return res.status(502).json({ error: 'checkout_failed', message: err.message });
  }
}));

// One fulfilment path for both the browser's return and the webhook, and it
// is idempotent: a payment row is only ever marked paid once.
async function fulfillCheckout(session, now) {
  const meta = session.metadata || {};
  const paymentId = Number(meta.payment_id);
  const userId = meta.user_id;
  const planId = meta.plan_id;
  if (!paymentId || !userId || !PLANS[planId]) return;
  const cur = await pool.query(
    `SELECT status FROM payments WHERE id = $1 AND user_id = $2`,
    [paymentId, userId]
  );
  if (!cur.rows.length || cur.rows[0].status === 'paid') return;
  await pool.query(
    `UPDATE payments SET status = 'paid', paid_at = $2, provider_ref = $3 WHERE id = $1`,
    [paymentId, now, session.subscription || session.id]
  );
  await activateSubscription(userId, planId, 'stripe', session.subscription || session.id, now);
}

// The browser lands here straight from Stripe's hosted page. The redirect
// alone proves nothing — the server asks Stripe about the session before
// unlocking anything.
app.get('/api/checkout/confirm', h(async (req, res) => {
  if (!paymentConfigured()) return res.status(503).json({ error: 'payments_not_configured' });
  const sessionId = String(req.query.session_id || '');
  if (!/^cs_(test|live)_\w+$/.test(sessionId)) {
    return res.status(400).json({ error: 'bad_session' });
  }
  let session;
  try {
    session = await currentProvider().retrieveSession(sessionId);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'stripe_error', message: err.message });
  }
  if (!session.metadata || session.metadata.user_id !== req.user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    await fulfillCheckout(session, req.now);
  }
  res.json(subscriptionPayload(await vipStatus(req)));
}));

app.post('/api/webhooks/stripe', h(async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'webhook_not_configured' });
  const provider = currentProvider();
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
  if (!provider.verifyEvent(raw, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'invalid_signature' });
  }
  let event;
  try {
    event = provider.parseEvent(raw);
  } catch {
    return res.status(400).json({ error: 'bad_payload' });
  }
  const now = new Date();
  if (event && event.type === 'checkout.session.completed') {
    await fulfillCheckout(event.data.object, now);
  } else if (event && event.type === 'invoice.paid') {
    // A renewal charge: extend the subscription's renewal date by its plan
    // length, and record the charge in the payment history.
    const inv = event.data.object || {};
    if (inv.subscription) {
      const { rows } = await pool.query(
        `SELECT * FROM subscriptions WHERE provider_ref = $1
         ORDER BY started_at DESC LIMIT 1`,
        [inv.subscription]
      );
      const row = rows[0];
      if (row && PLANS[row.plan_id]) {
        const base = new Date(row.renewal_date) > now ? new Date(row.renewal_date) : now;
        await pool.query(
          `UPDATE subscriptions SET renewal_date = $2, status = 'active', canceled_at = NULL
           WHERE id = $1`,
          [row.id, addMonths(base, PLANS[row.plan_id].months)]
        );
        await pool.query(
          `INSERT INTO payments (user_id, plan_id, provider, provider_ref, amount_idr, method, status, created_at, paid_at)
           VALUES ($1, $2, 'stripe', $3, $4, $5, 'paid', $6, $6)`,
          [row.user_id, row.plan_id, inv.subscription, inv.amount_paid || PLANS[row.plan_id].priceIdr, 'card', now]
        );
      }
    }
  } else if (event && event.type === 'customer.subscription.deleted') {
    // The provider ended the subscription now — access ends now.
    const sub = event.data.object || {};
    if (sub.id) {
      await pool.query(
        `UPDATE subscriptions SET status = 'expired'
         WHERE provider_ref = $1 AND renewal_date > $2`,
        [sub.id, now]
      );
    }
  }
  res.json({ received: true });
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── Schema ────────────────────────────────────────────────────────────────
// Idempotent on boot. `dramas` and `episodes` are public (the group's shared
// feed); `follows`, `watches` and `reports` are each person's own data,
// marked `staging:private` so staging copies the schema without the rows
// (the demo seeds its own).

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dramas (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
      synopsis TEXT CHECK (synopsis IS NULL OR length(synopsis) <= 280),
      added_by_id BIGINT NOT NULL,
      added_by_username TEXT NOT NULL,
      is_demo BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS episodes (
      id BIGSERIAL PRIMARY KEY,
      drama_id BIGINT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      season INT NOT NULL CHECK (season BETWEEN 1 AND 99),
      number INT NOT NULL CHECK (number BETWEEN 1 AND 999),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
      minutes INT CHECK (minutes IS NULL OR (minutes BETWEEN 1 AND 600)),
      watch_url TEXT CHECK (watch_url IS NULL OR watch_url LIKE 'https://%'),
      added_by_id BIGINT NOT NULL,
      added_by_username TEXT NOT NULL,
      is_demo BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (drama_id, season, number)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      drama_id BIGINT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, drama_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watches (
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      watched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, episode_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_id BIGINT NOT NULL,
      reporter_username TEXT NOT NULL,
      drama_id BIGINT REFERENCES dramas(id) ON DELETE SET NULL,
      episode_id BIGINT REFERENCES episodes(id) ON DELETE SET NULL,
      reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Phase 4a: comments (one level of replies), their likes, and drama
  // reviews. Each stores one person's own content, so each is
  // staging:private like follows/watches/reports. They reference only the
  // public dramas/episodes tables, so the public-to-private rule is not
  // triggered.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id BIGSERIAL PRIMARY KEY,
      episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
      reply_to_username TEXT,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS comments_thread_idx
    ON comments (episode_id, parent_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS comments_user_idx
    ON comments (user_id, episode_id, created_at)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      user_id BIGINT NOT NULL,
      comment_id BIGINT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, comment_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      drama_id BIGINT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      note TEXT CHECK (note IS NULL OR length(note) <= 280),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (drama_id, user_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS reviews_drama_idx
    ON reviews (drama_id, created_at DESC)`);
  // A report may now name a comment; nullable, so existing rows keep working.
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS
    comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE`);
  // staging:private copies the schema to staging without the rows.
  await pool.query(`COMMENT ON TABLE follows IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE watches IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE comments IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE comment_likes IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE reviews IS 'staging:private'`);

  // VIP: each episode is Free, VIP or Free with ads (decided server-side, see
  // gateEpisode); subscriptions, payments and coupons back the VIP plans.
  await pool.query(`
    ALTER TABLE episodes ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'free'
      CHECK (access IN ('free', 'vip', 'ads'))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
      value INTEGER NOT NULL,
      max_uses INTEGER,
      uses_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL CHECK (plan_id IN ('monthly', 'quarterly', 'yearly')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'canceled')),
      provider TEXT NOT NULL DEFAULT 'stripe',
      provider_ref TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      renewal_date TIMESTAMPTZ NOT NULL,
      canceled_at TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_ref TEXT,
      amount_idr INTEGER NOT NULL,
      discount_idr INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT,
      method TEXT NOT NULL DEFAULT 'card',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id)`);
  // Payment history and who pays for what are financial records about a
  // person: both tables are private (schema copied to staging, no rows).
  await pool.query(`COMMENT ON TABLE subscriptions IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE payments IS 'staging:private'`);
}

// ── Demo seed (staging only) ─────────────────────────────────────────────
// Five made-up dramas added by fake members (Priya, Sam, Jun), with their
// episodes and who has watched them. Fixed ids and ON CONFLICT DO NOTHING,
// so a reload changes nothing and what the viewer does to them stays.
// Nothing here runs in production, and every response without ?demo=1
// leaves is_demo rows out, so the plain route stays production-shaped.

const DEMO_USERS = { Priya: 7100001, Sam: 7100002, Jun: 7100003 };

const DEMO_DRAMAS = [
  { id: 900001, title: 'Harbour Lights', synopsis: 'A ferry town keeps its secrets one tide at a time.', by: 'Sam' },
  { id: 900002, title: 'The Quiet Wing', synopsis: 'A hospital ward at night, where the staff know more than they say.', by: 'Priya' },
  { id: 900003, title: 'Ninth Street', synopsis: 'One block, nine doors, and every one of them locked for a reason.', by: 'Jun' },
  { id: 900004, title: 'Meridian Court', synopsis: "The tenants' association gets a new chair, and the minutes stop adding up.", by: 'Priya' },
  { id: 900005, title: 'Copper Hill', synopsis: 'Two families, one mine, and the seam that decides both.', by: 'Jun' },
];

// [dramaId, season, number, title, minutes]
const DEMO_EPISODES = [
  // Harbour Lights: season 1 done, season 2 up to episode 9.
  [900001, 1, 1, 'The First Tide', 46], [900001, 1, 2, 'Low Water', 48], [900001, 1, 3, 'The Ferryman', 44],
  [900001, 1, 4, 'Salt Return', 47], [900001, 1, 5, 'The Harbourmaster', 50], [900001, 1, 6, 'Cold Moorings', 45],
  [900001, 2, 1, 'New Signals', 49], [900001, 2, 2, 'The Weighing', 51], [900001, 2, 3, 'Night Passage', 46],
  [900001, 2, 4, 'Flotsam', 48], [900001, 2, 5, 'Undertow', 48],
  [900001, 2, 6, 'The Tide Table', 52],
  [900001, 2, 7, 'The Long Way Round', 50],
  [900001, 2, 8, 'Salt and Iron', 47],
  [900001, 2, 9, 'Last Ferry', 53],
  // The Quiet Wing: 1 season of 8.
  [900002, 1, 1, 'Admissions', 44], [900002, 1, 2, 'Night Rounds', 42],
  [900002, 1, 3, 'The Weatherman', 45], [900002, 1, 4, 'Visiting Hours', 43],
  [900002, 1, 5, 'Paperwork', 40], [900002, 1, 6, 'The Quiet Wing', 46],
  [900002, 1, 7, 'Discharge', 42], [900002, 1, 8, 'Handover', 47],
  // Ninth Street: 3 seasons; its newest episode was added this week.
  [900003, 1, 1, 'Doors', 41], [900003, 1, 2, 'The Landlord', 39], [900003, 1, 3, 'Number Nine', 44],
  [900003, 2, 1, 'New Tenants', 42], [900003, 2, 2, 'The Basement', 40], [900003, 2, 3, 'Complaints', 38],
  [900003, 3, 1, 'The Locksmith', 43], [900003, 3, 2, 'Keys', 39],
  [900003, 3, 3, 'The Ninth Door', 46],
  // Meridian Court: 1 season of 10.
  [900004, 1, 1, 'The New Chair', 45], [900004, 1, 2, 'Minutes', 43], [900004, 1, 3, 'The Fire Drill', 44],
  [900004, 1, 4, 'Subsidence', 46], [900004, 1, 5, 'The Vote', 42], [900004, 1, 6, 'Lift Maintenance', 40],
  [900004, 1, 7, 'The Roof Garden', 45], [900004, 1, 8, 'Ballot Boxes', 43], [900004, 1, 9, 'The Audit', 47],
  [900004, 1, 10, 'Extraordinary Meeting', 49],
  // Copper Hill: 2 seasons, 14 in season 2. The viewer has watched all.
  [900005, 1, 1, 'The Seam', 52], [900005, 1, 2, 'Pit Rules', 48], [900005, 1, 3, 'The Weighbridge', 50],
  [900005, 1, 4, 'Copper Dust', 47], [900005, 1, 5, 'The Shaft', 53], [900005, 1, 6, 'Strike Notice', 49],
  [900005, 1, 7, 'The Long Wall', 51],
  [900005, 2, 1, 'After the Strike', 48], [900005, 2, 2, 'The New Foreman', 50], [900005, 2, 3, 'Overtime', 46],
  [900005, 2, 4, 'The Company House', 52], [900005, 2, 5, 'Hazard', 49], [900005, 2, 6, 'Ventilation', 47],
  [900005, 2, 7, 'Deep Level', 54], [900005, 2, 8, 'The Lamping', 48], [900005, 2, 9, 'Cold Storage', 46],
  [900005, 2, 10, 'The Union Board', 50], [900005, 2, 11, 'Winding Gear', 49], [900005, 2, 12, 'A Thin Seam', 51],
  [900005, 2, 13, 'Copper and Ash', 48], [900005, 2, 14, 'The Last Shift', 55],
];

// Who has watched what, as [dramaId, season, number] lists, and who follows
// which drama.
const DEMO_WATCHES = {
  Priya: [
    [900001, 1, 1], [900001, 1, 2], [900001, 1, 3], [900001, 1, 4], [900001, 1, 5], [900001, 1, 6],
    [900001, 2, 1], [900001, 2, 2], [900001, 2, 3], [900001, 2, 4], [900001, 2, 5], [900001, 2, 6],
    [900002, 1, 1], [900002, 1, 2], [900002, 1, 3],
    [900004, 1, 1], [900004, 1, 2], [900004, 1, 3], [900004, 1, 4],
  ],
  Sam: [
    [900001, 1, 1], [900001, 1, 2], [900001, 1, 3], [900001, 1, 4], [900001, 1, 5], [900001, 1, 6],
    [900001, 2, 1], [900001, 2, 2], [900001, 2, 3], [900001, 2, 4], [900001, 2, 5], [900001, 2, 6], [900001, 2, 7],
    [900004, 1, 1], [900004, 1, 2], [900004, 1, 3], [900004, 1, 4], [900004, 1, 5],
    [900005, 1, 1], [900005, 1, 2], [900005, 1, 3],
  ],
  Jun: [
    [900003, 1, 1], [900003, 1, 2], [900003, 1, 3], [900003, 2, 1], [900003, 2, 2], [900003, 2, 3],
    [900003, 3, 1], [900003, 3, 2], [900003, 3, 3],
    [900005, 1, 1], [900005, 1, 2],
  ],
};
const DEMO_FOLLOWS = [
  ['Priya', 900001], ['Priya', 900002], ['Priya', 900004],
  ['Sam', 900001], ['Sam', 900005],
  ['Jun', 900003], ['Jun', 900005],
];

async function seedDemo() {
  for (const d of DEMO_DRAMAS) {
    await pool.query(
      `INSERT INTO dramas (id, title, synopsis, added_by_id, added_by_username, is_demo, created_at)
       VALUES ($1, $2, $3, $4, $5, true, now() - interval '30 days')
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.title, d.synopsis, DEMO_USERS[d.by], d.by]
    );
  }
  // Fixed episode ids (9000001 upward in a fixed order), so the watches
  // below resolve and a re-seed after a partial boot still lands.
  let n = 9000001;
  for (const [dramaId, season, number, title, minutes] of DEMO_EPISODES) {
    const by = dramaId === 900002 ? 'Priya' : dramaId === 900003 ? 'Jun' : 'Sam';
    await pool.query(
      `INSERT INTO episodes (id, drama_id, season, number, title, minutes, added_by_id, added_by_username, is_demo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now() - interval '30 days')
       ON CONFLICT (id) DO NOTHING`,
      [n, dramaId, season, number, title, minutes, DEMO_USERS[by], by]
    );
    // Ninth Street's newest episode was added this week ("New episode").
    if (dramaId === 900003 && season === 3 && number === 3) {
      await pool.query(`UPDATE episodes SET created_at = now() - interval '2 days' WHERE id = $1`, [n]);
    }
    n++;
  }
  // Access levels for the demo episodes: Harbour Lights season 2 mixes VIP
  // and ad episodes, The Quiet Wing is all VIP, Meridian Court has ads.
  await pool.query(`UPDATE episodes SET access = 'vip' WHERE is_demo AND (
    (drama_id = 900001 AND season = 2 AND number = 6) OR drama_id = 900002)`);
  await pool.query(`UPDATE episodes SET access = 'ads' WHERE is_demo AND (
    (drama_id = 900001 AND season = 2 AND number = 8) OR drama_id = 900004)`);
  const eps = await pool.query(`SELECT id, drama_id, season, number FROM episodes WHERE is_demo = true`);
  const byKey = new Map(eps.rows.map(r => [r.drama_id + ':' + r.season + ':' + r.number, r.id]));
  for (const [name, uid] of Object.entries(DEMO_USERS)) {
    for (const [dramaId, season, number] of DEMO_WATCHES[name]) {
      const epId = byKey.get(dramaId + ':' + season + ':' + number);
      if (!epId) continue;
      await pool.query(
        `INSERT INTO watches (user_id, username, episode_id, watched_at)
         VALUES ($1, $2, $3, now() - interval '20 days') ON CONFLICT DO NOTHING`,
        [uid, name, epId]
      );
    }
  }
  for (const [name, dramaId] of DEMO_FOLLOWS) {
    await pool.query(
      `INSERT INTO follows (user_id, username, drama_id, created_at)
       VALUES ($1, $2, $3, now() - interval '10 days') ON CONFLICT DO NOTHING`,
      [DEMO_USERS[name], name, dramaId]
    );
  }
  await seedDemoCommunity();
}

// Phase 4a demo rows: comments, likes and reviews on the demo dramas, with
// fixed ids so a re-seed after a partial boot still lands and nothing is
// duplicated. Fake identities only (Priya, Sam, Jun); nothing here runs in
// production, and every response without ?demo=1 leaves is_demo episodes'
// comments out of sight — the plain route stays production-shaped.
const DEMO_COMMENTS = [
  // Harbour Lights, "The Harbourmaster" (9000005): a thread and a liked one.
  [9500001, 9000005, 'Priya', null, null, 'The harbourmaster knew all along, I am sure of it.', '4 days'],
  [9500002, 9000005, 'Sam', 9500001, 'Priya', 'Wait for episode 8, the salt return scene says it.', '3 days'],
  [9500003, 9000005, 'Jun', null, null, 'That last scene on the ferry was perfect.', '2 days'],
  [9500004, 9000005, 'Sam', null, null, 'Watched twice now and it holds up.', '1 day'],
  // Copper Hill, "After the Strike" (9000050): a second thread.
  [9500005, 9000050, 'Sam', null, null, 'The new foreman is my favourite character already.', '5 days'],
  [9500006, 9000050, 'Jun', null, null, 'Nobody is talking about the weighbridge scene? Come on.', '5 days'],
  // The Quiet Wing, "Admissions" (9000016).
  [9500007, 9000016, 'Priya', null, null, 'What an opening hour. Quiet and unsettling.', '6 days'],
];
const DEMO_COMMENT_LIKES = [
  ['Priya', 9500004], ['Jun', 9500004],          // Sam's comment: 2 likes
  ['Sam', 9500001], ['Jun', 9500001],
  ['Priya', 9500006], ['Sam', 9500007],
];
const DEMO_REVIEWS = [
  // Harbour Lights: average 4.3 from 3 reviews.
  ['Priya', 900001, 5, 'Staging demo: best thing we have watched together.', '3 days'],
  ['Sam', 900001, 4, 'Staging demo: slow start, great last three episodes.', '2 days'],
  ['Jun', 900001, 4, null, '1 day'],
  // Meridian Court: a single 3-star review, no note.
  ['Priya', 900004, 3, null, '4 days'],
];

async function seedDemoCommunity() {
  for (const [id, episodeId, by, parentId, replyTo, body, ago] of DEMO_COMMENTS) {
    await pool.query(
      `INSERT INTO comments (id, episode_id, user_id, username, parent_id, reply_to_username, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - $8::interval) ON CONFLICT (id) DO NOTHING`,
      [id, episodeId, DEMO_USERS[by], by, parentId, replyTo, body, ago]
    );
  }
  for (const [name, commentId] of DEMO_COMMENT_LIKES) {
    await pool.query(
      `INSERT INTO comment_likes (user_id, comment_id, created_at)
       VALUES ($1, $2, now() - interval '1 day') ON CONFLICT DO NOTHING`,
      [DEMO_USERS[name], commentId]
    );
  }
  for (const [name, dramaId, rating, note, ago] of DEMO_REVIEWS) {
    await pool.query(
      `INSERT INTO reviews (drama_id, user_id, username, rating, note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - $6::interval, now() - $6::interval)
       ON CONFLICT (drama_id, user_id) DO NOTHING`,
      [dramaId, DEMO_USERS[name], name, rating, note, ago]
    );
  }
}

// On the first ?demo=1 request of the viewing account, write its follows and
// watches on the demo dramas, once, with fixed keys. The viewer follows
// Harbour Lights and The Quiet Wing, has watched Harbour Lights season 2 up
// to episode 5, and all of Copper Hill. Idempotent: a reload changes
// nothing, and what the viewer does to them stays.
async function seedDemoViewer(user) {
  // Follow times are set so Harbour Lights sorts before The Quiet Wing in
  // Next to watch (its latest watch is the most recent of the two).
  await pool.query(
    `INSERT INTO follows (user_id, username, drama_id, created_at)
     VALUES ($1, $2, 900001, now() - interval '3 days') ON CONFLICT DO NOTHING`,
    [user.id, user.username]
  );
  await pool.query(
    `INSERT INTO follows (user_id, username, drama_id, created_at)
     VALUES ($1, $2, 900002, now() - interval '3 hours') ON CONFLICT DO NOTHING`,
    [user.id, user.username]
  );
  const eps = await pool.query(`SELECT id, drama_id, season, number FROM episodes WHERE is_demo = true`);
  const byKey = new Map(eps.rows.map(r => [r.drama_id + ':' + r.season + ':' + r.number, r.id]));
  const put = (epId, ago) => pool.query(
    `INSERT INTO watches (user_id, username, episode_id, watched_at)
     VALUES ($1, $2, $3, now() - $4::interval) ON CONFLICT DO NOTHING`,
    [user.id, user.username, epId, ago]
  );
  // Harbour Lights: season 1 done, season 2 up to and including episode 5.
  for (let number = 1; number <= 6; number++) {
    const epId = byKey.get('900001:1:' + number);
    if (epId) await put(epId, '2 days');
  }
  for (let number = 1; number <= 5; number++) {
    const epId = byKey.get('900001:2:' + number);
    if (epId) await put(epId, '2 hours');
  }
  // All of Copper Hill.
  for (const row of eps.rows) {
    if (String(row.drama_id) === '900005') await put(row.id, '5 days');
  }
  // Phase 4a: the viewer's own demo comment and review, once, with fixed
  // ids/keys, so "Delete" and "Your review" can be seen on the demo route.
  await pool.query(
    `INSERT INTO comments (id, episode_id, user_id, username, body, created_at)
     VALUES (9500099, 9000005, $1, $2, 'Calling it now: the tide table is a map.', now() - interval '1 hour')
     ON CONFLICT (id) DO NOTHING`,
    [user.id, user.username]
  );
  await pool.query(
    `INSERT INTO reviews (drama_id, user_id, username, rating, note, created_at, updated_at)
     VALUES (900005, $1, $2, 5, 'Staging demo: the last shift got me.', now() - interval '1 day', now() - interval '1 day')
     ON CONFLICT (drama_id, user_id) DO NOTHING`,
    [user.id, user.username]
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

// ?demo=1 (staging only) turns the demo rows on; without it every is_demo
// row is left out, so the plain route stays production-shaped.
function demoOn(req) {
  return IS_STAGING && req.query.demo === '1';
}
// A parameterised "leave the demo rows out unless ?demo=1" clause: the
// boolean column `col` of the table in scope, and the next $n parameter.
function demoClause(req, col, n) {
  return `($${n} OR NOT ${col})`;
}
function demoParams(req) {
  return [demoOn(req)];
}

// Opaque pagination cursor for the newest-first comment and review pages:
// "<created_at ISO>|<id>" in base64. The client passes it back unchanged; it
// never parses it. Postgres compares the pair row-wise, so rows that share a
// timestamp keep a stable order.
function encodeCursor(row) {
  return Buffer.from(row.created_at.toISOString() + '|' + row.id).toString('base64');
}
function decodeCursor(raw) {
  try {
    const parts = Buffer.from(String(raw), 'base64').toString('utf8').split('|');
    const t = new Date(parts[0]);
    const id = Number(parts[1]);
    if (isNaN(t.getTime()) || !Number.isFinite(id)) return null;
    return { t, id };
  } catch { return null; }
}

// Next to watch: among the viewer's follows (demo dramas excluded on the
// plain route), ordered by their latest watch in that drama (else the follow
// time), the first drama with an unwatched episode. The hero is its lowest
// unwatched (season, number), with up to 3 later unwatched episodes of that
// season.
async function nextToWatch(userId, demo) {
  const res = await pool.query(
    `SELECT f.drama_id,
            MAX(COALESCE(w.watched_at, f.created_at)) AS latest
       FROM follows f
       JOIN dramas d ON d.id = f.drama_id
       LEFT JOIN watches w ON w.user_id = f.user_id
        AND w.episode_id IN (SELECT id FROM episodes WHERE drama_id = f.drama_id
                              AND ($2 OR NOT is_demo))
      WHERE f.user_id = $1 AND ($2 OR NOT d.is_demo)
      GROUP BY f.drama_id
      ORDER BY latest DESC`,
    [userId, demo]
  );
  for (const row of res.rows) {
    const un = await pool.query(
      `SELECT id, season, number, title, minutes, watch_url, access
         FROM episodes
        WHERE drama_id = $1 AND ($3 OR NOT is_demo) AND NOT EXISTS (
          SELECT 1 FROM watches WHERE user_id = $2 AND episode_id = episodes.id)
        ORDER BY season, number LIMIT 1`,
      [row.drama_id, userId, demo]
    );
    if (!un.rows.length) continue;
    const hero = un.rows[0];
    const later = await pool.query(
      `SELECT id, season, number, title, minutes, watch_url, access
         FROM episodes
        WHERE drama_id = $1 AND season = $2 AND number > $3 AND ($5 OR NOT is_demo)
          AND NOT EXISTS (SELECT 1 FROM watches WHERE user_id = $4 AND episode_id = episodes.id)
        ORDER BY number LIMIT 3`,
      [row.drama_id, hero.season, hero.number, userId, demo]
    );
    return { dramaId: Number(row.drama_id), hero, later: later.rows };
  }
  return null;
}

// On the first ?demo=1 request of the viewing account, write its demo
// follows and watches (see seedDemoViewer). Awaited so the same request's
// answers already carry them; the follow check makes later calls cheap.
app.use('/api/', async (req, res, next) => {
  try {
    if (demoOn(req) && req.user) {
      const has = await pool.query(
        `SELECT 1 FROM follows WHERE user_id = $1 AND drama_id = 900001`, [req.user.id]
      );
      if (!has.rows.length) await seedDemoViewer(req.user);
    }
  } catch (err) {
    console.error('demo viewer seed failed', err);
  }
  next();
});

// ── Staging seed for VIP ──────────────────────────────────────────────────
// Staging containers boot with empty copies of the private tables, so seed
// the data the testing steps reference: obviously fake, fake identities only,
// idempotent, and never a signal the app's own logic reads about the person
// opening the preview (the seeded subscriptions belong to named fixture
// accounts, not to whoever opens it). Demo episodes get their access levels
// in seedDemo.
async function seedStagingVip() {
  const guard = await pool.query(`SELECT 1 FROM coupons WHERE code = 'STAGE10'`);
  if (guard.rows.length) return;
  const now = new Date();
  await pool.query(
    `INSERT INTO coupons (code, kind, value, max_uses, uses_count, expires_at, active)
     VALUES ('STAGE10', 'percent', 10, 50, 0, '2027-01-01T00:00:00Z', true)
     ON CONFLICT (code) DO NOTHING`
  );
  // The three subscription states, on the shots' fixture accounts (never on
  // whoever opens the preview): active, canceled-still-VIP, expired.
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan_id, status, provider, provider_ref, started_at, renewal_date, canceled_at) VALUES
      ('usernode-capture', 'monthly', 'active', 'stripe', 'staging-demo-sub-1', $1, $2, NULL),
      ('usernode-capture-admin', 'quarterly', 'canceled', 'stripe', 'staging-demo-sub-2', $3, $4, $5),
      ('usernode-shots-full-admin', 'yearly', 'expired', 'stripe', 'staging-demo-sub-3', $6, $7, NULL)`,
    [
      addDays(now, -10), addDays(now, 30),
      addDays(now, -20), addDays(now, 20), addDays(now, -1),
      addDays(now, -40), addDays(now, -10),
    ]
  );
  await pool.query(
    `INSERT INTO payments (user_id, plan_id, provider, provider_ref, amount_idr, discount_idr, coupon_code, method, status, created_at, paid_at) VALUES
      ('usernode-capture', 'monthly', 'stripe', 'staging-demo-pay-1', 53100, 5900, 'STAGE10', 'card', 'paid', '2026-09-15T09:00:00Z', '2026-09-15T09:00:10Z'),
      ('usernode-capture', 'monthly', 'stripe', 'staging-demo-pay-2', 59000, 0, NULL, 'card', 'paid', '2026-10-15T09:00:00Z', '2026-10-15T09:00:10Z'),
      ('usernode-capture', 'yearly', 'stripe', 'staging-demo-pay-3', 499000, 0, NULL, 'ewallet', 'pending', '2026-10-12T14:00:00Z', NULL)`
  );
}

// ── API routes ────────────────────────────────────────────────────────────

// Who is signed in, if anyone (the page asks, not the URL: at the app's own
// address there is no ?token= for the frontend to read).
app.get('/api/me', (req, res) => {
  res.json({
    user: req.user ? { id: req.user.id, username: req.user.username } : null,
    guest: !!req.guest,
  });
});

app.get('/api/feed', async (req, res) => {
  try {
    const demo = demoOn(req);
    const viewerId = req.user ? req.user.id : null;
    const viewerName = req.user ? req.user.username : null;
    const vip = (await vipStatus(req)).vip;
    // Dramas newest first.
    const dramas = await pool.query(
      `SELECT id, title, synopsis, added_by_id, added_by_username, created_at
         FROM dramas WHERE ${demoClause(req, 'is_demo', 1)}
        ORDER BY created_at DESC, id DESC`,
      demoParams(req)
    );
    const ids = dramas.rows.map(d => d.id);

    // Season and episode counts.
    const counts = ids.length ? await pool.query(
      `SELECT drama_id, COUNT(*) AS episodes, COUNT(DISTINCT season) AS seasons,
              COUNT(*) FILTER (WHERE access = 'vip') AS vip_count,
              COUNT(*) FILTER (WHERE access = 'ads') AS ads_count
         FROM episodes WHERE ${demoClause(req, 'is_demo', 1)} AND drama_id = ANY($2)
        GROUP BY drama_id`, [...demoParams(req), ids]
    ) : { rows: [] };
    const countBy = new Map(counts.rows.map(c => [c.drama_id, c]));

    // The viewer's follows.
    let followed = new Set();
    if (viewerId && ids.length) {
      const f = await pool.query(
        `SELECT drama_id FROM follows WHERE user_id = $1 AND drama_id = ANY($2)
          AND ($3 OR NOT EXISTS (SELECT 1 FROM dramas d WHERE d.id = drama_id AND d.is_demo))`,
        [viewerId, ids, demo]
      );
      followed = new Set(f.rows.map(r => Number(r.drama_id)));
    }

    // Episodes per drama, with who has watched each (for the notes).
    let eps = { rows: [] };
    if (ids.length) {
      eps = await pool.query(
        `SELECT e.id, e.drama_id, e.season, e.number,
                ARRAY(SELECT w.username FROM watches w WHERE w.episode_id = e.id
                      ORDER BY w.watched_at) AS watchers,
                EXISTS (SELECT 1 FROM watches w WHERE w.episode_id = e.id AND w.user_id = $3) AS viewer_watched,
                (e.created_at > now() - interval '7 days') AS is_new
           FROM episodes e
          WHERE ${demoClause(req, 'e.is_demo', 1)} AND e.drama_id = ANY($2)`,
        [...demoParams(req), ids, viewerId || 0]
      );
    }
    const epsBy = new Map();
    for (const e of eps.rows) {
      if (!epsBy.has(Number(e.drama_id))) epsBy.set(Number(e.drama_id), []);
      epsBy.get(Number(e.drama_id)).push(e);
    }

    let next = null;
    if (viewerId && followed.size) next = await nextToWatch(viewerId, demo);

    const out = dramas.rows.map(d => {
      const c = countBy.get(d.id) || { episodes: 0, seasons: 0, vip_count: 0, ads_count: 0 };
      const dramaEps = epsBy.get(Number(d.id)) || [];
      // The season the viewer is on: that of their latest watched episode
      // there, else the lowest season.
      const watchedEps = dramaEps.filter(e => e.viewer_watched);
      const currentSeason = watchedEps.length
        ? watchedEps[watchedEps.length - 1].season
        : (dramaEps.length ? Math.min(...dramaEps.map(e => e.season)) : null);
      const seasonEps = currentSeason !== null ? dramaEps.filter(e => e.season === currentSeason) : [];
      const seasonWatched = seasonEps.filter(e => e.viewer_watched).length;
      const finished = Number(c.episodes) > 0 && watchedEps.length === dramaEps.length;
      // The one note, in priority order: your progress through the season
      // you are on (shown as its bar), a new episode this week you have not
      // watched, that you finished it, or who else has watched it.
      let note;
      if (Number(c.episodes) === 0) note = { kind: 'none', text: 'No episodes yet' };
      else if (followed.has(Number(d.id)) && seasonEps.length) {
        note = { kind: 'progress', text: `${seasonWatched} of ${seasonEps.length} watched this season`, pct: seasonWatched / seasonEps.length };
      } else if (dramaEps.some(e => e.is_new && !e.viewer_watched)) {
        note = { kind: 'new', text: 'New episode' };
      } else if (finished) {
        note = { kind: 'finished', text: 'You finished it' };
      } else {
        const names = dramaEps.flatMap(e => e.watchers)
          .filter(u => u !== viewerName)
          .filter((u, i, a) => a.indexOf(u) === i).slice(0, 3);
        note = names.length
          ? { kind: 'others', text: names.length === 1 ? `Watched by ${names[0]}`
              : names.length === 2 ? `Watched by ${names[0]} and ${names[1]}`
              : `Watched by ${names[0]}, ${names[1]} and ${names.length - 2} more` }
          : { kind: 'none', text: '' };
      }
      return {
        id: Number(d.id), title: d.title, synopsis: d.synopsis,
        added_by_username: d.added_by_username,
        seasons: Number(c.seasons), episodes: Number(c.episodes),
        following: followed.has(Number(d.id)),
        // Drama-level chip: VIP wins if any episode is VIP, then ads, then free.
        access_label: Number(c.vip_count) > 0 ? 'VIP' : (Number(c.ads_count) > 0 ? 'Free with ads' : 'Free'),
        mine: req.user && Number(d.added_by_id) === Number(req.user.id),
        note,
      };
    });

    // The hero and its upcoming episodes, when there is a next to watch.
    if (next) {
      const heroDrama = dramas.rows.find(d => Number(d.id) === next.dramaId);
      const dramaEps = epsBy.get(next.dramaId) || [];
      const seasonEps = dramaEps.filter(e => e.season === next.hero.season);
      const seasonWatched = seasonEps.filter(e => e.viewer_watched).length;
      const heroRow = dramaEps.find(e => e.id === next.hero.id);
      next.dramaTitle = heroDrama ? heroDrama.title : '';
      next.following = followed.has(next.dramaId);
      next.season = next.hero.season;
      next.progress = seasonEps.length ? { watched: seasonWatched, total: seasonEps.length } : null;
      next.hero = gateEpisode(next.hero, vip);
      next.hero.watched_by = heroRow ? heroRow.watchers : [];
      next.upcoming = next.later.map(e => ({
        ...gateEpisode(e, vip),
        watched_by: (dramaEps.find(x => x.id === e.id) || {}).watchers || [],
      }));
      delete next.hero.season;
      delete next.later;
    }
    return res.json({ vip, dramas: out, next });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Feed failed to load' });
  }
});

app.post('/api/dramas', async (req, res) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const synopsis = typeof req.body.synopsis === 'string' ? req.body.synopsis.trim() : '';
    if (!title || title.length > 80) return res.status(400).json({ error: 'A title of 1 to 80 characters is required' });
    if (synopsis.length > 280) return res.status(400).json({ error: 'The description must be 280 characters or fewer' });
    const r = await pool.query(
      `INSERT INTO dramas (title, synopsis, added_by_id, added_by_username)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, synopsis || null, req.user.id, req.user.username]
    );
    return res.status(201).json({ drama: r.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not add the drama' });
  }
});

app.delete('/api/dramas/:id', async (req, res) => {
  try {
    const d = await pool.query(`SELECT added_by_id FROM dramas WHERE id = $1`, [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    if (Number(d.rows[0].added_by_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who added it can remove it' });
    }
    await pool.query(`DELETE FROM dramas WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not remove the drama' });
  }
});

app.get('/api/dramas/:id', async (req, res) => {
  try {
    const viewerId = req.user ? req.user.id : null;
    const vip = (await vipStatus(req)).vip;
    const d = await pool.query(
      `SELECT id, title, synopsis, added_by_id, added_by_username, created_at
         FROM dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    const drama = d.rows[0];
    const eps = await pool.query(
      `SELECT e.id, e.season, e.number, e.title, e.minutes, e.watch_url, e.access,
              e.added_by_id, e.added_by_username,
              ARRAY(SELECT w.username FROM watches w WHERE w.episode_id = e.id
                    ORDER BY w.watched_at) AS watched_by,
              EXISTS (SELECT 1 FROM watches w WHERE w.episode_id = e.id AND w.user_id = $3) AS viewer_watched
         FROM episodes e WHERE e.drama_id = $1 AND ${demoClause(req, 'e.is_demo', 2)}
        ORDER BY e.season, e.number`,
      [req.params.id, ...demoParams(req), viewerId || 0]
    );
    const following = viewerId
      ? (await pool.query(`SELECT 1 FROM follows WHERE user_id = $1 AND drama_id = $2`, [viewerId, req.params.id])).rows.length > 0
      : false;
    // The average rating rides this response (one aggregate), and the first
    // page of reviews does too, so the drama page needs no extra round-trip;
    // more pages come from GET /api/dramas/:id/reviews.
    const rating = await pool.query(
      `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg FROM reviews WHERE drama_id = $1`,
      [req.params.id]
    );
    const revs = await pool.query(
      `SELECT r.user_id, r.username, r.rating, r.note, r.created_at
         FROM reviews r WHERE r.drama_id = $1
        ORDER BY r.created_at DESC, r.user_id DESC LIMIT 20`,
      [req.params.id]
    );
    const ratingCount = Number(rating.rows[0].count);
    const ratingAvgRaw = rating.rows[0].avg == null ? null : Number(rating.rows[0].avg);
    const reviews = revs.rows.map(r => ({
      user_id: Number(r.user_id), username: r.username, rating: Number(r.rating),
      note: r.note, created_at: r.created_at,
      mine: !!(req.user && Number(r.user_id) === Number(req.user.id)),
    }));
    const reviewCursor = revs.rows.length === 20 ? encodeCursor(revs.rows[19]) : null;
    // The viewer's own review even when it sits beyond the first page, so
    // the Rate button can read "Your review".
    let myReview = null;
    if (viewerId) {
      const mine = await pool.query(
        `SELECT user_id, username, rating, note, created_at FROM reviews
          WHERE drama_id = $1 AND user_id = $2`,
        [req.params.id, viewerId]
      );
      if (mine.rows.length) {
        const m = mine.rows[0];
        myReview = {
          user_id: Number(m.user_id), username: m.username, rating: Number(m.rating),
          note: m.note, created_at: m.created_at, mine: true,
        };
      }
    }
    // Episodes grouped by season for the season control.
    const seasons = new Map();
    for (const e of eps.rows) {
      if (!seasons.has(e.season)) seasons.set(e.season, []);
      seasons.get(e.season).push(e);
    }
    return res.json({
      vip,
      drama: {
        ...drama, id: Number(drama.id), mine: req.user && Number(drama.added_by_id) === Number(req.user.id),
        rating_avg: ratingAvgRaw === null ? null : Math.round(ratingAvgRaw * 10) / 10,
        rating_count: ratingCount,
      },
      seasons: [...seasons.keys()].sort((a, b) => a - b),
      episodes: eps.rows.map(e => ({ ...gateEpisode(e, vip), mine: req.user && Number(e.added_by_id) === Number(req.user.id) })),
      following,
      reviews,
      reviews_cursor: reviewCursor,
      my_review: myReview,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not load the drama' });
  }
});

app.post('/api/dramas/:id/episodes', async (req, res) => {
  try {
    const d = await pool.query(
      `SELECT id FROM dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    const season = parseInt(req.body.season, 10);
    const number = parseInt(req.body.number, 10);
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const minutes = req.body.minutes ? parseInt(req.body.minutes, 10) : null;
    const watch_url = typeof req.body.watch_url === 'string' && req.body.watch_url.trim()
      ? req.body.watch_url.trim() : null;
    if (!season || season < 1 || season > 99) return res.status(400).json({ error: 'Season must be 1 to 99' });
    if (!number || number < 1 || number > 999) return res.status(400).json({ error: 'Episode number must be 1 to 999' });
    if (!title || title.length > 80) return res.status(400).json({ error: 'A title of 1 to 80 characters is required' });
    if (minutes !== null && (minutes < 1 || minutes > 600)) return res.status(400).json({ error: 'Minutes must be 1 to 600' });
    if (watch_url && !/^https:\/\//.test(watch_url)) return res.status(400).json({ error: 'The link must start with https://' });
    const access = typeof req.body.access === 'string' && req.body.access ? req.body.access : 'free';
    if (!['free', 'vip', 'ads'].includes(access)) return res.status(400).json({ error: 'Access must be Free, VIP or Free with ads' });
    const exists = await pool.query(
      `SELECT 1 FROM episodes WHERE drama_id = $1 AND season = $2 AND number = $3`,
      [req.params.id, season, number]
    );
    if (exists.rows.length) return res.status(409).json({ error: 'That season and episode number already exists' });
    const r = await pool.query(
      `INSERT INTO episodes (drama_id, season, number, title, minutes, watch_url, access, added_by_id, added_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.params.id, season, number, title, minutes, watch_url, access, req.user.id, req.user.username]
    );
    return res.status(201).json({ episode: r.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not add the episode' });
  }
});

app.delete('/api/episodes/:id', async (req, res) => {
  try {
    const e = await pool.query(`SELECT added_by_id FROM episodes WHERE id = $1`, [req.params.id]);
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
    if (Number(e.rows[0].added_by_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who added it can remove it' });
    }
    await pool.query(`DELETE FROM episodes WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not remove the episode' });
  }
});

app.put('/api/dramas/:id/follow', async (req, res) => {
  try {
    const d = await pool.query(
      `SELECT id FROM dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    await pool.query(
      `INSERT INTO follows (user_id, username, drama_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.user.id, req.user.username, req.params.id]
    );
    return res.json({ following: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not follow' });
  }
});

app.delete('/api/dramas/:id/follow', async (req, res) => {
  try {
    await pool.query(`DELETE FROM follows WHERE user_id = $1 AND drama_id = $2`, [req.user.id, req.params.id]);
    return res.json({ following: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not unfollow' });
  }
});

app.put('/api/episodes/:id/watched', async (req, res) => {
  try {
    const e = await pool.query(`SELECT id, access FROM episodes WHERE id = $1`, [req.params.id]);
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
    // Server-side paywall: the write is refused and the answer explains why.
    if (e.rows[0].access === 'vip' && !(await vipStatus(req)).vip) {
      return res.status(403).json({ error: 'vip_required' });
    }
    await pool.query(
      `INSERT INTO watches (user_id, username, episode_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.user.id, req.user.username, req.params.id]
    );
    return res.json({ watched: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not mark watched' });
  }
});

app.delete('/api/episodes/:id/watched', async (req, res) => {
  try {
    await pool.query(`DELETE FROM watches WHERE user_id = $1 AND episode_id = $2`, [req.user.id, req.params.id]);
    return res.json({ watched: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not unmark watched' });
  }
});

// Recorded only, nothing is hidden automatically.
app.post('/api/reports', async (req, res) => {
  try {
    const dramaId = req.body.drama_id ? parseInt(req.body.drama_id, 10) : null;
    const episodeId = req.body.episode_id ? parseInt(req.body.episode_id, 10) : null;
    const commentId = req.body.comment_id ? parseInt(req.body.comment_id, 10) : null;
    if (!dramaId && !episodeId && !commentId) return res.status(400).json({ error: 'A drama, an episode or a comment is required' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
    if (reason && reason.length > 500) return res.status(400).json({ error: 'The reason must be 500 characters or fewer' });
    await pool.query(
      `INSERT INTO reports (reporter_id, reporter_username, drama_id, episode_id, comment_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, req.user.username, dramaId, episodeId, commentId, reason]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not send the report' });
  }
});

// ── Phase 4a: comments, likes, reviews ───────────────────────────────────
// Reads work for guests too (the auth middleware lets GETs through); every
// write needs a signed-in user, which the middleware already enforces.
// Comments and reviews of demo dramas/episodes stay out of the plain route
// through a join to the parent row's is_demo, since these tables carry no
// is_demo column of their own.

const COMMENTS_PER_PAGE = 20;

function commentRow(c, viewerId) {
  return {
    id: Number(c.id), user_id: Number(c.user_id), username: c.username,
    body: c.body, created_at: c.created_at,
    reply_to_username: c.reply_to_username,
    like_count: Number(c.like_count), viewer_liked: !!c.viewer_liked,
    mine: !!(viewerId && Number(c.user_id) === Number(viewerId)),
  };
}

// The filter that keeps demo threads invisible without ?demo=1: the comment's
// parent episode must not be a demo episode. $demo is the ?demo=1 flag.
const COMMENT_DEMO_FILTER = `($2 OR NOT EXISTS (
  SELECT 1 FROM episodes e WHERE e.id = c.episode_id AND e.is_demo))`;

app.get('/api/episodes/:id/comments', async (req, res) => {
  try {
    const demo = demoOn(req);
    const viewerId = req.user ? req.user.id : null;
    const ep = await pool.query(
      `SELECT id FROM episodes WHERE id = $1 AND ($2 OR NOT is_demo)`,
      [req.params.id, demo]
    );
    if (!ep.rows.length) return res.status(404).json({ error: 'Episode not found' });
    const cur = req.query.cursor ? decodeCursor(req.query.cursor) : null;
    // Top-level comments newest first, one page; the replies of that page
    // come along in the same request, oldest first.
    const top = await pool.query(
      `SELECT c.id, c.user_id, c.username, c.parent_id, c.reply_to_username,
              c.body, c.created_at,
              (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id)::int AS like_count,
              EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = $3) AS viewer_liked
         FROM comments c
        WHERE c.parent_id IS NULL AND c.episode_id = $1 AND ${COMMENT_DEMO_FILTER}
          AND (${cur ? '(c.created_at, c.id) < ($4::timestamptz, $5::bigint)' : 'true'})
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${COMMENTS_PER_PAGE + 1}`,
      cur ? [req.params.id, demo, viewerId || 0, cur.t, cur.id]
          : [req.params.id, demo, viewerId || 0]
    );
    const hasMore = top.rows.length > COMMENTS_PER_PAGE;
    const page = hasMore ? top.rows.slice(0, COMMENTS_PER_PAGE) : top.rows;
    const ids = page.map(r => r.id);
    // The replies of that page, oldest first. They share their parent's
    // episode, so no extra demo filter is needed here.
    const replies = ids.length ? await pool.query(
      `SELECT c.id, c.user_id, c.username, c.parent_id, c.reply_to_username,
              c.body, c.created_at,
              (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id)::int AS like_count,
              EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = $2) AS viewer_liked
         FROM comments c
        WHERE c.parent_id = ANY($1)
        ORDER BY c.created_at ASC, c.id ASC`,
      [ids, viewerId || 0]
    ) : { rows: [] };
    const byParent = new Map();
    for (const r of replies.rows) {
      const p = Number(r.parent_id);
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(commentRow(r, viewerId));
    }
    return res.json({
      comments: page.map(r => ({ ...commentRow(r, viewerId), replies: byParent.get(Number(r.id)) || [] })),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not load the comments' });
  }
});

app.post('/api/episodes/:id/comments', async (req, res) => {
  try {
    const demo = demoOn(req);
    const ep = await pool.query(
      `SELECT id FROM episodes WHERE id = $1 AND ($2 OR NOT is_demo)`,
      [req.params.id, demo]
    );
    if (!ep.rows.length) return res.status(404).json({ error: 'Episode not found' });
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 500) return res.status(400).json({ error: 'A comment of 1 to 500 characters is required' });
    if (isProfane(body)) return res.status(400).json({ error: 'profanity' });
    if (isSpam(body)) return res.status(400).json({ error: 'spam' });

    // A reply aims at a top-level comment: replying to a reply quietly
    // re-parents to its top-level comment, keeping one level of nesting,
    // and the @Name label names the person actually being answered.
    let parentId = null;
    let replyTo = null;
    if (req.body.parent_id) {
      const p = await pool.query(
        `SELECT id, parent_id, user_id, username FROM comments WHERE id = $1 AND episode_id = $2`,
        [req.body.parent_id, req.params.id]
      );
      if (!p.rows.length) return res.status(400).json({ error: 'The comment being replied to is gone' });
      const parent = p.rows[0];
      parentId = parent.parent_id === null ? Number(parent.id) : Number(parent.parent_id);
      replyTo = parent.username;
    }

    // At most 5 comments per person per episode per rolling minute, and no
    // sending the same normalised text again within 24 hours.
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM comments
        WHERE user_id = $1 AND episode_id = $2 AND created_at > now() - interval '1 minute'`,
      [req.user.id, req.params.id]
    );
    if (Number(recent.rows[0].n) >= 5) return res.status(429).json({ error: 'rate_limited' });
    const dupe = await pool.query(
      `SELECT body FROM comments
        WHERE user_id = $1 AND episode_id = $2 AND created_at > now() - interval '24 hours'`,
      [req.user.id, req.params.id]
    );
    if (dupe.rows.some(r => loose(r.body) === loose(body))) {
      return res.status(400).json({ error: 'spam' });
    }

    const r = await pool.query(
      `INSERT INTO comments (episode_id, user_id, username, parent_id, reply_to_username, body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, req.user.id, req.user.username, parentId, replyTo, body]
    );
    const row = r.rows[0];
    row.like_count = 0;
    row.viewer_liked = false;
    return res.status(201).json({
      comment: { ...commentRow(row, req.user.id), replies: [] },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not post the comment' });
  }
});

app.post('/api/comments/:id/like', async (req, res) => {
  try {
    const demo = demoOn(req);
    const c = await pool.query(
      `SELECT c.id FROM comments c WHERE c.id = $1 AND ${COMMENT_DEMO_FILTER}`,
      [req.params.id, demo]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Comment not found' });
    await pool.query(
      `INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.id]
    );
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM comment_likes WHERE comment_id = $1`, [req.params.id]
    );
    return res.json({ likes: Number(n.rows[0].n), liked: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not like the comment' });
  }
});

app.delete('/api/comments/:id/like', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2`,
      [req.user.id, req.params.id]
    );
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM comment_likes WHERE comment_id = $1`, [req.params.id]
    );
    return res.json({ likes: Number(n.rows[0].n), liked: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not take back the like' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    const c = await pool.query(`SELECT user_id FROM comments WHERE id = $1`, [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Comment not found' });
    if (Number(c.rows[0].user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only your own comment can be deleted' });
    }
    await pool.query(`DELETE FROM comments WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not delete the comment' });
  }
});

const REVIEWS_PER_PAGE = 20;

app.get('/api/dramas/:id/reviews', async (req, res) => {
  try {
    const d = await pool.query(
      `SELECT id FROM dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    const cur = req.query.cursor ? decodeCursor(req.query.cursor) : null;
    const rows = await pool.query(
      `SELECT r.user_id, r.username, r.rating, r.note, r.created_at
         FROM reviews r WHERE r.drama_id = $1
           AND (${cur ? '(r.created_at, r.user_id) < ($2::timestamptz, $3::bigint)' : 'true'})
        ORDER BY r.created_at DESC, r.user_id DESC
        LIMIT ${REVIEWS_PER_PAGE + 1}`,
      cur ? [req.params.id, cur.t, cur.id] : [req.params.id]
    );
    const hasMore = rows.rows.length > REVIEWS_PER_PAGE;
    const page = hasMore ? rows.rows.slice(0, REVIEWS_PER_PAGE) : rows.rows;
    const summary = await ratingSummary(req.params.id);
    return res.json({
      reviews: page.map(r => ({
        user_id: Number(r.user_id), username: r.username, rating: Number(r.rating),
        note: r.note, created_at: r.created_at,
        mine: !!(req.user && Number(r.user_id) === Number(req.user.id)),
      })),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      rating_avg: summary.rating_avg,
      rating_count: summary.rating_count,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not load the reviews' });
  }
});

// The new average and count ride every write, so the drama page updates
// without a refetch.
async function ratingSummary(dramaId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg FROM reviews WHERE drama_id = $1`,
    [dramaId]
  );
  const count = Number(r.rows[0].count);
  const avg = r.rows[0].avg == null ? null : Math.round(Number(r.rows[0].avg) * 10) / 10;
  return { rating_avg: avg, rating_count: count };
}

app.put('/api/dramas/:id/review', async (req, res) => {
  try {
    const demo = demoOn(req);
    const d = await pool.query(
      `SELECT id FROM dramas WHERE id = $1 AND ($2 OR NOT is_demo)`,
      [req.params.id, demo]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    const rating = parseInt(req.body.rating, 10);
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'A rating of 1 to 5 stars is required' });
    const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null;
    if (note && note.length > 280) return res.status(400).json({ error: 'The note must be 280 characters or fewer' });
    if (note && (isProfane(note) || isSpam(note))) return res.status(400).json({ error: isProfane(note) ? 'profanity' : 'spam' });
    const r = await pool.query(
      `INSERT INTO reviews (drama_id, user_id, username, rating, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (drama_id, user_id)
       DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note, updated_at = now()
       RETURNING *`,
      [req.params.id, req.user.id, req.user.username, rating, note]
    );
    const summary = await ratingSummary(req.params.id);
    const row = r.rows[0];
    return res.json({
      review: {
        user_id: Number(row.user_id), username: row.username, rating: Number(row.rating),
        note: row.note, created_at: row.created_at, mine: true,
      },
      ...summary,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not save the review' });
  }
});

app.delete('/api/dramas/:id/review', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM reviews WHERE drama_id = $1 AND user_id = $2`, [req.params.id, req.user.id]
    );
    const summary = await ratingSummary(req.params.id);
    return res.json({ ok: true, ...summary });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not remove the review' });
  }
});

// Unknown API routes answer JSON 404, never the HTML shell: a client
// that asked for JSON must not be handed a 200 HTML page it cannot parse.
app.use('/api/', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
// Registered LAST: a catch-all above the API routes would swallow every
// GET /api/* request and answer it with HTML, which the client cannot
// parse (the merged app's feed and drama routes live further up).
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/homeclip-73da27/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/homeclip-73da27/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ──────────────────────────────────────────────────────────────────

let server = null;

async function start() {
  // Idempotent schema on boot, then (staging only) the demo dramas.
  await ensureSchema();
  if (IS_STAGING) {
    try {
      await seedDemo();
      await seedStagingVip();
    } catch (err) {
      console.error('demo seed failed', err);
    }
  }
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting, drain about 3 s, close the pool and exit.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      server.close(() => {
        pool.end().then(() => process.exit(0));
      });
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

// Shut down cleanly: stop accepting connections, drain for ~3s, close the
// pool, exit.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(0), 3000).unref();
  try {
    if (server) server.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });

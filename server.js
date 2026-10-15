const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

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

/* ── Episode shaping: the VIP gate ──────────────────────────────────────── */

// A locked VIP episode leaves WITHOUT its watch_url, so no amount of
// client-side editing can unlock it. Ad episodes keep their watch_url but
// carry `requiresAd` so the page shows the pre-roll; VIP users never get
// the flag.
function shapeEpisode(e, vip, watchedSet) {
  const locked = e.access === 'vip' && !vip;
  return {
    id: e.id,
    number: e.number,
    title: e.title,
    durationMin: e.duration_min,
    access: e.access,
    locked,
    watched: watchedSet ? watchedSet.has(e.id) : false,
    requiresAd: e.access === 'ads' && !vip,
    watchUrl: locked ? null : (e.watch_url || null),
    seasonNumber: e.season_number,
  };
}

/* ── Content routes ─────────────────────────────────────────────────────── */

app.get('/api/feed', h(async (req, res) => {
  const uid = req.user ? req.user.id : null;
  const vip = (await vipStatus(req)).vip;

  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.description, d.added_by, d.poster_token,
            COALESCE(se.seasons_count, 0) AS seasons_count,
            COALESCE(ep.episodes_count, 0) AS episodes_count,
            COALESCE(ep.vip_count, 0) AS vip_count,
            COALESCE(ep.ads_count, 0) AS ads_count,
            COALESCE(w.watched_count, 0) AS watched_count,
            (f.user_id IS NOT NULL) AS following
     FROM dramas d
     LEFT JOIN (SELECT drama_id, count(*) AS seasons_count FROM seasons GROUP BY drama_id) se
       ON se.drama_id = d.id
     LEFT JOIN (SELECT s.drama_id, count(*) AS episodes_count,
                       count(*) FILTER (WHERE e.access = 'vip') AS vip_count,
                       count(*) FILTER (WHERE e.access = 'ads') AS ads_count
                FROM episodes e JOIN seasons s ON s.id = e.season_id
                GROUP BY s.drama_id) ep
       ON ep.drama_id = d.id
     LEFT JOIN (SELECT s.drama_id, count(*) AS watched_count
                FROM watch_records w
                JOIN episodes e ON e.id = w.episode_id
                JOIN seasons s ON s.id = e.season_id
                WHERE w.user_id = $1
                GROUP BY s.drama_id) w
       ON w.drama_id = d.id
     LEFT JOIN follows f ON f.drama_id = d.id AND f.user_id = $1
     ORDER BY d.created_at DESC, d.id DESC`,
    [uid]
  );

  const dramas = rows.map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    addedBy: d.added_by,
    posterToken: d.poster_token,
    seasonsCount: Number(d.seasons_count),
    episodesCount: Number(d.episodes_count),
    watchedCount: Number(d.watched_count),
    following: d.following,
    // Drama-level chip: VIP wins if any episode is VIP, then ads, then free.
    accessLabel: d.vip_count > 0 ? 'VIP' : (d.ads_count > 0 ? 'Free with ads' : 'Free'),
  }));

  // "Next to watch": first unwatched episode of the drama last watched;
  // with no history, the newest drama. One small set of queries, no N+1
  // over the feed.
  let hero = null;
  let heroDramaId = null;
  if (uid) {
    const last = await pool.query(
      `SELECT s.drama_id FROM watch_records w
       JOIN episodes e ON e.id = w.episode_id
       JOIN seasons s ON s.id = e.season_id
       WHERE w.user_id = $1
       ORDER BY w.watched_at DESC, w.episode_id DESC
       LIMIT 1`,
      [uid]
    );
    if (last.rows.length) heroDramaId = last.rows[0].drama_id;
  }
  if (heroDramaId == null && dramas.length) heroDramaId = dramas[0].id;
  if (heroDramaId != null) {
    const d = dramas.find((x) => x.id === heroDramaId);
    const eps = await pool.query(
      `SELECT e.id, e.number, e.title, e.duration_min, e.access, e.watch_url,
              s.id AS season_id, s.number AS season_number
       FROM episodes e JOIN seasons s ON s.id = e.season_id
       WHERE s.drama_id = $1
       ORDER BY s.number, e.number`,
      [heroDramaId]
    );
    let watchedIds = new Set();
    if (uid) {
      const w = await pool.query(
        `SELECT episode_id FROM watch_records WHERE user_id = $1`,
        [uid]
      );
      watchedIds = new Set(w.rows.map((r) => r.episode_id));
    }
    const next = eps.rows.find((e) => !watchedIds.has(e.id));
    if (next) {
      const seasonRows = eps.rows.filter((e) => e.season_id === next.season_id);
      const watchedInSeason = seasonRows.filter((e) => watchedIds.has(e.id)).length;
      const idx = eps.rows.findIndex((e) => e.id === next.id);
      hero = {
        dramaId: heroDramaId,
        dramaTitle: d ? d.title : '',
        seasonNumber: next.season_number,
        watchedInSeason,
        seasonTotal: seasonRows.length,
        episode: shapeEpisode(next, vip, watchedIds),
        upNext: eps.rows.slice(idx + 1, idx + 4).map((e) => shapeEpisode(e, vip, watchedIds)),
      };
    }
  }

  res.json({ vip, hero, dramas });
}));

app.get('/api/dramas/:id', h(async (req, res) => {
  const uid = req.user ? req.user.id : null;
  const vip = (await vipStatus(req)).vip;
  const dramaId = Number(req.params.id);
  if (!Number.isInteger(dramaId)) return res.status(400).json({ error: 'bad_id' });

  const d = await pool.query(`SELECT * FROM dramas WHERE id = $1`, [dramaId]);
  if (!d.rows.length) return res.status(404).json({ error: 'not_found' });

  const seasons = await pool.query(
    `SELECT id, number FROM seasons WHERE drama_id = $1 ORDER BY number`,
    [dramaId]
  );
  const episodes = await pool.query(
    `SELECT e.id, e.number, e.title, e.duration_min, e.access, e.watch_url,
            s.number AS season_number
     FROM episodes e JOIN seasons s ON s.id = e.season_id
     WHERE s.drama_id = $1
     ORDER BY s.number, e.number`,
    [dramaId]
  );
  let watchedIds = new Set();
  if (uid) {
    const w = await pool.query(
      `SELECT w.episode_id FROM watch_records w
       JOIN episodes e ON e.id = w.episode_id
       JOIN seasons s ON s.id = e.season_id
       WHERE w.user_id = $1 AND s.drama_id = $2`,
      [uid, dramaId]
    );
    watchedIds = new Set(w.rows.map((r) => r.episode_id));
  }
  const f = await pool.query(
    `SELECT 1 FROM follows WHERE user_id = $1 AND drama_id = $2`,
    [uid, dramaId]
  );

  const seasonsOut = seasons.rows.map((s) => ({
    id: s.id,
    number: s.number,
    episodes: episodes.rows
      .filter((e) => e.season_number === s.number)
      .map((e) => shapeEpisode(e, vip, watchedIds)),
  }));

  res.json({
    vip,
    drama: {
      id: d.rows[0].id,
      title: d.rows[0].title,
      description: d.rows[0].description,
      addedBy: d.rows[0].added_by,
      posterToken: d.rows[0].poster_token,
    },
    following: uid ? f.rows.length > 0 : false,
    seasons: seasonsOut,
  });
}));

app.post('/api/dramas', h(async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  const description = String(req.body.description || '').trim() || null;
  const n = await pool.query(`SELECT count(*)::int AS n FROM dramas`);
  const poster = ['accent', 'fg', 'muted', 'raised'][n.rows[0].n % 4];
  const d = await pool.query(
    `INSERT INTO dramas (title, description, poster_token, added_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, description, poster, req.user.username]
  );
  // Season 1 exists from the start so "Add episode" always has a home.
  await pool.query(`INSERT INTO seasons (drama_id, number) VALUES ($1, 1)`, [d.rows[0].id]);
  res.json({ ok: true, id: d.rows[0].id });
}));

app.post('/api/episodes', h(async (req, res) => {
  const dramaId = Number(req.body.dramaId);
  const title = String(req.body.title || '').trim();
  const access = String(req.body.access || 'free');
  const durationMin = Number(req.body.durationMin) || null;
  const watchUrl = String(req.body.watchUrl || '').trim() || null;
  if (!Number.isInteger(dramaId)) return res.status(400).json({ error: 'bad_drama' });
  if (!title) return res.status(400).json({ error: 'title_required' });
  if (!['free', 'vip', 'ads'].includes(access)) return res.status(400).json({ error: 'bad_access' });
  if (watchUrl && !/^https?:\/\//i.test(watchUrl)) {
    return res.status(400).json({ error: 'bad_watch_url' });
  }
  const d = await pool.query(`SELECT id FROM dramas WHERE id = $1`, [dramaId]);
  if (!d.rows.length) return res.status(404).json({ error: 'not_found' });

  // Episodes land in the drama's newest season; every drama gets one on
  // creation, so this always finds a row.
  const s = await pool.query(
    `SELECT id FROM seasons WHERE drama_id = $1 ORDER BY number DESC LIMIT 1`,
    [dramaId]
  );
  const seasonId = s.rows[0].id;
  const n = await pool.query(
    `SELECT COALESCE(MAX(number), 0) + 1 AS next FROM episodes WHERE season_id = $1`,
    [seasonId]
  );
  const e = await pool.query(
    `INSERT INTO episodes (season_id, number, title, duration_min, watch_url, access)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [seasonId, n.rows[0].next, title, durationMin, watchUrl, access]
  );
  res.json({ ok: true, id: e.rows[0].id });
}));

app.post('/api/watch', h(async (req, res) => {
  const episodeId = Number(req.body.episodeId);
  if (!Number.isInteger(episodeId)) return res.status(400).json({ error: 'bad_episode' });
  const e = await pool.query(
    `SELECT e.*, s.number AS season_number, s.drama_id FROM episodes e
     JOIN seasons s ON s.id = e.season_id WHERE e.id = $1`,
    [episodeId]
  );
  if (!e.rows.length) return res.status(404).json({ error: 'not_found' });
  const vip = (await vipStatus(req)).vip;
  const ep = e.rows[0];
  if (ep.access === 'vip' && !vip) {
    // Server-side paywall: the write is refused and the answer explains why.
    return res.status(403).json({
      error: 'vip_required',
      episode: shapeEpisode(ep, false, null),
    });
  }
  await pool.query(
    `INSERT INTO watch_records (user_id, episode_id) VALUES ($1, $2)
     ON CONFLICT (user_id, episode_id) DO NOTHING`,
    [req.user.id, episodeId]
  );
  res.json({ ok: true, episode: shapeEpisode(ep, vip, new Set([episodeId])) });
}));

app.delete('/api/watch', h(async (req, res) => {
  const episodeId = Number(req.body.episodeId);
  if (!Number.isInteger(episodeId)) return res.status(400).json({ error: 'bad_episode' });
  await pool.query(
    `DELETE FROM watch_records WHERE user_id = $1 AND episode_id = $2`,
    [req.user.id, episodeId]
  );
  res.json({ ok: true });
}));

app.post('/api/follow', h(async (req, res) => {
  const dramaId = Number(req.body.dramaId);
  if (!Number.isInteger(dramaId)) return res.status(400).json({ error: 'bad_drama' });
  const d = await pool.query(`SELECT id FROM dramas WHERE id = $1`, [dramaId]);
  if (!d.rows.length) return res.status(404).json({ error: 'not_found' });
  if (req.body.follow) {
    await pool.query(
      `INSERT INTO follows (user_id, drama_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, dramaId]
    );
  } else {
    await pool.query(
      `DELETE FROM follows WHERE user_id = $1 AND drama_id = $2`,
      [req.user.id, dramaId]
    );
  }
  res.json({ ok: true, following: Boolean(req.body.follow) });
}));

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

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
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

/* ── Schema ─────────────────────────────────────────────────────────────── */

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dramas (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      poster_token TEXT,
      added_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS seasons (
      id SERIAL PRIMARY KEY,
      drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      number INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id SERIAL PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      duration_min INTEGER,
      watch_url TEXT,
      access TEXT NOT NULL DEFAULT 'free' CHECK (access IN ('free', 'vip', 'ads')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS episodes_season_idx ON episodes(season_id);
    CREATE TABLE IF NOT EXISTS watch_records (
      user_id TEXT NOT NULL,
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      watched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS watch_records_user_idx ON watch_records(user_id);
    CREATE TABLE IF NOT EXISTS follows (
      user_id TEXT NOT NULL,
      drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, drama_id)
    );
    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
      value INTEGER NOT NULL,
      max_uses INTEGER,
      uses_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
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
    );
    CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);
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
    );
    CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id);
  `);
  // Payment history and who pays for what are financial records about a
  // person: a stranger seeing every row in a staging preview would be a
  // problem, so both tables are private (schema copied to staging, no rows).
  await pool.query(`COMMENT ON TABLE subscriptions IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE payments IS 'staging:private'`);
}

/* ── Staging seed ───────────────────────────────────────────────────────── */

// Staging containers boot with empty copies of the new tables, so seed the
// data the testing steps reference: obviously fake, fake identities only,
// idempotent, and never a signal the app's own logic reads about the person
// opening the preview (the seeded subscriptions belong to named fixture
// accounts, not to whoever opens it).
async function seedStaging() {
  const guard = await pool.query(`SELECT 1 FROM dramas WHERE id = 1`);
  if (guard.rows.length) return;
  const now = new Date();

  await pool.query(
    `INSERT INTO dramas (id, title, description, poster_token, added_by) VALUES
      (1, 'Staging demo Harbour Lights', 'A ferry town keeps its secrets one tide at a time.', 'accent', 'staging-demo-user'),
      (2, 'Staging demo Ninth Street', 'Three friends, one block, too many secrets.', 'fg', 'staging-demo-user'),
      (3, 'Staging demo The Quiet Wing', 'A hospital wing where nobody speaks above a whisper.', 'muted', 'staging-demo-user'),
      (4, 'Staging demo Meridian Court', 'The courthouse canteen sees everything.', 'raised', 'staging-demo-user')
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO seasons (id, drama_id, number) VALUES
      (1, 1, 1), (2, 1, 2), (3, 2, 1), (4, 3, 1), (5, 4, 1)
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO episodes (id, season_id, number, title, duration_min, watch_url, access) VALUES
      (1, 1, 1, 'Low Water', 48, 'https://example.com/watch/hl-s1e1', 'free'),
      (2, 1, 2, 'The Ferry Schedule', 44, 'https://example.com/watch/hl-s1e2', 'free'),
      (3, 1, 3, 'Salt in the Wound', 47, 'https://example.com/watch/hl-s1e3', 'free'),
      (4, 1, 4, 'Night Crossing', 51, 'https://example.com/watch/hl-s1e4', 'free'),
      (5, 2, 5, 'Low Water', 48, 'https://example.com/watch/hl-s2e5', 'free'),
      (6, 2, 6, 'The Tide Table', 52, 'https://example.com/watch/hl-s2e6', 'vip'),
      (7, 2, 7, 'The Long Way Round', 50, 'https://example.com/watch/hl-s2e7', 'free'),
      (8, 2, 8, 'Salt and Iron', 47, 'https://example.com/watch/hl-s2e8', 'ads'),
      (9, 2, 9, 'Last Ferry', 54, 'https://example.com/watch/hl-s2e9', 'free'),
      (10, 3, 1, 'Corner Shop', 42, 'https://example.com/watch/ns-s1e1', 'free'),
      (11, 3, 2, 'Key Cutting', 39, 'https://example.com/watch/ns-s1e2', 'free'),
      (12, 3, 3, 'The Aunt', 45, 'https://example.com/watch/ns-s1e3', 'free'),
      (13, 3, 4, 'Smoke', 41, 'https://example.com/watch/ns-s1e4', 'free'),
      (14, 4, 1, 'Admission', 46, 'https://example.com/watch/qw-s1e1', 'vip'),
      (15, 4, 2, 'Night Rounds', 44, 'https://example.com/watch/qw-s1e2', 'vip'),
      (16, 4, 3, 'Discharge', 49, 'https://example.com/watch/qw-s1e3', 'vip'),
      (17, 5, 1, 'The Verdict', 43, 'https://example.com/watch/mc-s1e1', 'ads'),
      (18, 5, 2, 'Recess', 38, 'https://example.com/watch/mc-s1e2', 'ads'),
      (19, 5, 3, 'Adjourned', 41, 'https://example.com/watch/mc-s1e3', 'ads')
     ON CONFLICT (id) DO NOTHING`
  );
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
      ('usernode-shots-full-admin', 'yearly', 'expired', 'stripe', 'staging-demo-sub-3', $6, $7, NULL)
     ON CONFLICT DO NOTHING`,
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
      ('usernode-capture', 'yearly', 'stripe', 'staging-demo-pay-3', 499000, 0, NULL, 'ewallet', 'pending', '2026-10-12T14:00:00Z', NULL)
     ON CONFLICT DO NOTHING`
  );

  // Explicit-id seeds leave the sequences behind; move them past the seeded
  // ids so real inserts never collide.
  for (const t of ['dramas', 'seasons', 'episodes', 'subscriptions', 'payments']) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`
    );
  }
}

let server = null;

async function start() {
  try {
    await migrate();
    if (IS_STAGING) await seedStaging();
  } catch (err) {
    console.error('boot migration/seed failed:', err);
  }
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
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

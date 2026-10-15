const express = require('express');
const path = require('path');
const fs = require('fs');
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
// Everything else requires a valid platform-issued JWT.
// /api/subscription is a GET whose answer for anyone without an account is
// the constant free shape, so opening it to signed-out visitors (the page
// asks for it on every boot, and a 401 would log a console error) carries
// no data.
const PUBLIC_API_PATHS = new Set(['/health', '/api/subscription']);

app.use(express.json());

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
// wherever they decide what shows: a reminder, a rota, a deadline.
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

// ── HTML entry points with per-request meta ───────────────────────────────
// The plain shell (/) is served by express.static below, with its default
// title and description. These three paths serve the SAME shell with the
// meta block (title, description, Open Graph, Twitter card, JSON-LD,
// canonical) injected per request, so a drama or an episode pasted into a
// chat or found by a search engine describes itself. Canonical and share
// URLs are built from the request's own host and forwarded scheme: no
// hostname is ever written into this file.
const SHELL_PATH = path.join(__dirname, 'public', 'index.html');
const SHELL_DEFAULT_TITLE = '<title>HomeClip</title>';
const META_SLOT = '<!--META-->';

let shellHtml = null;
function readShell() {
  if (shellHtml === null) shellHtml = fs.readFileSync(SHELL_PATH, 'utf8');
  return shellHtml;
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// The origin this request came in on, from the forwarded headers the
// platform's edge sets (the app itself is plain http behind it).
function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted
    ? 'https' : 'http';
  const host = req.headers.host || 'localhost:' + port;
  return proto + '://' + host;
}

function metaBlock(title, description, ogType, jsonLd) {
  return (
    '<meta name="description" content="' + escapeAttr(description) + '">' +
    '<meta property="og:title" content="' + escapeAttr(title) + '">' +
    '<meta property="og:description" content="' + escapeAttr(description) + '">' +
    '<meta property="og:type" content="' + escapeAttr(ogType) + '">' +
    '<meta name="twitter:card" content="summary">' +
    (jsonLd ? '<script type="application/ld+json">' + jsonLd + '</script>' : '')
  );
}

// Replaces the slot and the default title in one shell copy; the canonical
// and og:url lines are appended by the caller, which knows the path.
function serveShell(req, res, title, description, ogType, jsonLd, canonicalPath) {
  const origin = requestOrigin(req);
  const meta = metaBlock(title, description, ogType, jsonLd) +
    '<meta property="og:url" content="' + escapeAttr(origin + canonicalPath) + '">' +
    '<link rel="canonical" href="' + escapeAttr(origin + canonicalPath) + '">';
  const html = readShell()
    .replace(META_SLOT, meta)
    .replace(SHELL_DEFAULT_TITLE, '<title>' + escapeAttr(title) + '</title>');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(html);
}

// Drama or episode lookup for the meta block; demo rows answer only on
// ?demo=1 (staging), like every other route.
async function metaFor(req, kind) {
  const demo = demoOn(req);
  const id = req.params.id;
  const params = [id, demo];
  const rows = await pool.query(
    kind === 'drama'
      ? `SELECT id, title, synopsis FROM dramas WHERE id = $1 AND ($2 OR NOT is_demo)`
      : `SELECT e.id, e.title, e.season, e.number, d.id AS drama_id, d.title AS drama_title, d.synopsis
           FROM episodes e JOIN dramas d ON d.id = e.drama_id
          WHERE e.id = $1 AND ($2 OR NOT e.is_demo)`,
    params
  );
  return rows.rows[0] || null;
}

app.get('/drama/:id', async (req, res) => {
  try {
    const d = await metaFor(req, 'drama');
    if (!d) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>HomeClip</title><p>Drama not found</p>');
    const title = d.title + ' — HomeClip';
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'TVSeries',
      name: d.title, description: d.synopsis || undefined,
    });
    return serveShell(req, res, title, d.synopsis || 'Watch ' + d.title + ' with your group on HomeClip',
      'video.tv_show', jsonLd, '/drama/' + d.id);
  } catch (err) { console.error(err); return res.sendStatus(500); }
});

app.get('/watch/:id', async (req, res) => {
  try {
    const e = await metaFor(req, 'episode');
    if (!e) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>HomeClip</title><p>Episode not found</p>');
    const title = e.drama_title + ', Season ' + e.season + ', Episode ' + e.number + ': ' + e.title + ' — HomeClip';
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'TVEpisode',
      name: e.title, partOfSeries: { '@type': 'TVSeries', name: e.drama_title },
      partOfSeason: { '@type': 'TVSeason', seasonNumber: e.season },
      episodeNumber: e.number,
    });
    return serveShell(req, res, title, e.synopsis || ('Watch ' + e.title + ' with your group on HomeClip'),
      'video.episode', jsonLd, '/watch/' + e.id);
  } catch (err) { console.error(err); return res.sendStatus(500); }
});

// The Downloads view (hash-routed inside the app; this path entry point
// serves the same shell).
app.get('/downloads', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The legal pages as clean paths; the files themselves are static under
// /legal/ so guests and crawlers reach them without any redirect dance
// beyond this one hop.
app.get(['/terms', '/privacy', '/copyright'], (req, res) => {
  const page = req.path === '/terms' ? 'terms' : req.path === '/privacy' ? 'privacy' : 'copyright';
  return res.redirect(302, '/legal/' + page + '.html');
});

// Sitemap and robots policy, with absolute URLs built from the request's
// own host (a sitemap's URLs must be absolute, so this one cannot be a
// static file without baking a hostname in).
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\n\nSitemap: ' + requestOrigin(req) + '/sitemap.xml\n'
  );
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id FROM dramas WHERE NOT is_demo ORDER BY id`);
    const origin = requestOrigin(req);
    const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      '<url><loc>' + origin + '/</loc></url>\n' +
      rows.rows.map(r => '<url><loc>' + origin + '/drama/' + r.id + '</loc></url>').join('\n') +
      '\n</urlset>\n';
    res.type('application/xml').send(body);
  } catch (err) { console.error(err); return res.sendStatus(500); }
});

// hls.js, served straight from node_modules (its one new dependency, only
// ever loaded by the watch screen).
app.get('/vendor/hls.min.js', (_req, res) => {
  const p = path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400');
  return res.sendFile(p);
});

app.use(express.static(path.join(__dirname, 'public'), {
  // Unhashed filenames: revalidate on every load (the etag makes the 304s
  // cheap), so a deploy lands on the next load instead of up to five
  // minutes later.
  maxAge: 0,
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
}));

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
  // Phase 5: where an episode's video lives, and its subtitles. Columns are
  // also added for databases created before they existed; the https check
  // lives in the API layer, which validates every write.
  await pool.query(`ALTER TABLE episodes ADD COLUMN IF NOT EXISTS media_url TEXT`);
  await pool.query(`ALTER TABLE episodes ADD COLUMN IF NOT EXISTS subtitle_url TEXT`);

  // Where the viewer stopped in an episode (the player reports it).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS playback (
      user_id BIGINT NOT NULL,
      episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      position_s INT NOT NULL DEFAULT 0,
      duration_s INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, episode_id)
    )`);
  // VIP. Nothing can create a real subscription yet (no payment provider),
  // so production stays without rows until real keys exist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','cancelled')),
      provider TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      UNIQUE (user_id, plan)
    )`);
  // A table kept from an earlier release (it stored plan_id and renewal_date
  // with a TEXT user_id) is left alone by CREATE IF NOT EXISTS, so the
  // subscription query below would fail on its missing columns. Add this
  // shape's columns and carry the purchase state over, so an existing
  // subscriber keeps the VIP they hold in that shape too.
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan TEXT`);
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  const subCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'subscriptions'`);
  const subNames = new Set(subCols.rows.map((r) => r.column_name));
  if (subNames.has('plan_id') || subNames.has('renewal_date')) {
    await pool.query(`
      UPDATE subscriptions
        SET plan = COALESCE(plan, plan_id), expires_at = COALESCE(expires_at, renewal_date)
        WHERE plan IS NULL OR expires_at IS NULL`);
  }
  // First-party analytics events (views, watch time, drop-off, …).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      name TEXT NOT NULL,
      props JSONB,
      path TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS events_name_created_idx ON events (name, created_at)`);
  // Errors the page caught, for monitoring.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_errors (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      message TEXT NOT NULL,
      stack TEXT,
      path TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  // staging:private copies the schema to staging without the rows.
  await pool.query(`COMMENT ON TABLE follows IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE watches IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE playback IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE subscriptions IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE events IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE client_errors IS 'staging:private'`);
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
  // Sample video for the player, on two demo episodes only (the plain route
  // leaves is_demo rows out anyway). One is a real HLS test stream, the
  // other a small VP9 WebM served by the app itself: headless browsers that
  // ship no H.264 decoder (the check runner included) can still show real
  // playback, and being same-origin, Downloads work on it with no CORS
  // setup. The clip is Big Buck Bunny (CC BY, Blender Foundation), from
  // test-videos.co.uk.
  await pool.query(
    `UPDATE episodes SET media_url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        subtitle_url = '/demo/demo-subs.vtt'
      WHERE id = 9000012` // Harbour Lights, Season 2 Episode 6 "The Tide Table"
  );
  await pool.query(
    `UPDATE episodes SET media_url = '/demo/demo-video.webm'
      WHERE id = 9000063` // Copper Hill, Season 2 Episode 14 "The Last Shift"
  );
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
}

// On the first ?demo=1 request of the viewing account, write its follows and
// watches on the demo dramas, once, with fixed keys. The viewer follows
// Harbour Lights and The Quiet Wing, has watched Harbour Lights season 2 up
// to episode 5, and all of Copper Hill. Idempotent: a reload changes
// nothing, and what the viewer does to them stays.
const demoSeedPending = new Map();

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
      `SELECT id, season, number, title, minutes, watch_url, media_url
         FROM episodes
        WHERE drama_id = $1 AND ($3 OR NOT is_demo) AND NOT EXISTS (
          SELECT 1 FROM watches WHERE user_id = $2 AND episode_id = episodes.id)
        ORDER BY season, number LIMIT 1`,
      [row.drama_id, userId, demo]
    );
    if (!un.rows.length) continue;
    const hero = un.rows[0];
    const later = await pool.query(
      `SELECT id, season, number, title, minutes, watch_url, media_url
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
      if (!has.rows.length) {
        // The page fires /api/me and /api/feed in parallel; both would pass
        // the check above and one could read while the other's writes are
        // still landing. Share one seed per user instead.
        let pending = demoSeedPending.get(req.user.id);
        if (!pending) {
          pending = seedDemoViewer(req.user)
            .finally(() => demoSeedPending.delete(req.user.id));
          demoSeedPending.set(req.user.id, pending);
        }
        await pending;
      }
    }
  } catch (err) {
    console.error('demo viewer seed failed', err);
  }
  next();
});

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
      `SELECT drama_id, COUNT(*) AS episodes, COUNT(DISTINCT season) AS seasons
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
          WHERE ${demoClause(req, 'e.is_demo', 1)} AND e.drama_id = ANY($2)
          ORDER BY e.season, e.number`,
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
      const c = countBy.get(d.id) || { episodes: 0, seasons: 0 };
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
      // watched, that you finished it, or who else has watched it. The
      // words live in the page's dictionary (i18n.js), so the note carries
      // the numbers and names and the client composes the sentence.
      let note;
      if (Number(c.episodes) === 0) note = { kind: 'no_episodes' };
      else if (followed.has(Number(d.id)) && seasonEps.length) {
        note = { kind: 'progress', pct: seasonWatched / seasonEps.length, watched: seasonWatched, total: seasonEps.length };
      } else if (dramaEps.some(e => e.is_new && !e.viewer_watched)) {
        note = { kind: 'new' };
      } else if (finished) {
        note = { kind: 'finished' };
      } else {
        const names = dramaEps.flatMap(e => e.watchers)
          .filter(u => u !== viewerName)
          .filter((u, i, a) => a.indexOf(u) === i);
        note = names.length
          ? { kind: 'others', names: names.slice(0, 2), more: Math.max(0, names.length - 2) }
          : { kind: 'none' };
      }
      return {
        id: Number(d.id), title: d.title, synopsis: d.synopsis,
        added_by_username: d.added_by_username,
        seasons: Number(c.seasons), episodes: Number(c.episodes),
        following: followed.has(Number(d.id)),
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
      next.hero.watched_by = heroRow ? heroRow.watchers : [];
      next.upcoming = next.later.map(e => ({
        id: e.id, season: e.season, number: e.number, title: e.title, minutes: e.minutes,
        watched_by: (dramaEps.find(x => x.id === e.id) || {}).watchers || [],
      }));
      delete next.hero.season;
      delete next.later;
    }
    return res.json({ dramas: out, next });
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
    const d = await pool.query(
      `SELECT id, title, synopsis, added_by_id, added_by_username, created_at
         FROM dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    const drama = d.rows[0];
    const eps = await pool.query(
      `SELECT e.id, e.season, e.number, e.title, e.minutes, e.watch_url,
              e.media_url, e.subtitle_url,
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
    // Episodes grouped by season for the season control.
    const seasons = new Map();
    for (const e of eps.rows) {
      if (!seasons.has(e.season)) seasons.set(e.season, []);
      seasons.get(e.season).push(e);
    }
    return res.json({
      drama: { ...drama, id: Number(drama.id), mine: req.user && Number(drama.added_by_id) === Number(req.user.id) },
      seasons: [...seasons.keys()].sort((a, b) => a - b),
      episodes: eps.rows.map(e => ({ ...e, mine: req.user && Number(e.added_by_id) === Number(req.user.id) })),
      following,
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
    const media_url = typeof req.body.media_url === 'string' && req.body.media_url.trim()
      ? req.body.media_url.trim() : null;
    const subtitle_url = typeof req.body.subtitle_url === 'string' && req.body.subtitle_url.trim()
      ? req.body.subtitle_url.trim() : null;
    if (!season || season < 1 || season > 99) return res.status(400).json({ error: 'Season must be 1 to 99' });
    if (!number || number < 1 || number > 999) return res.status(400).json({ error: 'Episode number must be 1 to 999' });
    if (!title || title.length > 80) return res.status(400).json({ error: 'A title of 1 to 80 characters is required' });
    if (minutes !== null && (minutes < 1 || minutes > 600)) return res.status(400).json({ error: 'Minutes must be 1 to 600' });
    if (watch_url && !/^https:\/\//.test(watch_url)) return res.status(400).json({ error: 'The link must start with https://' });
    if (media_url && !/^https:\/\//.test(media_url)) return res.status(400).json({ error: 'The video link must start with https://' });
    if (subtitle_url && !/^https:\/\//.test(subtitle_url) && !/^\/[A-Za-z0-9._~-]+$/.test(subtitle_url))
      return res.status(400).json({ error: 'The subtitles link must be an https:// link or a path in this app' });
    const exists = await pool.query(
      `SELECT 1 FROM episodes WHERE drama_id = $1 AND season = $2 AND number = $3`,
      [req.params.id, season, number]
    );
    if (exists.rows.length) return res.status(409).json({ error: 'That season and episode number already exists' });
    const r = await pool.query(
      `INSERT INTO episodes (drama_id, season, number, title, minutes, watch_url, media_url, subtitle_url, added_by_id, added_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.params.id, season, number, title, minutes, watch_url, media_url, subtitle_url, req.user.id, req.user.username]
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
    const e = await pool.query(`SELECT id FROM episodes WHERE id = $1`, [req.params.id]);
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
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
    if (!dramaId && !episodeId) return res.status(400).json({ error: 'A drama or an episode is required' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
    if (reason && reason.length > 500) return res.status(400).json({ error: 'The reason must be 500 characters or fewer' });
    await pool.query(
      `INSERT INTO reports (reporter_id, reporter_username, drama_id, episode_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, req.user.username, dramaId, episodeId, reason]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not send the report' });
  }
});

// ── Player, subscriptions, analytics (Phase 5) ───────────────────────────

// What the watch screen needs in one call: the episode with its media, its
// drama, its neighbours in the same season (so the player can offer the
// next one), the viewer's stored position, and whether they marked it.
// Guests may watch read-only, like every GET.
app.get('/api/watch/:episodeId', async (req, res) => {
  try {
    const viewerId = req.user ? req.user.id : null;
    const demo = demoOn(req);
    const e = await pool.query(
      `SELECT e.id, e.drama_id, e.season, e.number, e.title, e.minutes, e.watch_url,
              e.media_url, e.subtitle_url,
              EXISTS (SELECT 1 FROM watches w WHERE w.episode_id = e.id AND w.user_id = $3::integer) AS viewer_watched
         FROM episodes e
        WHERE e.id = $1 AND ($2 OR NOT e.is_demo)`,
      [req.params.episodeId, demo, viewerId || 0]
    );
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
    const ep = e.rows[0];
    const d = await pool.query(
      `SELECT id, title FROM dramas WHERE id = $1 AND ($2 OR NOT is_demo)`,
      [ep.drama_id, demo]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Episode not found' });
    const neighbours = await pool.query(
      `SELECT e.id, e.season, e.number, e.title, e.minutes, (e.media_url IS NOT NULL) AS has_media
         FROM episodes e
        WHERE e.drama_id = $1 AND e.season = $2 AND ($3 OR NOT e.is_demo)
        ORDER BY e.number`,
      [ep.drama_id, ep.season, demo]
    );
    let prev = null, next = null;
    for (const row of neighbours.rows) {
      if (row.number < ep.number && (!prev || row.number > prev.number)) prev = row;
      if (row.number > ep.number && (!next || row.number < next.number)) next = row;
    }
    let playback = null;
    if (viewerId) {
      const p = await pool.query(
        `SELECT position_s, duration_s FROM playback WHERE user_id = $1 AND episode_id = $2`,
        [viewerId, ep.id]
      );
      if (p.rows.length) playback = p.rows[0];
    }
    return res.json({
      episode: {
        id: Number(ep.id), drama_id: Number(ep.drama_id), season: ep.season,
        number: ep.number, title: ep.title, minutes: ep.minutes,
        watch_url: ep.watch_url, media_url: ep.media_url, subtitle_url: ep.subtitle_url,
        viewer_watched: !!ep.viewer_watched,
      },
      drama: { id: Number(d.rows[0].id), title: d.rows[0].title },
      prev: prev ? { id: Number(prev.id), number: prev.number, title: prev.title, has_media: !!prev.has_media } : null,
      next: next ? { id: Number(next.id), number: next.number, title: next.title, minutes: next.minutes, has_media: !!next.has_media } : null,
      playback,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not load the episode' });
  }
});

// Where the viewer stopped. Called by the player as it plays.
app.put('/api/episodes/:id/progress', async (req, res) => {
  try {
    const exists = await pool.query(`SELECT id FROM episodes WHERE id = $1`, [req.params.id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Episode not found' });
    const position = parseInt(req.body.position_s, 10);
    const duration = req.body.duration_s ? parseInt(req.body.duration_s, 10) : null;
    if (!Number.isFinite(position) || position < 0) return res.status(400).json({ error: 'A position in seconds is required' });
    if (duration !== null && (duration < 1 || duration > 36000)) return res.status(400).json({ error: 'Duration must be 1 to 36000 seconds' });
    const clamped = duration ? Math.min(position, duration) : Math.min(position, 36000);
    await pool.query(
      `INSERT INTO playback (user_id, episode_id, position_s, duration_s)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, episode_id)
       DO UPDATE SET position_s = $3, duration_s = $4, updated_at = now()`,
      [req.user.id, req.params.id, clamped, duration]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not save the position' });
  }
});

// Whether the viewer is VIP. Nothing can create a real subscription yet, so
// in production this answers from a table that is empty: VIP stays closed
// until real payment keys exist. On the staging demo route, the demo viewer
// is VIP without storing anything (the row would leak into the plain route
// on the same staging database, which must stay production-shaped).
//
// The answer is always 200: a signed-out viewer and a viewer with no
// subscription record both get the free shape, and an unexpected database
// failure is logged here and answered as free too — the page must open
// either way, and the client treats every non-VIP answer as free.
const FREE_SUB = { vip: false, isVip: false, status: 'free', plan: null, expires_at: null };
app.get('/api/subscription', async (req, res) => {
  try {
    if (IS_STAGING && req.query.demo === '1' && req.user) {
      return res.json({ vip: true, isVip: true, plan: 'vip', status: 'active', expires_at: null, demo: true });
    }
    if (!req.user) return res.json(FREE_SUB);
    const r = await pool.query(
      `SELECT plan, status, expires_at FROM subscriptions
        WHERE user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
        ORDER BY started_at DESC LIMIT 1`,
      [req.user.id]
    );
    const s = r.rows[0];
    return res.json(s
      ? { vip: true, isVip: true, plan: s.plan, status: s.status, expires_at: s.expires_at }
      : FREE_SUB);
  } catch (err) {
    console.error('subscription lookup failed', err);
    return res.json(FREE_SUB);
  }
});

// First-party analytics. The event names are whitelisted server-side so a
// stray client cannot invent schema; nothing here hides or shows anything.
const EVENT_NAMES = new Set([
  'screen_view', 'watch_started', 'watch_heartbeat', 'watch_completed', 'drop_off',
  'download_started', 'download_completed', 'download_deleted',
  'subscription_intent', 'language_changed', 'install_prompt_accepted',
]);

app.post('/api/events', async (req, res) => {
  try {
    const batch = Array.isArray(req.body.events) ? req.body.events : [];
    if (!batch.length) return res.status(400).json({ error: 'An events array is required' });
    if (batch.length > 50) return res.status(400).json({ error: 'At most 50 events per batch' });
    const rows = [];
    for (const ev of batch) {
      const name = typeof ev.name === 'string' ? ev.name : '';
      if (!EVENT_NAMES.has(name)) return res.status(400).json({ error: 'Unknown event name' });
      rows.push([
        req.user.id, req.user.username, name,
        ev.props && typeof ev.props === 'object' ? JSON.stringify(ev.props) : null,
        typeof ev.path === 'string' ? ev.path.slice(0, 200) : null,
      ]);
    }
    const values = rows.map((_, i) =>
      `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ');
    await pool.query(
      `INSERT INTO events (user_id, username, name, props, path) VALUES ${values}`,
      rows.flat()
    );
    return res.status(204).end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not record the events' });
  }
});

// Errors the page caught. Rate limited in memory per user; stacks are
// clipped so one bad page cannot fill the table.
const errorBuckets = new Map(); // userId -> [timestamps]
app.post('/api/client-errors', (req, res) => {
  const userId = req.user ? req.user.id : 0;
  const now = Date.now();
  const bucket = (errorBuckets.get(userId) || []).filter(t => now - t < 60_000);
  if (bucket.length >= 5) return res.status(429).json({ error: 'Too many error reports' });
  bucket.push(now);
  errorBuckets.set(userId, bucket);
  const message = typeof req.body.message === 'string' ? req.body.message.slice(0, 500) : 'Unknown error';
  const stack = typeof req.body.stack === 'string' ? req.body.stack.slice(0, 2000) : null;
  const pathText = typeof req.body.path === 'string' ? req.body.path.slice(0, 200) : null;
  pool.query(
    `INSERT INTO client_errors (user_id, username, message, stack, path, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.user ? req.user.id : null, req.user ? req.user.username : null,
      message, stack, pathText, req.headers['user-agent'] || null]
  ).then(() => res.status(204).end()).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Could not record the error' });
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────

async function start() {
  // Idempotent schema on boot, then (staging only) the demo dramas.
  await ensureSchema();
  if (IS_STAGING) {
    try {
      await seedDemo();
    } catch (err) {
      console.error('demo seed failed', err);
    }
  }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
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

start().catch(err => { console.error(err); process.exit(1); });

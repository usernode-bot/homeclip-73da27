const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { DRAMAS, episodesFor, VIDEO_BASE, VIDEO_POOL } = require('./data/catalog');

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
// its own address, read-only (every public app). See the platform
// conventions: every write they try is answered 401 `account_required`,
// which the bridge turns into "Make an account to continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Everything else requires a
// valid platform-issued JWT (non-GET and /api/* at least).
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. Registered BEFORE the auth middleware
// because these three files are public.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`. Production always gets the
// real time; a staging preview may be shown as of a chosen moment.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience: without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
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

  // A guest may READ (every GET, `/api/*` included), so read routes must not
  // assume req.user (use `req.user ? req.user.id : null`). Every write needs
  // an account.
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

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Database schema (idempotent, applied on boot) ─────────────────────────
// dramas/episodes are the shared SAMPLE CATALOG: public (it is the app's own
// content, visible to everyone in the app anyway). my_list / watch_progress
// / settings hold per-user data, so they are `staging:private` — schema-only
// copies in staging, seeded per user by ?demo=1 below.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dramas (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  year INTEGER NOT NULL,
  country TEXT NOT NULL,
  genres TEXT[] NOT NULL DEFAULT '{}',
  rating REAL NOT NULL,
  popularity INTEGER NOT NULL,
  featured INTEGER,
  cast_names TEXT[] NOT NULL DEFAULT '{}',
  synopsis_en TEXT NOT NULL,
  synopsis_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS episodes (
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  num INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  video_url TEXT NOT NULL,
  PRIMARY KEY (drama_id, num)
);
CREATE TABLE IF NOT EXISTS my_list (
  user_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_demo BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, drama_id)
);
CREATE TABLE IF NOT EXISTS watch_progress (
  user_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  ep INTEGER NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_demo BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, drama_id)
);
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'system',
  theme TEXT NOT NULL DEFAULT 'system',
  notifications BOOLEAN NOT NULL DEFAULT true
);
COMMENT ON TABLE my_list IS 'staging:private';
COMMENT ON TABLE watch_progress IS 'staging:private';
COMMENT ON TABLE settings IS 'staging:private';
`;

// Seed the sample catalog (idempotent; the same content in staging and
// production — it is the app's Phase 1 mock data, not fake visitor data).
async function seedCatalog() {
  const client = await pool.connect();
  try {
    for (const d of DRAMAS) {
      await client.query(
        `INSERT INTO dramas (id, title, year, country, genres, rating, popularity, featured, cast_names, synopsis_en, synopsis_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, d.title, d.year, d.country, d.genres, d.rating, d.popularity,
         d.featured, d.cast, d.synopsis_en, d.synopsis_id]
      );
      for (const ep of episodesFor(d)) {
        await client.query(
          `INSERT INTO episodes (drama_id, num, duration_min, video_url)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (drama_id, num) DO UPDATE
             SET duration_min = EXCLUDED.duration_min, video_url = EXCLUDED.video_url`,
          [d.id, ep.num, ep.durationMin, ep.videoUrl]
        );
      }
    }
  } finally {
    client.release();
  }
}

// ── Demo fixture (first version's populated demo, behind ?demo=1) ─────────
// Writes the VIEWING account a few My List entries and half-watched episodes
// ONCE, marked is_demo, so Home's "Continue Watching" and the My List /
// History pages show a populated screen. Rows marked is_demo are excluded
// from every response that does NOT carry ?demo=1, so the plain route stays
// the production shape (an empty list until the user acts).
const DEMO_MY_LIST_IDS = [1, 4, 12];
const DEMO_PROGRESS = [
  { dramaId: 2, ep: 3, pct: 0.42 },
  { dramaId: 7, ep: 1, pct: 0.15 },
  { dramaId: 13, ep: 5, pct: 0.7 },
  { dramaId: 23, ep: 2, pct: 0.55 },
];
async function seedViewerDemo(userId) {
  for (const id of DEMO_MY_LIST_IDS) {
    await pool.query(
      `INSERT INTO my_list (user_id, drama_id, is_demo) VALUES ($1,$2,true)
       ON CONFLICT (user_id, drama_id) DO NOTHING`,
      [userId, id]
    );
  }
  for (const p of DEMO_PROGRESS) {
    const eps = await pool.query(
      'SELECT duration_min FROM episodes WHERE drama_id=$1 AND num=$2',
      [p.dramaId, p.ep]
    );
    if (eps.rowCount === 0) continue;
    // The stored duration is the REAL sample-video length is unknown here;
    // store display minutes as seconds and let the player overwrite it with
    // the true duration the first time it plays.
    const dur = eps.rows[0].duration_min * 60;
    await pool.query(
      `INSERT INTO watch_progress (user_id, drama_id, ep, seconds, duration, is_demo)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (user_id, drama_id) DO NOTHING`,
      [userId, p.dramaId, p.ep, Math.round(dur * p.pct), dur]
    );
  }
}

// ?demo=1 requests (staging only) get the viewer's demo rows too; plain
// requests never see them.
function wantsDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

const DRAMA_FIELDS = 'd.id, d.title, d.year, d.country, d.genres, d.rating, d.popularity, d.cast_names, d.synopsis_en, d.synopsis_id';

// ── API ───────────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
  let settings = { language: 'system', theme: 'system', notifications: true };
  if (req.user) {
    const r = await pool.query('SELECT language, theme, notifications FROM settings WHERE user_id = $1', [req.user.id]);
    if (r.rowCount > 0) settings = r.rows[0];
  }
  res.json({
    user: req.user ? { id: req.user.id, username: req.user.username, locale: req.user.locale || null } : null,
    guest: !!req.guest,
    settings,
    platformLocale: req.user ? (req.user.locale || null) : null,
  });
});

app.put('/api/settings', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const { language, theme, notifications } = req.body || {};
  const lang = ['system', 'en', 'id'].includes(language) ? language : 'system';
  const themeOk = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  const notif = !!notifications;
  await pool.query(
    `INSERT INTO settings (user_id, language, theme, notifications) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET language=$2, theme=$3, notifications=$4`,
    [req.user.id, lang, themeOk, notif]
  );
  res.json({ ok: true, settings: { language: lang, theme: themeOk, notifications: notif } });
});

// Everything the Home screen needs, in one round trip.
app.get('/api/home', async (req, res) => {
  const demo = wantsDemo(req);
  if (demo && req.user) {
    const has = await pool.query(
      'SELECT 1 FROM watch_progress WHERE user_id=$1 UNION ALL SELECT 1 FROM my_list WHERE user_id=$1 LIMIT 1',
      [req.user.id]
    );
    if (has.rowCount === 0) await seedViewerDemo(req.user.id);
  }
  const [featured, trending, newEpisodes, top10, cont] = await Promise.all([
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE featured IS NOT NULL ORDER BY featured LIMIT 5`),
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d ORDER BY popularity DESC LIMIT 12`),
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d ORDER BY year DESC, id DESC LIMIT 12`),
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d ORDER BY rating DESC, popularity DESC LIMIT 10`),
    req.user
      ? pool.query(
          `SELECT ${DRAMA_FIELDS}, w.ep, w.seconds, w.duration, w.updated_at
           FROM watch_progress w JOIN dramas d ON d.id = w.drama_id
           WHERE w.user_id = $1 ${demo ? '' : 'AND w.is_demo = false'}
           ORDER BY w.updated_at DESC LIMIT 12`,
          [req.user.id])
      : { rows: [] },
  ]);
  res.json({
    featured: featured.rows,
    trending: trending.rows,
    newEpisodes: newEpisodes.rows,
    top10: top10.rows,
    continue: cont.rows,
  });
});

// Browse / search with filters, sort and pagination.
app.get('/api/dramas', async (req, res) => {
  const { genre, country, year, sort, q } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(24, Math.max(6, parseInt(req.query.limit, 10) || 15));
  const where = [];
  const params = [];
  if (genre && ['romance', 'thriller', 'fantasy', 'comedy', 'historical', 'action'].includes(genre)) {
    params.push(genre); where.push(`$${params.length} = ANY(d.genres)`);
  }
  if (country && /^[a-z]{2}$/.test(country)) {
    params.push(country); where.push(`d.country = $${params.length}`);
  }
  if (year && /^\d{4}$/.test(year)) {
    params.push(Number(year)); where.push(`d.year = $${params.length}`);
  }
  if (q && typeof q === 'string' && q.trim()) {
    params.push('%' + q.trim() + '%'); where.push(`d.title ILIKE $${params.length}`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderSql = sort === 'newest' ? 'ORDER BY d.year DESC, d.id DESC' : 'ORDER BY d.popularity DESC, d.rating DESC';
  params.push(limit, (page - 1) * limit);
  const rows = await pool.query(
    `SELECT ${DRAMA_FIELDS} FROM dramas d ${whereSql} ${orderSql} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await pool.query(`SELECT count(*)::int AS n FROM dramas d ${whereSql}`, params.slice(0, params.length - 2));
  res.json({
    items: rows.rows,
    total: total.rows[0].n,
    hasMore: (page - 1) * limit + rows.rows.length < total.rows[0].n,
    page,
  });
});

app.get('/api/dramas/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  const d = await pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE d.id = $1`, [id]);
  if (d.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const eps = await pool.query(
    'SELECT num, duration_min, video_url FROM episodes WHERE drama_id = $1 ORDER BY num', [id]
  );
  let inMyList = false;
  let progress = null;
  if (req.user) {
    const ml = await pool.query('SELECT 1 FROM my_list WHERE user_id=$1 AND drama_id=$2', [req.user.id, id]);
    inMyList = ml.rowCount > 0;
    const pr = await pool.query(
      'SELECT ep, seconds, duration FROM watch_progress WHERE user_id=$1 AND drama_id=$2 AND is_demo=false',
      [req.user.id, id]
    );
    if (pr.rowCount > 0) progress = pr.rows[0];
  }
  res.json({ drama: d.rows[0], episodes: eps.rows, inMyList, progress });
});

app.get('/api/my-list', async (req, res) => {
  const demo = wantsDemo(req);
  if (demo && req.user) {
    const has = await pool.query('SELECT 1 FROM my_list WHERE user_id=$1 UNION ALL SELECT 1 FROM watch_progress WHERE user_id=$1 LIMIT 1', [req.user.id]);
    if (has.rowCount === 0) await seedViewerDemo(req.user.id);
  }
  const r = await pool.query(
    `SELECT ${DRAMA_FIELDS}, m.added_at
     FROM my_list m JOIN dramas d ON d.id = m.drama_id
     WHERE m.user_id = $1 ${demo ? '' : 'AND m.is_demo = false'}
     ORDER BY m.added_at DESC`,
    [req.user ? req.user.id : 0]
  );
  res.json({ items: r.rows });
});

app.post('/api/my-list/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = parseInt(req.params.id, 10);
  await pool.query(
    `INSERT INTO my_list (user_id, drama_id, is_demo) VALUES ($1,$2,false)
     ON CONFLICT (user_id, drama_id) DO UPDATE SET is_demo = false`,
    [req.user.id, id]
  );
  res.json({ ok: true });
});

app.delete('/api/my-list/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  await pool.query('DELETE FROM my_list WHERE user_id=$1 AND drama_id=$2', [req.user.id, parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

app.get('/api/history', async (req, res) => {
  const demo = wantsDemo(req);
  if (demo && req.user) {
    const has = await pool.query('SELECT 1 FROM my_list WHERE user_id=$1 UNION ALL SELECT 1 FROM watch_progress WHERE user_id=$1 LIMIT 1', [req.user.id]);
    if (has.rowCount === 0) await seedViewerDemo(req.user.id);
  }
  const r = await pool.query(
    `SELECT ${DRAMA_FIELDS}, w.ep, w.seconds, w.duration, w.updated_at
     FROM watch_progress w JOIN dramas d ON d.id = w.drama_id
     WHERE w.user_id = $1 ${demo ? '' : 'AND w.is_demo = false'}
     ORDER BY w.updated_at DESC LIMIT 50`,
    [req.user ? req.user.id : 0]
  );
  res.json({ items: r.rows });
});

app.delete('/api/history/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  await pool.query('DELETE FROM watch_progress WHERE user_id=$1 AND drama_id=$2', [req.user.id, parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

app.post('/api/progress', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const { dramaId, ep, seconds, duration } = req.body || {};
  if (!Number.isInteger(dramaId) || !Number.isInteger(ep) ||
      typeof seconds !== 'number' || typeof duration !== 'number' ||
      seconds < 0 || duration <= 0) {
    return res.status(400).json({ error: 'bad_request' });
  }
  await pool.query(
    `INSERT INTO watch_progress (user_id, drama_id, ep, seconds, duration, is_demo)
     VALUES ($1,$2,$3,$4,$5,false)
     ON CONFLICT (user_id, drama_id) DO UPDATE
       SET ep = $3, seconds = $4, duration = $5, updated_at = now(), is_demo = false`,
    [req.user.id, dramaId, ep, Math.min(seconds, duration), duration]
  );
  res.json({ ok: true });
});

app.get('/api/facets', async (_req, res) => {
  const r = await pool.query(
    `SELECT DISTINCT country FROM dramas ORDER BY country`
  );
  const y = await pool.query(`SELECT DISTINCT year FROM dramas ORDER BY year DESC`);
  res.json({ countries: r.rows.map(x => x.country), years: y.rows.map(x => x.year) });
});

// Placeholder poster art: a deterministic, original SVG generated from the
// drama itself (genre-hued gradient, a quiet pattern, the title). No
// copyrighted artwork anywhere. Served OUTSIDE /api/ on purpose: <img> tags
// cannot attach the auth header, and generated poster art is not sensitive.
const GENRE_HUES = { romance: 335, thriller: 255, fantasy: 200, comedy: 28, historical: 165, action: 280 };

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function wrapTitle(title, max) {
  const words = title.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? line + ' ' + w : w;
    if (next.length > max && line) { lines.push(line); line = w; } else { line = next; }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

app.get('/poster/:id.svg', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT id, title, year, country, genres FROM dramas WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const d = r.rows[0];
  const hue = (GENRE_HUES[d.genres[0]] || 240) + (id % 7) * 4;
  const h2 = hue + 30;
  const c1 = `hsl(${hue}, 52%, 26%)`;
  const c2 = `hsl(${h2}, 60%, 10%)`;
  const lines = wrapTitle(d.title, 13);
  const lineH = 46;
  const start = 236 - ((lines.length - 1) * lineH) / 2;
  const text = lines.map((l, i) =>
    `<text x="150" y="${start + i * lineH}" text-anchor="middle" font-family="'Trebuchet MS','Segoe UI',sans-serif" font-size="40" font-weight="700" fill="#ffffff" opacity="0.96">${escapeXml(l)}</text>`
  ).join('');
  // A quiet deterministic pattern: three translucent discs seeded by id.
  const o = (n) => 40 + ((id * 13 + n * 7) % 240);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="300" height="450" fill="url(#g)"/>
<circle cx="${o(1) % 300}" cy="${o(2) % 450}" r="90" fill="#ffffff" opacity="0.05"/>
<circle cx="${o(3) % 300}" cy="${o(4) % 450}" r="140" fill="#000000" opacity="0.08"/>
<circle cx="${o(5) % 300}" cy="${o(6) % 450}" r="55" fill="#ffffff" opacity="0.04"/>
<rect x="0" y="0" width="300" height="450" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="2"/>
<g><rect x="128" y="96" width="44" height="44" rx="12" fill="#ffffff" opacity="0.18"/>
<path d="M 143 107 L 163 118 L 143 129 Z" fill="#ffffff" opacity="0.9"/></g>
${text}
<text x="150" y="410" text-anchor="middle" font-family="'Trebuchet MS','Segoe UI',sans-serif" font-size="20" fill="#ffffff" opacity="0.75">${escapeXml(d.year + ' · ' + d.country.toUpperCase())}</text>
</svg>`;
  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// Wide featured-banner art for the Home screen: same deterministic style as
// the posters but composed for 16:9, and with no baked-in title (the HTML
// overlay carries the title so it can slide between episodes' dramas).
app.get('/banner/:id.svg', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT id, title, year, country, genres FROM dramas WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const d = r.rows[0];
  const hue = (GENRE_HUES[d.genres[0]] || 240) + (id % 7) * 4;
  const h2 = hue + 40;
  const c1 = `hsl(${hue}, 55%, 30%)`;
  const c2 = `hsl(${h2}, 62%, 12%)`;
  const o = (n) => 40 + ((id * 13 + n * 7) % 240);
  // A quiet fan of translucent "clip" wedges, seeded by id, so each banner
  // reads as its own artwork while staying obviously generated.
  const wedge = (k) => {
    const x = 200 + ((id * 97 + k * 260) % 900);
    const w = 120 + ((id * 31 + k * 53) % 160);
    return `<rect x="${x}" y="-60" width="${w}" height="800" fill="#ffffff" opacity="0.045" transform="rotate(14 ${x} 340)"/>`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<radialGradient id="s" cx="0.22" cy="0.28" r="0.9"><stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="675" fill="url(#g)"/>
${wedge(1)}${wedge(2)}${wedge(3)}${wedge(4)}
<circle cx="${o(1) % 1200}" cy="${o(2) % 675}" r="190" fill="#ffffff" opacity="0.05"/>
<circle cx="${o(3) % 1200}" cy="${o(4) % 675}" r="300" fill="#000000" opacity="0.09"/>
<rect width="1200" height="675" fill="url(#s)"/>
<g><rect x="70" y="250" width="88" height="88" rx="22" fill="#ffffff" opacity="0.2"/>
<path d="M 100 272 L 132 294 L 100 316 Z" fill="#ffffff" opacity="0.92"/></g>
</svg>`;
  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// Sample subtitle files for the player's subtitle language selector. The
// sample videos carry no real captions, so these are generic sample lines,
// clearly marked as such. Served outside /api/ like the posters: <track>
// elements cannot attach the auth header, and the files are generic samples.
function sampleVtt(lang) {
  const isId = lang === 'id';
  const lines = isId
    ? ['[Contoh takarir HomeClip]', 'Video contoh ini tidak memiliki dialog asli.', 'Selamat menonton.']
    : ['[HomeClip sample subtitles]', 'This sample video has no real dialogue.', 'Enjoy the show.'];
  let cues = 'WEBVTT\n';
  let t = 1;
  for (const line of lines) {
    const a = `00:00:0${t}.000`;
    const b = `00:00:0${t + 2}.000`;
    cues += `\n${t}\n${a} --> ${b}\n${line}\n`;
    t += 3;
  }
  return cues;
}

app.get('/subtitles/:lang.vtt', (req, res) => {
  const lang = req.params.lang;
  if (!['en', 'id'].includes(lang)) return res.status(404).json({ error: 'not_found' });
  res.type('text/vtt');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(sampleVtt(lang));
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document) are
// sent to the platform's chromeless view of this app, so the link just
// works. Every other tokenless case gets the "open in Homeroom" landing
// page instead of a redirect.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
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

// Graceful shutdown per the platform conventions: stop accepting, drain
// ~3s, close the pool, exit. Idempotent across SIGTERM + SIGINT.
const DRAIN_MS = 3000;
let server;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  server.close(() => {});
  server.closeIdleConnections?.();
  const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
  t.unref?.();
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

async function start() {
  await pool.query(SCHEMA_SQL);
  await seedCatalog();
  const server2 = app.listen(port, () => console.log(`Listening on :${port}`));
  // Expose for the shutdown handler.
  server = server2;
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server2.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

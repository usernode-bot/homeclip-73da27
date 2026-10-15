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


// ── Shared drama tracker (main's HomeClip) ────────────────────────────────
// The group's shared drama feed: add dramas season by season, follow them,
// mark episodes watched, see what is next. It lives beside the streaming
// catalog above, under its own `tracker_*` tables, its own /api/tracker/*
// routes and its own page at /tracker, so the two never share a name.
const tracker = express.Router();
app.use('/api/tracker', tracker);

// ── Schema ────────────────────────────────────────────────────────────────
// Idempotent on boot. `dramas` and `episodes` are public (the group's shared
// feed); `follows`, `watches` and `reports` are each person's own data,
// marked `staging:private` so staging copies the schema without the rows
// (the demo seeds its own).

async function ensureTrackerSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_dramas (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
      synopsis TEXT CHECK (synopsis IS NULL OR length(synopsis) <= 280),
      added_by_id BIGINT NOT NULL,
      added_by_username TEXT NOT NULL,
      is_demo BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_episodes (
      id BIGSERIAL PRIMARY KEY,
      drama_id BIGINT NOT NULL REFERENCES tracker_dramas(id) ON DELETE CASCADE,
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
    CREATE TABLE IF NOT EXISTS tracker_follows (
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      drama_id BIGINT NOT NULL REFERENCES tracker_dramas(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, drama_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_watches (
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      episode_id BIGINT NOT NULL REFERENCES tracker_episodes(id) ON DELETE CASCADE,
      watched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, episode_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_id BIGINT NOT NULL,
      reporter_username TEXT NOT NULL,
      drama_id BIGINT REFERENCES tracker_dramas(id) ON DELETE SET NULL,
      episode_id BIGINT REFERENCES tracker_episodes(id) ON DELETE SET NULL,
      reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // staging:private copies the schema to staging without the rows.
  await pool.query(`COMMENT ON TABLE tracker_follows IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE tracker_watches IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE tracker_reports IS 'staging:private'`);
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

async function seedTrackerDemo() {
  for (const d of DEMO_DRAMAS) {
    await pool.query(
      `INSERT INTO tracker_dramas (id, title, synopsis, added_by_id, added_by_username, is_demo, created_at)
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
      `INSERT INTO tracker_episodes (id, drama_id, season, number, title, minutes, added_by_id, added_by_username, is_demo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now() - interval '30 days')
       ON CONFLICT (id) DO NOTHING`,
      [n, dramaId, season, number, title, minutes, DEMO_USERS[by], by]
    );
    // Ninth Street's newest episode was added this week ("New episode").
    if (dramaId === 900003 && season === 3 && number === 3) {
      await pool.query(`UPDATE tracker_episodes SET created_at = now() - interval '2 days' WHERE id = $1`, [n]);
    }
    n++;
  }
  const eps = await pool.query(`SELECT id, drama_id, season, number FROM tracker_episodes WHERE is_demo = true`);
  const byKey = new Map(eps.rows.map(r => [r.drama_id + ':' + r.season + ':' + r.number, r.id]));
  for (const [name, uid] of Object.entries(DEMO_USERS)) {
    for (const [dramaId, season, number] of DEMO_WATCHES[name]) {
      const epId = byKey.get(dramaId + ':' + season + ':' + number);
      if (!epId) continue;
      await pool.query(
        `INSERT INTO tracker_watches (user_id, username, episode_id, watched_at)
         VALUES ($1, $2, $3, now() - interval '20 days') ON CONFLICT DO NOTHING`,
        [uid, name, epId]
      );
    }
  }
  for (const [name, dramaId] of DEMO_FOLLOWS) {
    await pool.query(
      `INSERT INTO tracker_follows (user_id, username, drama_id, created_at)
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
async function seedDemoViewer(user) {
  // Follow times are set so Harbour Lights sorts before The Quiet Wing in
  // Next to watch (its latest watch is the most recent of the two).
  await pool.query(
    `INSERT INTO tracker_follows (user_id, username, drama_id, created_at)
     VALUES ($1, $2, 900001, now() - interval '3 days') ON CONFLICT DO NOTHING`,
    [user.id, user.username]
  );
  await pool.query(
    `INSERT INTO tracker_follows (user_id, username, drama_id, created_at)
     VALUES ($1, $2, 900002, now() - interval '3 hours') ON CONFLICT DO NOTHING`,
    [user.id, user.username]
  );
  const eps = await pool.query(`SELECT id, drama_id, season, number FROM tracker_episodes WHERE is_demo = true`);
  const byKey = new Map(eps.rows.map(r => [r.drama_id + ':' + r.season + ':' + r.number, r.id]));
  const put = (epId, ago) => pool.query(
    `INSERT INTO tracker_watches (user_id, username, episode_id, watched_at)
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
       FROM tracker_follows f
       JOIN tracker_dramas d ON d.id = f.drama_id
       LEFT JOIN tracker_watches w ON w.user_id = f.user_id
        AND w.episode_id IN (SELECT id FROM tracker_episodes WHERE drama_id = f.drama_id
                              AND ($2 OR NOT is_demo))
      WHERE f.user_id = $1 AND ($2 OR NOT d.is_demo)
      GROUP BY f.drama_id
      ORDER BY latest DESC`,
    [userId, demo]
  );
  for (const row of res.rows) {
    const un = await pool.query(
      `SELECT id, season, number, title, minutes, watch_url
         FROM tracker_episodes
        WHERE drama_id = $1 AND ($3 OR NOT is_demo) AND NOT EXISTS (
          SELECT 1 FROM tracker_watches WHERE user_id = $2 AND episode_id = tracker_episodes.id)
        ORDER BY season, number LIMIT 1`,
      [row.drama_id, userId, demo]
    );
    if (!un.rows.length) continue;
    const hero = un.rows[0];
    const later = await pool.query(
      `SELECT id, season, number, title, minutes, watch_url
         FROM tracker_episodes
        WHERE drama_id = $1 AND season = $2 AND number > $3 AND ($5 OR NOT is_demo)
          AND NOT EXISTS (SELECT 1 FROM tracker_watches WHERE user_id = $4 AND episode_id = tracker_episodes.id)
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
tracker.use(async (req, res, next) => {
  try {
    if (demoOn(req) && req.user) {
      const has = await pool.query(
        `SELECT 1 FROM tracker_follows WHERE user_id = $1 AND drama_id = 900001`, [req.user.id]
      );
      if (!has.rows.length) await seedDemoViewer(req.user);
    }
  } catch (err) {
    console.error('demo viewer seed failed', err);
  }
  next();
});

// ── API routes ────────────────────────────────────────────────────────────

// Who is signed in, if anyone (the page asks, not the URL: at the app's own
// address there is no ?token= for the frontend to read).
tracker.get('/me', (req, res) => {
  res.json({
    user: req.user ? { id: req.user.id, username: req.user.username } : null,
    guest: !!req.guest,
  });
});

tracker.get('/feed', async (req, res) => {
  try {
    const demo = demoOn(req);
    const viewerId = req.user ? req.user.id : null;
    const viewerName = req.user ? req.user.username : null;
    // Dramas newest first.
    const dramas = await pool.query(
      `SELECT id, title, synopsis, added_by_id, added_by_username, created_at
         FROM tracker_dramas WHERE ${demoClause(req, 'is_demo', 1)}
        ORDER BY created_at DESC, id DESC`,
      demoParams(req)
    );
    const ids = dramas.rows.map(d => d.id);

    // Season and episode counts.
    const counts = ids.length ? await pool.query(
      `SELECT drama_id, COUNT(*) AS episodes, COUNT(DISTINCT season) AS seasons
         FROM tracker_episodes WHERE ${demoClause(req, 'is_demo', 1)} AND drama_id = ANY($2)
        GROUP BY drama_id`, [...demoParams(req), ids]
    ) : { rows: [] };
    const countBy = new Map(counts.rows.map(c => [c.drama_id, c]));

    // The viewer's follows.
    let followed = new Set();
    if (viewerId && ids.length) {
      const f = await pool.query(
        `SELECT drama_id FROM tracker_follows WHERE user_id = $1 AND drama_id = ANY($2)
          AND ($3 OR NOT EXISTS (SELECT 1 FROM tracker_dramas d WHERE d.id = drama_id AND d.is_demo))`,
        [viewerId, ids, demo]
      );
      followed = new Set(f.rows.map(r => Number(r.drama_id)));
    }

    // Episodes per drama, with who has watched each (for the notes).
    let eps = { rows: [] };
    if (ids.length) {
      eps = await pool.query(
        `SELECT e.id, e.drama_id, e.season, e.number,
                ARRAY(SELECT w.username FROM tracker_watches w WHERE w.episode_id = e.id
                      ORDER BY w.watched_at) AS watchers,
                EXISTS (SELECT 1 FROM tracker_watches w WHERE w.episode_id = e.id AND w.user_id = $3) AS viewer_watched,
                (e.created_at > now() - interval '7 days') AS is_new
           FROM tracker_episodes e
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

tracker.post('/dramas', async (req, res) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const synopsis = typeof req.body.synopsis === 'string' ? req.body.synopsis.trim() : '';
    if (!title || title.length > 80) return res.status(400).json({ error: 'A title of 1 to 80 characters is required' });
    if (synopsis.length > 280) return res.status(400).json({ error: 'The description must be 280 characters or fewer' });
    const r = await pool.query(
      `INSERT INTO tracker_dramas (title, synopsis, added_by_id, added_by_username)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, synopsis || null, req.user.id, req.user.username]
    );
    return res.status(201).json({ drama: r.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not add the drama' });
  }
});

tracker.delete('/dramas/:id', async (req, res) => {
  try {
    const d = await pool.query(`SELECT added_by_id FROM tracker_dramas WHERE id = $1`, [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    if (Number(d.rows[0].added_by_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who added it can remove it' });
    }
    await pool.query(`DELETE FROM tracker_dramas WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not remove the drama' });
  }
});

tracker.get('/dramas/:id', async (req, res) => {
  try {
    const viewerId = req.user ? req.user.id : null;
    const d = await pool.query(
      `SELECT id, title, synopsis, added_by_id, added_by_username, created_at
         FROM tracker_dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    const drama = d.rows[0];
    const eps = await pool.query(
      `SELECT e.id, e.season, e.number, e.title, e.minutes, e.watch_url,
              e.added_by_id, e.added_by_username,
              ARRAY(SELECT w.username FROM tracker_watches w WHERE w.episode_id = e.id
                    ORDER BY w.watched_at) AS watched_by,
              EXISTS (SELECT 1 FROM tracker_watches w WHERE w.episode_id = e.id AND w.user_id = $3) AS viewer_watched
         FROM tracker_episodes e WHERE e.drama_id = $1 AND ${demoClause(req, 'e.is_demo', 2)}
        ORDER BY e.season, e.number`,
      [req.params.id, ...demoParams(req), viewerId || 0]
    );
    const following = viewerId
      ? (await pool.query(`SELECT 1 FROM tracker_follows WHERE user_id = $1 AND drama_id = $2`, [viewerId, req.params.id])).rows.length > 0
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

tracker.post('/dramas/:id/episodes', async (req, res) => {
  try {
    const d = await pool.query(
      `SELECT id FROM tracker_dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
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
    const exists = await pool.query(
      `SELECT 1 FROM tracker_episodes WHERE drama_id = $1 AND season = $2 AND number = $3`,
      [req.params.id, season, number]
    );
    if (exists.rows.length) return res.status(409).json({ error: 'That season and episode number already exists' });
    const r = await pool.query(
      `INSERT INTO tracker_episodes (drama_id, season, number, title, minutes, watch_url, added_by_id, added_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.params.id, season, number, title, minutes, watch_url, req.user.id, req.user.username]
    );
    return res.status(201).json({ episode: r.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not add the episode' });
  }
});

tracker.delete('/episodes/:id', async (req, res) => {
  try {
    const e = await pool.query(`SELECT added_by_id FROM tracker_episodes WHERE id = $1`, [req.params.id]);
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
    if (Number(e.rows[0].added_by_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who added it can remove it' });
    }
    await pool.query(`DELETE FROM tracker_episodes WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not remove the episode' });
  }
});

tracker.put('/dramas/:id/follow', async (req, res) => {
  try {
    const d = await pool.query(
      `SELECT id FROM tracker_dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    await pool.query(
      `INSERT INTO tracker_follows (user_id, username, drama_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.user.id, req.user.username, req.params.id]
    );
    return res.json({ following: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not follow' });
  }
});

tracker.delete('/dramas/:id/follow', async (req, res) => {
  try {
    await pool.query(`DELETE FROM tracker_follows WHERE user_id = $1 AND drama_id = $2`, [req.user.id, req.params.id]);
    return res.json({ following: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not unfollow' });
  }
});

tracker.put('/episodes/:id/watched', async (req, res) => {
  try {
    const e = await pool.query(`SELECT id FROM tracker_episodes WHERE id = $1`, [req.params.id]);
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
    await pool.query(
      `INSERT INTO tracker_watches (user_id, username, episode_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.user.id, req.user.username, req.params.id]
    );
    return res.json({ watched: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not mark watched' });
  }
});

tracker.delete('/episodes/:id/watched', async (req, res) => {
  try {
    await pool.query(`DELETE FROM tracker_watches WHERE user_id = $1 AND episode_id = $2`, [req.user.id, req.params.id]);
    return res.json({ watched: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not unmark watched' });
  }
});

// Recorded only, nothing is hidden automatically.
tracker.post('/reports', async (req, res) => {
  try {
    const dramaId = req.body.drama_id ? parseInt(req.body.drama_id, 10) : null;
    const episodeId = req.body.episode_id ? parseInt(req.body.episode_id, 10) : null;
    if (!dramaId && !episodeId) return res.status(400).json({ error: 'A drama or an episode is required' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
    if (reason && reason.length > 500) return res.status(400).json({ error: 'The reason must be 500 characters or fewer' });
    await pool.query(
      `INSERT INTO tracker_reports (reporter_id, reporter_username, drama_id, episode_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, req.user.username, dramaId, episodeId, reason]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not send the report' });
  }
});

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
  // The shared drama tracker is its own page; everything else is the app.
  res.sendFile(path.join(__dirname, 'public', req.path === '/tracker' ? 'tracker.html' : 'index.html'));
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
  await ensureTrackerSchema();
  if (IS_STAGING) {
    try {
      await seedTrackerDemo();
    } catch (err) {
      console.error('tracker demo seed failed', err);
    }
  }
  const server2 = app.listen(port, () => console.log(`Listening on :${port}`));
  // Expose for the shutdown handler.
  server = server2;
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server2.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

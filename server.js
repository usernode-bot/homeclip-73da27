const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { isProfane, isSpam, loose } = require('./moderation');
const { probeArtwork } = require('./art-probe');
const tmdb = require('./providers/tmdb');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Episode video source for imported dramas: the six committed, same-origin
// clips in public/sample/ (trims of Blender Foundation CC BY open movies,
// each committed as .mp4 (H.264+AAC) and .webm (VP9+Opus)). URLs are
// extensionless; the player appends the extensions and offers both sources.
// The pool carries no catalog content of its own: the bundled sample dramas
// are gone (see wipeCatalogOnce) and only curator imports reference it.
const VIDEO_BASE = '';
const VIDEO_POOL = [
  '/sample/bunny',     // Big Buck Bunny
  '/sample/sintel',    // Sintel
  '/sample/elephants', // Elephants Dream
  '/sample/tears',     // Tears of Steel
  '/sample/cosmos',    // Cosmos Laundromat
  '/sample/spring',    // Spring
];

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

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
// /api/subscription is a GET whose answer for anyone without an account is
// the constant free shape, so opening it to signed-out visitors (the page
// asks for it on every boot, and a 401 would log a console error) carries
// no data. The Stripe webhook is called by Stripe's servers, which carry no
// platform token; it is authenticated by its own HMAC signature instead
// (see the route below).
const PUBLIC_API_PATHS = new Set(['/health', '/api/subscription', '/api/webhooks/stripe']);

// Keep the raw request body alongside the parsed one: Stripe webhook
// signatures are computed over the exact bytes on the wire, so re-serialising
// the parsed object would break verification.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

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

// ── Legacy table rename (idempotent, applied before the schema) ───────────
// Before the streaming catalog, the tracker's tables were named dramas /
// episodes / follows / watches / reports. The catalog now owns the names
// dramas and episodes, so on a database created before the rename the
// tracker's tables are moved to their new names first. A rename keeps the
// group's real tracker data (added dramas, follows, watches, reports) and
// frees the names for the catalog's fresh tables; foreign keys follow a
// rename, so comments, reviews, playback and tracker_reports keep pointing
// at the right tables. Each rename runs only when the old table still
// exists and the new one does not, and the old table is genuinely the
// tracker's: the catalog later re-creates dramas and episodes under the old
// names, so each of those pairs carries a signature column only the
// catalog's table has (popularity on dramas, num on episodes). A table with
// its signature is the catalog's, and the rename already ran.
const LEGACY_TRACKER_TABLES = [
  ['dramas', 'tracker_dramas', 'popularity'],
  ['episodes', 'tracker_episodes', 'num'],
  ['follows', 'tracker_follows', null],
  ['watches', 'tracker_watches', null],
  ['reports', 'tracker_reports', null],
];

async function tableExists(name) {
  const r = await pool.query('SELECT to_regclass($1) IS NOT NULL AS yes', ['public.' + name]);
  return r.rows[0].yes;
}

async function tableHasColumn(table, column) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`, [table, column]);
  return r.rowCount > 0;
}

const ARCHIVE_SUFFIX = '_legacy_pre_catalog';

// One transaction per pair: the two halves of a rename can never be seen
// separately, and a halfway failure rolls back instead of leaving a
// database that poisons the next boot. Two boots racing each other are
// handled by re-checking both names inside the transaction (the second
// boot sees the target already there and recovers through the copy path)
// and by catching the SQLSTATEs that say the rename already happened.
async function migrateLegacyTrackerTables() {
  for (const [oldName, newName, catalogColumn] of LEGACY_TRACKER_TABLES) {
    if (!await tableExists(oldName)) continue;
    if (catalogColumn && await tableHasColumn(oldName, catalogColumn)) {
      // The catalog's own table, not a legacy one: the rename already ran.
      continue;
    }
    if (await tableExists(newName)) {
      await recoverBothExist(oldName, newName);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check inside the transaction: another boot may have renamed
      // (or created) the target between the check above and now.
      const stillOld = await client.query(
        'SELECT to_regclass($1) IS NOT NULL AS yes', ['public.' + oldName]);
      const nowNew = await client.query(
        'SELECT to_regclass($1) IS NOT NULL AS yes', ['public.' + newName]);
      if (!stillOld.rows[0].yes) {
        await client.query('ROLLBACK');
        continue;
      }
      if (nowNew.rows[0].yes) {
        await client.query('ROLLBACK');
        await recoverBothExist(oldName, newName);
        continue;
      }
      await client.query(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
      await client.query('COMMIT');
      console.log(`[boot] migrated legacy tracker table ${oldName} -> ${newName}`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      // 42P01 (the legacy table vanished: another boot renamed it first)
      // and 42710/42P07 (a constraint or index name the rename carries is
      // already taken by the target) both mean the rename already ran
      // elsewhere. Re-check and carry on; anything else propagates.
      const benign = ['42P01', '42710', '42P07'].includes(err.code);
      if (benign && await tableExists(newName)) {
        console.log(`[boot] legacy table ${oldName} already renamed by another boot`);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

// Both the legacy and the tracker_* table exist for one pair. Recover
// without deleting anything: copy the legacy rows into the tracker_* table
// on the columns the two shapes share (existing tracker rows win), then
// rename the legacy table to an archived name so it stays readable for
// inspection and stops this branch from running on every boot.
async function recoverBothExist(oldName, newName) {
  const shared = (await pool.query(`
    SELECT a.column_name
    FROM information_schema.columns a
    JOIN information_schema.columns b
      ON b.column_name = a.column_name
    WHERE a.table_name = $1 AND a.table_schema = 'public'
      AND b.table_name = $2 AND b.table_schema = 'public'
    ORDER BY a.ordinal_position
  `, [oldName, newName])).rows.map((r) => r.column_name);
  if (!shared.length) {
    console.error(`[boot] legacy table ${oldName} and ${newName} share no columns; ` +
      `leaving ${oldName} untouched`);
    return;
  }
  const list = shared.map((c) => `"${c}"`).join(', ');
  const archived = `${oldName}${ARCHIVE_SUFFIX}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-check inside the transaction: another boot may have completed
    // this same recovery between the check above and now.
    const stillOld = await client.query(
      'SELECT to_regclass($1) IS NOT NULL AS yes', ['public.' + oldName]);
    if (!stillOld.rows[0].yes) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(
      `INSERT INTO ${newName} (${list}) SELECT ${list} FROM ${oldName} ON CONFLICT DO NOTHING`);
    const arch = await client.query(
      'SELECT to_regclass($1) IS NOT NULL AS yes', ['public.' + archived]);
    if (arch.rows[0].yes) {
      // An archived copy from an earlier recovery already exists: keep
      // both, under a name that cannot collide.
      await client.query(`ALTER TABLE ${oldName} RENAME TO ${archived}_${Date.now()}`);
    } else {
      await client.query(`ALTER TABLE ${oldName} RENAME TO ${archived}`);
    }
    await client.query('COMMIT');
    console.log(`[boot] legacy table ${oldName} and ${newName} both existed; ` +
      `copied legacy rows into ${newName} and archived ${oldName} as ${archived}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    // Recovery is best-effort: a failure here must not block the boot
    // (the catalog seed and every route come next). The legacy table is
    // left in place and this logs loudly instead.
    console.error(`[boot] could not recover both-exists state for ${oldName}: ${err.message}`);
  } finally {
    client.release();
  }
}

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
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'free' CHECK (access IN ('free','vip'));
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS fallback_url TEXT;
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
CREATE TABLE IF NOT EXISTS profiles (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  language TEXT NOT NULL DEFAULT 'system',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_account_name_idx ON profiles(account_id, name);
COMMENT ON TABLE my_list IS 'staging:private';
COMMENT ON TABLE watch_progress IS 'staging:private';
COMMENT ON TABLE settings IS 'staging:private';
COMMENT ON TABLE profiles IS 'staging:private';
`;

// Verified-metadata columns for the catalog (nullable additions, applied
// idempotently so databases created before this change migrate on boot).
// Artwork lives on the drama record itself: poster_url/backdrop_url come
// from a verified TMDB import (curator workflow), never a random image.
// tmdb_id is the provider's content ID — unique across imported records so
// one show cannot be imported twice; verified/needs_review decide whether
// the record shows real artwork or the neutral placeholder.
const CATALOG_ALTER_SQL = `
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS original_title TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS alternative_titles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS poster_url TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS backdrop_url TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS director TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS total_episodes INTEGER;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS episode_duration_min INTEGER;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS content_type TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS genres_raw TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS tmdb_id BIGINT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
-- Why a record sits in review: 'broken_link' | 'missing_poster' | 'manual'
-- (NULL on a legacy flagged record reads as manual too). Cleared with the
-- flag when the artwork re-checks clean or the record is re-imported.
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS review_reason TEXT;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS is_trending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
-- The drama's page on its authorized streaming platform (nullable): shown by
-- the player's "Episode unavailable" state while no licensed video source
-- exists. NULL means not configured — the overlay then omits the link.
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS watch_url TEXT;
-- An episode's video_url is now nullable: NULL means "no licensed source
-- configured" (a real show imported without streaming rights), and the
-- player must not stand a sample clip in for it. Existing rows keep their
-- committed sample-clip URLs.
ALTER TABLE episodes ALTER COLUMN video_url DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dramas_tmdb_id_idx ON dramas(tmdb_id) WHERE tmdb_id IS NOT NULL;
`;

// ?demo=1 requests (staging only) get the viewer's demo rows too; plain
// requests never see them.
function wantsDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

// Catalog rows marked is_demo (staging seed data) are excluded from every
// catalog response unless the request carries ?demo=1 — the same shape the
// tracker routes use for their own demo rows.
function catalogDemoWhere(demo) {
  return demo ? '' : ' AND NOT d.is_demo';
}

// ── One-time catalog wipe ─────────────────────────────────────────────────
// Every bundled movie and drama (the invented samples, the TMDB-curated
// boot seed and the staging demo dramas) was removed from the app in
// October 2026, together with the watch history and Continue Watching rows
// that pointed at it. This boot migration runs the DELETE exactly ONCE per
// database, guarded by a marker row, so a later restart never touches
// dramas a curator imported after the wipe. episodes, my_list and
// watch_progress reference dramas with ON DELETE CASCADE, so one DELETE
// clears them all; profiles and settings are untouched.
const CATALOG_WIPE_KEY = 'catalog-wipe-2026-10';
async function wipeCatalogOnce() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_migrations (
    key TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const done = await pool.query('SELECT 1 FROM app_migrations WHERE key = $1', [CATALOG_WIPE_KEY]);
  if (done.rowCount) return;
  const wiped = await pool.query('DELETE FROM dramas');
  await pool.query(
    'INSERT INTO app_migrations (key) VALUES ($1) ON CONFLICT DO NOTHING',
    [CATALOG_WIPE_KEY]
  );
  console.log('[catalog-wipe] removed ' + wiped.rowCount + ' dramas (one-time content wipe)');
}

// The viewing account's demo PROFILES: two fake profiles written once on
// the account's first ?demo=1 request, marked is_demo, so the Who's
// watching screen can be seen populated. Plain requests exclude them, so
// the production shape (no profiles until the person adds one) holds.
const DEMO_PROFILES = ['Staging demo viewer', 'Staging demo kids'];
async function seedViewerDemoProfiles(userId) {
  for (const name of DEMO_PROFILES) {
    await pool.query(
      `INSERT INTO profiles (account_id, name, language, is_demo)
       VALUES ($1,$2,'system',true)
       ON CONFLICT (account_id, name) DO NOTHING`,
      [userId, name]
    );
  }
}

const DRAMA_FIELDS = 'd.id, d.title, d.original_title, d.alternative_titles, d.poster_url, d.backdrop_url, d.watch_url, d.year, d.country, d.language, d.genres, d.genres_raw, d.rating, d.popularity, d.featured, d.cast_names, d.director, d.total_episodes, d.episode_duration_min, d.content_type, d.tmdb_id, d.source_url, d.verified, d.needs_review, d.review_reason, d.is_trending, d.is_demo, d.synopsis_en, d.synopsis_id';

// The catalog's genre vocabulary: what a filter may ask for and what a
// manual record may carry. Providers/tmdb.js maps provider genre names onto
// this same list, and the frontend's chips read it from i18n.
const CATALOG_GENRES = ['romance', 'thriller', 'fantasy', 'comedy', 'historical', 'action', 'drama', 'youth'];

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

// ── Profiles: per-account viewing profiles ("Who's watching?") ───────────
// All reads and writes are the signed-in account's own rows. Guests get
// the account_required shape; the client shows its sign-in prompt first.
const PROFILE_CAP = 5;

app.get('/api/profiles', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const demo = wantsDemo(req);
  if (demo) {
    const has = await pool.query('SELECT 1 FROM profiles WHERE account_id = $1 LIMIT 1', [req.user.id]);
    if (has.rowCount === 0) await seedViewerDemoProfiles(req.user.id);
  }
  const r = await pool.query(
    `SELECT id, name, language, created_at FROM profiles
      WHERE account_id = $1 ${demo ? '' : 'AND is_demo = false'}
      ORDER BY created_at, id`,
    [req.user.id]
  );
  res.json({ profiles: r.rows.map((p) => ({ ...p, id: Number(p.id) })) });
});

app.post('/api/profiles', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const language = ['system', 'en', 'id'].includes(req.body.language) ? req.body.language : 'system';
  if (!name || name.length > 40) {
    return res.status(400).json({ error: 'profile_name' });
  }
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM profiles WHERE account_id = $1', [req.user.id]);
  if (count.rows[0].n >= PROFILE_CAP) {
    return res.status(400).json({ error: 'profile_cap' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO profiles (account_id, name, language) VALUES ($1,$2,$3)
       RETURNING id, name, language, created_at`,
      [req.user.id, name, language]
    );
    return res.status(201).json({ profile: { ...r.rows[0], id: Number(r.rows[0].id) } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'profile_taken' });
    throw err;
  }
});

app.patch('/api/profiles/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const cur = await pool.query('SELECT id FROM profiles WHERE id = $1 AND account_id = $2', [req.params.id, req.user.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'profile_not_found' });
  const patch = req.body || {};
  const name = typeof patch.name === 'string' ? patch.name.trim() : '';
  if (!name || name.length > 40) return res.status(400).json({ error: 'profile_name' });
  const language = ['system', 'en', 'id'].includes(patch.language) ? patch.language : 'system';
  try {
    const r = await pool.query(
      `UPDATE profiles SET name = $3, language = $4 WHERE id = $1 AND account_id = $2
       RETURNING id, name, language, created_at`,
      [req.params.id, req.user.id, name, language]
    );
    return res.json({ profile: { ...r.rows[0], id: Number(r.rows[0].id) } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'profile_taken' });
    throw err;
  }
});

app.delete('/api/profiles/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const cur = await pool.query('SELECT id FROM profiles WHERE id = $1 AND account_id = $2', [req.params.id, req.user.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'profile_not_found' });
  const left = await pool.query(
    'SELECT COUNT(*)::int AS n FROM profiles WHERE account_id = $1 AND is_demo = false', [req.user.id]);
  if (left.rows[0].n <= 1) return res.status(400).json({ error: 'profile_last' });
  await pool.query('DELETE FROM profiles WHERE id = $1 AND account_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// Everything the Home screen needs, in one round trip.
app.get('/api/home', async (req, res) => {
  const demo = wantsDemo(req);
  const demoFilter = catalogDemoWhere(demo);
  if (demo && req.user) await seedDemoCatalogViewer(req.user);
  // Recommended for You: dramas sharing a genre with what the viewer has
  // watched or saved, best rated first, excluding what those rows already
  // show. Without that history (or for a guest) it falls back to the
  // catalog's top-rated dramas — a honest default, not a fake signal.
  let recommendedSql;
  let recommendedParams;
  if (req.user) {
    const g = await pool.query(
      `SELECT DISTINCT unnest(d.genres) AS g
       FROM (
         SELECT drama_id FROM watch_progress WHERE user_id = $1 ${demo ? '' : 'AND is_demo = false'}
         UNION SELECT drama_id FROM my_list WHERE user_id = $1 ${demo ? '' : 'AND is_demo = false'}
       ) a JOIN dramas d ON d.id = a.drama_id`,
      [req.user.id]
    );
    const preferred = g.rows.map((r) => r.g);
    if (preferred.length) {
      recommendedSql = `SELECT ${DRAMA_FIELDS} FROM dramas d
         WHERE true${demoFilter} AND d.genres && $1::text[] AND NOT (
           d.id IN (SELECT drama_id FROM watch_progress WHERE user_id = $2 ${demo ? '' : 'AND is_demo = false'})
           OR d.id IN (SELECT drama_id FROM my_list WHERE user_id = $2 ${demo ? '' : 'AND is_demo = false'}))
         ORDER BY d.rating DESC, d.popularity DESC LIMIT 12`;
      recommendedParams = [preferred, req.user.id];
    }
  }
  if (!recommendedSql) {
    recommendedSql = `SELECT ${DRAMA_FIELDS} FROM dramas d WHERE true${demoFilter}
       ORDER BY d.rating DESC, d.popularity DESC LIMIT 12`;
    recommendedParams = [];
  }
  // One row per genre the catalog actually has: a genre with no dramas
  // contributes no row, so nothing renders empty.
  const GENRE_ROW_KEYS = CATALOG_GENRES;
  const [featured, trending, series, recent, top10, shorts, cont, list, ...genreQs] = await Promise.all([
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE featured IS NOT NULL${demoFilter} ORDER BY featured LIMIT 5`),
    // Trending: the editorial is_trending pin over the popularity signal.
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE true${demoFilter} ORDER BY d.is_trending DESC, d.popularity DESC LIMIT 12`),
    // Popular Series: the catalog's series, most popular first — the
    // shorts' counterpart row.
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE d.content_type = 'series'${demoFilter} ORDER BY d.popularity DESC LIMIT 12`),
    // Recently Added: the newest catalog entries first, so a drama a
    // curator just imported leads the row.
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE true${demoFilter} ORDER BY d.id DESC LIMIT 12`),
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE true${demoFilter} ORDER BY d.rating DESC, d.popularity DESC LIMIT 10`),
    // Short dramas: a row of their own when the catalog has any.
    pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE d.content_type = 'short'${demoFilter} ORDER BY d.popularity DESC LIMIT 12`),
    req.user
      ? pool.query(
          `SELECT ${DRAMA_FIELDS}, w.ep, w.seconds, w.duration, w.updated_at
           FROM watch_progress w JOIN dramas d ON d.id = w.drama_id
           WHERE w.user_id = $1 ${demo ? '' : 'AND w.is_demo = false'}${demoFilter}
           ORDER BY w.updated_at DESC LIMIT 12`,
          [req.user.id])
      : { rows: [] },
    req.user
      ? pool.query(
          `SELECT ${DRAMA_FIELDS}, m.added_at
           FROM my_list m JOIN dramas d ON d.id = m.drama_id
           WHERE m.user_id = $1 ${demo ? '' : 'AND m.is_demo = false'}${demoFilter}
           ORDER BY m.added_at DESC LIMIT 12`,
          [req.user.id])
      : { rows: [] },
    ...GENRE_ROW_KEYS.map((g) =>
      pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE $1 = ANY(d.genres)${demoFilter} ORDER BY d.popularity DESC, d.rating DESC LIMIT 12`, [g])),
  ]);
  const genreRows = GENRE_ROW_KEYS
    .map((genre, i) => ({ genre, items: genreQs[i].rows }))
    .filter((r) => r.items.length);
  res.json({
    featured: featured.rows,
    trending: trending.rows,
    recommended: recommendedParams.length
      ? (await pool.query(recommendedSql, recommendedParams)).rows
      : (await pool.query(recommendedSql)).rows,
    series: series.rows,
    recent: recent.rows,
    top10: top10.rows,
    shortDramas: shorts.rows,
    continue: cont.rows,
    watchlist: list.rows,
    genreRows,
  });
});

// Browse / search with filters, sort and pagination.
app.get('/api/dramas', async (req, res) => {
  const { genre, country, year, sort, q } = req.query;
  const demo = wantsDemo(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(24, Math.max(6, parseInt(req.query.limit, 10) || 15));
  const where = [];
  const params = [];
  if (!demo) where.push('NOT d.is_demo');
  if (genre && CATALOG_GENRES.includes(genre)) {
    params.push(genre); where.push(`$${params.length} = ANY(d.genres)`);
  }
  if (country && /^[a-z]{2}$/.test(country)) {
    params.push(country); where.push(`d.country = $${params.length}`);
  }
  if (year && /^\d{4}$/.test(year)) {
    params.push(Number(year)); where.push(`d.year = $${params.length}`);
  }
  if (q && typeof q === 'string' && q.trim()) {
    params.push('%' + q.trim() + '%');
    // Real records carry the provider's original title too: search matches
    // either name, so a K-drama is findable under 사랑의 불시착 as well.
    where.push(`(d.title ILIKE $${params.length} OR d.original_title ILIKE $${params.length})`);
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
  if (wantsDemo(req) && req.user) await seedDemoCatalogViewer(req.user);
  const d = await pool.query(`SELECT ${DRAMA_FIELDS} FROM dramas d WHERE d.id = $1`, [id]);
  if (d.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  // Staging demo rows stay behind ?demo=1, like the list routes.
  if (d.rows[0].is_demo && !wantsDemo(req)) return res.status(404).json({ error: 'not_found' });
  const eps = await pool.query(
    'SELECT num, duration_min, video_url, access, fallback_url FROM episodes WHERE drama_id = $1 ORDER BY num', [id]
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
  // VIP is decided here, server-side, against req.now — the same rule the
  // tracker's gateEpisode() follows. A locked episode leaves WITHOUT its
  // video_url and fallback_url, so no amount of client-side editing can
  // unlock it; the player only ever sees the locked flag and the label.
  const vip = await viewerIsVip(req);
  const episodes = eps.rows.map((e) => {
    const locked = e.access === 'vip' && !vip;
    return {
      num: e.num,
      duration_min: e.duration_min,
      access: e.access || 'free',
      locked,
      video_url: locked ? null : e.video_url,
      fallback_url: locked ? null : e.fallback_url,
    };
  });
  // More like this: dramas sharing a genre with this one (more shared
  // genres rank higher), then the same country, then popularity.
  const me = d.rows[0];
  const similar = await pool.query(
    `SELECT ${DRAMA_FIELDS} FROM dramas d
     WHERE d.id <> $1${catalogDemoWhere(wantsDemo(req))} AND (d.genres && $2::text[] OR d.country = $3)
     ORDER BY (SELECT count(*) FROM unnest(d.genres) g WHERE g = ANY($2::text[])) DESC,
       (d.country = $3)::int DESC, d.popularity DESC, d.rating DESC LIMIT 12`,
    [id, me.genres || [], me.country || '']
  );
  res.json({ drama: me, episodes, inMyList, progress, similar: similar.rows });
});

// Wrap an async handler so a rejected promise answers 500 JSON instead of
// hanging the request.
const h = (fn) => (req, res) => {
  fn(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });
};

// ── Curator routes: verified metadata and poster artwork ─────────────────
// The drama catalog's records are filled through these routes: a curator
// searches TMDB, confirms the title and release year against the provider's
// record, and imports. The server NEVER trusts client metadata — every
// import re-fetches the record from TMDB and verifies before writing, and
// artwork paths must belong to that record's own image lists, so no
// hand-typed URL can pair a foreign poster with a title. Records imported
// without a provider match are saved needs_review with no artwork and
// render the neutral placeholder — never a stand-in image.
//
// The app has no role system, so the gate is signed-in membership (the same
// rule the tracker's write routes use), behind this one helper so a stricter
// roster can slot in later without touching the routes.
function requireCurator(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'account_required' });
    return false;
  }
  return true;
}

// Normalized title for the verify check: case, spacing and punctuation are
// ignored; the words must match.
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const TMDB_YEAR = (d) => (d ? Number(String(d).slice(0, 4)) : null);

// Read-only: search the provider catalog. Never saves anything.
app.get('/api/admin/tmdb/search', h(async (req, res) => {
  if (!requireCurator(req, res)) return;
  if (!tmdb.configured()) return res.status(503).json({ error: 'tmdb_not_configured' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ items: [] });
  res.json({ items: await tmdb.searchTv(q) });
}));

// Read-only: preview one provider record, with its selectable artwork.
app.get('/api/admin/tmdb/tv/:tmdbId', h(async (req, res) => {
  if (!requireCurator(req, res)) return;
  if (!tmdb.configured()) return res.status(503).json({ error: 'tmdb_not_configured' });
  const tmdbId = parseInt(req.params.tmdbId, 10);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return res.status(404).json({ error: 'not_found' });
  res.json({ record: await tmdb.getTv(tmdbId) });
}));

// Verify and import one provider record (POST /api/admin/dramas/import).
// b carries { tmdbId,
// confirmTitle, confirmYear, posterPath?, backdropPath?, contentType?,
// dramaId?, noSampleVideo? }; confirmTitle/confirmYear are required unless this is an
// artwork-only replace (dramaId set, no confirm fields). b.defaultArtwork
// picks the record's first poster and backdrop when the caller names no
// paths. Throws a coded Error on a failed check: the route maps it to its
// HTTP answer.
function importError(code, status) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  return err;
}

async function importVerifiedDrama(b) {
  const contentType = b.contentType === 'short' ? 'short' : 'series';
  if (!tmdb.configured()) throw importError('tmdb_not_configured', 503);
  const tmdbId = parseInt(b.tmdbId, 10);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw importError('bad_request', 400);
  const raw = await tmdb.getTv(tmdbId);
  // Artwork-only replace on an existing record (the studio's Replace
  // panel): no title/year confirm — the fresh provider fetch is still
  // where the artwork paths are validated, and the record's verified
  // metadata is left untouched.
  const artworkOnly = b.dramaId && b.confirmTitle === undefined;
  const nt = normTitle(b.confirmTitle);
  if (!artworkOnly) {
    const verifyOk = nt
      && (nt === normTitle(raw.title) || nt === normTitle(raw.originalTitle))
      && Number(b.confirmYear) === raw.year;
    if (!verifyOk) throw importError('verify_failed', 422);
  }
  if (artworkOnly && !b.posterPath && !b.backdropPath) {
    throw importError('bad_request', 400);
  }

  // The provider's content ID prevents duplicate records; re-importing a
  // show that is already in the catalog answers the existing drama.
  const dup = await pool.query('SELECT id FROM dramas WHERE tmdb_id = $1', [tmdbId]);
  if (dup.rowCount && dup.rows[0].id !== b.dramaId) {
    const err = importError('tmdb_duplicate', 409);
    err.existingId = dup.rows[0].id;
    throw err;
  }

  // Artwork paths must come from THIS record's own image lists.
  const requestedPoster = b.posterPath ||
    (b.defaultArtwork && raw.posters.length ? raw.posters[0].path : null);
  const requestedBackdrop = b.backdropPath ||
    (b.defaultArtwork && raw.backdrops.length ? raw.backdrops[0].path : null);
  const posterPath = requestedPoster && raw.posters.some((p) => p.path === requestedPoster)
    ? requestedPoster : null;
  const backdropPath = requestedBackdrop && raw.backdrops.some((p) => p.path === requestedBackdrop)
    ? requestedBackdrop : null;
  if ((requestedPoster && !posterPath) || (requestedBackdrop && !backdropPath)) {
    throw importError('unknown_artwork', 422);
  }
  const urls = await tmdb.artworkUrls(posterPath, backdropPath);

  const values = [
    raw.title, raw.originalTitle, raw.alternativeTitles, urls.posterUrl, urls.backdropUrl,
    raw.year, raw.country || '', raw.language, raw.genresRaw, tmdb.mapGenres(raw.genresRaw),
    raw.overview, raw.cast, raw.director, raw.totalEpisodes, raw.episodeDurationMin,
    contentType, raw.rating, tmdbId,
    'https://www.themoviedb.org/tv/' + tmdbId,
  ];

  if (b.dramaId) {
    // Re-verify / replace on an existing record (poster replacement).
    const id = parseInt(b.dramaId, 10);
    const cur = await pool.query('SELECT id FROM dramas WHERE id = $1', [id]);
    if (!cur.rowCount) throw importError('not_found', 404);
    if (artworkOnly) {
      // The artwork columns only: the verified metadata stays as it is.
      await pool.query(
        `UPDATE dramas SET poster_url=$1, backdrop_url=$2,
           needs_review=false, review_reason=NULL
         WHERE id=$3`,
        [urls.posterUrl, urls.backdropUrl, id]
      );
      return { ok: true, id };
    }
    await pool.query(
      `UPDATE dramas SET title=$1, original_title=$2, alternative_titles=$3, poster_url=$4,
         backdrop_url=$5, year=$6, country=$7, language=$8, genres_raw=$9, genres=$10,
         synopsis_en=$11, cast_names=$12, director=$13, total_episodes=$14,
         episode_duration_min=$15, content_type=$16, rating=$17, tmdb_id=$18, source_url=$19,
         verified=true, verified_at=now(), needs_review=false, review_reason=NULL
       WHERE id=$20`,
      [...values, id]
    );
    return { ok: true, id };
  }

  // New record: allocate the next id with a small retry. Simultaneous
  // curators can compute the same MAX(id)+1; the loser retries on the
  // unique violation with the fresh max.
  let id;
  for (let attempt = 0; ; attempt++) {
    const nxt = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM dramas');
    id = nxt.rows[0].n;
    try {
      await pool.query(
        `INSERT INTO dramas (id, title, original_title, alternative_titles, poster_url, backdrop_url,
           year, country, language, genres_raw, genres, synopsis_en, synopsis_id, cast_names, director,
           total_episodes, episode_duration_min, content_type, rating, popularity, tmdb_id, source_url,
           verified, verified_at, needs_review)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'',$13,$14,$15,$16,$17,$18,0,$19,$20,
           true, now(), false)`,
        [id, ...values]
      );
      break;
    } catch (e) {
      if (e.code === '23505' && attempt < 2) continue;
      throw e;
    }
  }
  // Episodes point at the committed six-clip pool so playback keeps
  // working — the catalog's stride (id*5+n)%6, never a URL that does not
  // exist. A flat 1..n list for phase one (no season column yet).
  // b.noSampleVideo opts OUT of the pool: a real show with no licensed
  // streaming source gets video_url NULL — the player answers with the
  // honest "Episode unavailable" state, never a sample clip standing in
  // for a real show.
  const eps = Math.min(raw.totalEpisodes || 0, 100);
  for (let n = 1; n <= eps; n++) {
    await pool.query(
      `INSERT INTO episodes (drama_id, num, duration_min, video_url)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (drama_id, num) DO NOTHING`,
      [id, n, raw.episodeDurationMin || 45, b.noSampleVideo ? null : VIDEO_BASE + VIDEO_POOL[(id * 5 + n) % VIDEO_POOL.length]]
    );
  }
  return { ok: true, id };
}

// Verify and import. With tmdbId: the server re-fetches the record and
// checks the curator's confirmed title (against the provider's title OR
// original title) and year BEFORE writing; a mismatch writes nothing.
// Without tmdbId: a manual record, saved needs_review with no artwork.
app.post('/api/admin/dramas/import', h(async (req, res) => {
  if (!requireCurator(req, res)) return;
  const b = req.body || {};
  if (!b.tmdbId) {
    // Manual record: no provider match. Saved needs_review with NO artwork —
    // the neutral placeholder, never a stand-in poster.
    const contentType = b.contentType === 'short' ? 'short' : 'series';
    const title = String(b.title || '').trim();
    if (!title || title.length > 120) return res.status(400).json({ error: 'bad_request' });
    const year = parseInt(b.year, 10);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const country = /^[a-z]{2}$/.test(String(b.country || '')) ? String(b.country) : '';
    const synopsis = String(b.synopsis || '').slice(0, 2000);
    const genres = Array.isArray(b.genres)
      ? b.genres.filter((g) => CATALOG_GENRES.includes(g))
      : [];
    const nxt = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM dramas');
    const id = nxt.rows[0].n;
    await pool.query(
      `INSERT INTO dramas (id, title, year, country, genres, synopsis_en, synopsis_id, content_type,
         popularity, verified, needs_review, review_reason)
       VALUES ($1,$2,$3,$4,$5,$6,'',$7,0,false,true,'manual')`,
      [id, title, year, country, genres, synopsis, contentType]
    );
    return res.json({ ok: true, id, needsReview: true });
  }
  try {
    res.json(await importVerifiedDrama(b));
  } catch (e) {
    if (e.status) {
      const body = { error: e.code };
      if (e.existingId !== undefined) body.existingId = e.existingId;
      return res.status(e.status).json(body);
    }
    throw e;
  }
}));

// Curator record list: every catalog drama with its flags, for the studio's
// review list and artwork checks. Each stored same-origin artwork link also
// carries whether it actually resolves (poster_ok / backdrop_ok), so the
// studio can show the placeholder for a link known to be broken instead of
// asking the browser to request it and log the failure its own fallback was
// already papering over. Provider CDN links are left unprobed — checking
// those is the scan's on-demand job, not every list load's.
app.get('/api/admin/dramas', h(async (req, res) => {
  if (!requireCurator(req, res)) return;
  const demo = wantsDemo(req);
  const r = await pool.query(
    `SELECT ${DRAMA_FIELDS} FROM dramas d WHERE true${catalogDemoWhere(demo)} ORDER BY d.id`
  );
  const items = await Promise.all(r.rows.map(async (row) => ({
    ...row,
    poster_ok: row.poster_url && row.poster_url.startsWith('/')
      ? (await probeArtwork(row.poster_url)) === 'ok' : undefined,
    backdrop_ok: row.backdrop_url && row.backdrop_url.startsWith('/')
      ? (await probeArtwork(row.backdrop_url)) === 'ok' : undefined,
  })));
  res.json({ items });
}));

// Replace artwork or flip curator flags on one record. Poster/backdrop
// replacement re-validates the paths against the stored tmdb_id's own image
// lists — same fail-closed rule as import.
app.patch('/api/admin/dramas/:id', h(async (req, res) => {
  if (!requireCurator(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  const cur = await pool.query(
    'SELECT tmdb_id, poster_url, needs_review, review_reason FROM dramas WHERE id = $1', [id]);
  if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const sets = [];
  const params = [];
  let artworkPatched = false;

  if (b.posterPath !== undefined || b.backdropPath !== undefined) {
    artworkPatched = true;
    const tmdbId = cur.rows[0].tmdb_id;
    if (!tmdbId) return res.status(400).json({ error: 'not_imported' });
    if (!tmdb.configured()) return res.status(503).json({ error: 'tmdb_not_configured' });
    const raw = await tmdb.getTv(tmdbId);
    if (b.posterPath !== undefined) {
      if (!raw.posters.some((p) => p.path === b.posterPath)) {
        return res.status(422).json({ error: 'unknown_artwork' });
      }
      const urls = await tmdb.artworkUrls(b.posterPath, null);
      params.push(urls.posterUrl); sets.push(`poster_url = $${params.length}`);
    }
    if (b.backdropPath !== undefined) {
      if (!raw.backdrops.some((p) => p.path === b.backdropPath)) {
        return res.status(422).json({ error: 'unknown_artwork' });
      }
      const urls = await tmdb.artworkUrls(null, b.backdropPath);
      params.push(urls.backdropUrl); sets.push(`backdrop_url = $${params.length}`);
    }
  }
  if (b.needsReview !== undefined) {
    params.push(!!b.needsReview); sets.push(`needs_review = $${params.length}`);
  }
  if (b.contentType !== undefined) {
    if (!['short', 'series'].includes(b.contentType)) return res.status(400).json({ error: 'bad_request' });
    params.push(b.contentType); sets.push(`content_type = $${params.length}`);
  }
  if (b.isTrending !== undefined) {
    params.push(!!b.isTrending); sets.push(`is_trending = $${params.length}`);
  }
  if (b.featured !== undefined) {
    const f = b.featured === null ? null : parseInt(b.featured, 10);
    params.push(f); sets.push(`featured = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'bad_request' });
  params.push(id);
  await pool.query(`UPDATE dramas SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  // Fresh artwork that replaced a flagged one clears an ARTWORK-only flag
  // (the caller can confirm the new URLs with the per-record check). A
  // flag raised for another reason, or an explicit needsReview in the same
  // request, is left alone.
  if (artworkPatched && b.needsReview === undefined &&
      cur.rows[0].needs_review && ARTWORK_REASONS.includes(cur.rows[0].review_reason)) {
    await pool.query('UPDATE dramas SET needs_review = false, review_reason = NULL WHERE id = $1', [id]);
  }
  res.json({ ok: true });
}));

// probeArtwork(url) → 'ok' | 'broken' | 'missing' lives in art-probe.js,
// shared with scripts/verify-posters.js.

// The artwork defect on one record, if any: a stored link that no longer
// loads, or (on a verified record) no poster at all. Null means clean.
function artworkDefect(row, posterState, backdropState) {
  if (posterState === 'broken' || backdropState === 'broken') return 'broken_link';
  if (row.verified && !row.poster_url) return 'missing_poster';
  return null;
}

// Artwork reasons the app itself sets. A record flagged for another reason
// ('manual') keeps its flag — the scan never clears a flag it did not set.
const ARTWORK_REASONS = ['broken_link', 'missing_poster'];

// Artwork check on one record: probe each stored image URL; a broken link
// (or a verified record with no poster) flips the record to needs_review
// with the reason and is REPORTED — never silently ignored. A record whose
// artwork now probes clean loses an artwork-only flag.
app.post('/api/admin/dramas/:id/check-art', h(async (req, res) => {
  if (!requireCurator(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  const cur = await pool.query(
    'SELECT poster_url, backdrop_url, verified, needs_review, review_reason FROM dramas WHERE id = $1', [id]);
  if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
  const row = cur.rows[0];
  const results = { poster: await probeArtwork(row.poster_url), backdrop: await probeArtwork(row.backdrop_url) };
  const reason = artworkDefect(row, results.poster, results.backdrop);
  let cleared = false;
  if (reason && !row.needs_review) {
    await pool.query('UPDATE dramas SET needs_review = true, review_reason = $2 WHERE id = $1', [id, reason]);
  } else if (!reason && row.needs_review && ARTWORK_REASONS.includes(row.review_reason)) {
    await pool.query('UPDATE dramas SET needs_review = false, review_reason = NULL WHERE id = $1', [id]);
    cleared = true;
  }
  res.json({ ok: true, results, markedForReview: !!reason, cleared });
}));

// Artwork scan: the same probe across every catalog record, so broken
// links and verified records without a poster are found without clicking
// through records one at a time. Flags are written exactly as the
// per-record check writes them; nothing is un-flagged here.
app.post('/api/admin/dramas/check-art', h(async (req, res) => {
  if (!requireCurator(req, res)) return;
  const demo = wantsDemo(req);
  const r = await pool.query(
    `SELECT id, title, poster_url, backdrop_url, verified, needs_review
     FROM dramas d WHERE true${catalogDemoWhere(demo)} ORDER BY d.id`);
  const rows = r.rows;
  const flagged = [];
  const jobs = rows.map((row) => async () => {
    const posterState = await probeArtwork(row.poster_url);
    const backdropState = await probeArtwork(row.backdrop_url);
    const reason = artworkDefect(row, posterState, backdropState);
    if (reason && !row.needs_review) {
      await pool.query(
        'UPDATE dramas SET needs_review = true, review_reason = $2 WHERE id = $1', [row.id, reason]);
    }
    if (reason) flagged.push({ id: row.id, title: row.title, reason });
  });
  // Five probes at a time: a batch of records stays well inside the
  // request timeout even when several URLs hang to the probe cap.
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
    }
  }));
  res.json({ ok: true, checked: rows.length, flagged });
}));

app.get('/api/my-list', async (req, res) => {
  const demo = wantsDemo(req);
  const r = await pool.query(
    `SELECT ${DRAMA_FIELDS}, m.added_at
     FROM my_list m JOIN dramas d ON d.id = m.drama_id
     WHERE m.user_id = $1 ${demo ? '' : 'AND m.is_demo = false'}${demo ? '' : ' AND NOT d.is_demo'}
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
  const r = await pool.query(
    `SELECT ${DRAMA_FIELDS}, w.ep, w.seconds, w.duration, w.updated_at
     FROM watch_progress w JOIN dramas d ON d.id = w.drama_id
     WHERE w.user_id = $1 ${demo ? '' : 'AND w.is_demo = false'}${demo ? '' : ' AND NOT d.is_demo'}
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

app.get('/api/facets', async (req, res) => {
  const demo = wantsDemo(req);
  const demoFilter = catalogDemoWhere(demo);
  const r = await pool.query(
    `SELECT DISTINCT country FROM dramas d WHERE true${demoFilter} ORDER BY country`
  );
  const y = await pool.query(`SELECT DISTINCT year FROM dramas d WHERE true${demoFilter} ORDER BY year DESC`);
  res.json({ countries: r.rows.map(x => x.country), years: y.rows.map(x => x.year) });
});

// Placeholder poster art: a deterministic, original SVG generated from the
// drama itself (genre-hued gradient, a quiet pattern, the title). No
// copyrighted artwork anywhere. Served OUTSIDE /api/ on purpose: <img> tags
// cannot attach the auth header, and generated poster art is not sensitive.
const GENRE_HUES = { romance: 335, thriller: 255, fantasy: 200, comedy: 28, historical: 165, action: 280, youth: 150 };

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
    ? ['[Contoh takarir HomeClip]', 'Video contoh ini tidak memiliki dialog asli.', 'Selamat menonton.', 'Inilah akhir contoh.']
    : ['[HomeClip sample subtitles]', 'This sample video has no real dialogue.', 'Enjoy the show.', 'This is the end of the sample.'];
  // The committed clips run 30-60 s, so the cues now span the first 30 s
  // (10 s each) instead of the old 5-second clip's whole length.
  let cues = 'WEBVTT\n';
  lines.forEach((line, i) => {
    const a = i * 10;
    const b = a + 10;
    const stamp = (sec) => `00:00:${String(sec).padStart(2, '0')}.000`;
    cues += `\n${i + 1}\n${stamp(a)} --> ${stamp(b)}\n${line}\n`;
  });
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

// ── Subscription state ───────────────────────────────────────────────────

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
    // The video link is as locked as the watch link.
    media_url: locked ? null : (e.media_url || null),
  };
}

/* ── Plans, subscription management, payment history ────────────────────── */

tracker.get('/plans', (_req, res) => {
  res.json({
    provider: currentProvider().id,
    paymentConfigured: paymentConfigured(),
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, name: p.name, priceIdr: p.priceIdr,
      perMonthIdr: p.perMonthIdr, save: p.save, months: p.months,
    })),
  });
});

tracker.get('/me/subscription', h(async (req, res) => {
  res.json(subscriptionPayload(await vipStatus(req)));
}));

tracker.post('/subscription/cancel', h(async (req, res) => {
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

tracker.post('/subscription/resume', h(async (req, res) => {
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

tracker.get('/payments', h(async (req, res) => {
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

tracker.post('/coupon/validate', h(async (req, res) => {
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

tracker.post('/checkout', h(async (req, res) => {
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
tracker.get('/checkout/confirm', h(async (req, res) => {
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


// ── HTML entry points with per-request meta ───────────────────────────────
// The plain tracker shell (/tracker) is served by the catch-all below, with
// its default title and description. These paths serve the SAME shell with the
// meta block (title, description, Open Graph, Twitter card, JSON-LD,
// canonical) injected per request, so a drama or an episode pasted into a
// chat or found by a search engine describes itself. Canonical and share
// URLs are built from the request's own host and forwarded scheme: no
// hostname is ever written into this file.
const SHELL_PATH = path.join(__dirname, 'public', 'tracker.html');
const SHELL_DEFAULT_TITLE = '<title>HomeClip drama tracker</title>';
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
      ? `SELECT id, title, synopsis FROM tracker_dramas WHERE id = $1 AND ($2 OR NOT is_demo)`
      : `SELECT e.id, e.title, e.season, e.number, d.id AS drama_id, d.title AS drama_title, d.synopsis
           FROM tracker_episodes e JOIN tracker_dramas d ON d.id = e.drama_id
          WHERE e.id = $1 AND ($2 OR NOT e.is_demo)`,
    params
  );
  return rows.rows[0] || null;
}

app.get('/tracker/drama/:id', async (req, res) => {
  try {
    const d = await metaFor(req, 'drama');
    if (!d) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>HomeClip</title><p>Drama not found</p>');
    const title = d.title + ' — HomeClip';
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'TVSeries',
      name: d.title, description: d.synopsis || undefined,
    });
    return serveShell(req, res, title, d.synopsis || 'Watch ' + d.title + ' with your group on HomeClip',
      'video.tv_show', jsonLd, '/tracker/drama/' + d.id);
  } catch (err) { console.error(err); return res.sendStatus(500); }
});

app.get('/tracker/watch/:id', async (req, res) => {
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
      'video.episode', jsonLd, '/tracker/watch/' + e.id);
  } catch (err) { console.error(err); return res.sendStatus(500); }
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
      `SELECT id FROM tracker_dramas WHERE NOT is_demo ORDER BY id`);
    const origin = requestOrigin(req);
    const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      '<url><loc>' + origin + '/</loc></url>\n' +
      rows.rows.map(r => '<url><loc>' + origin + '/tracker/drama/' + r.id + '</loc></url>').join('\n') +
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
  // Sample-drama metadata: nullable, so dramas added before this change and
  // dramas added without them keep working. `cast` itself is a reserved SQL
  // word, so the cast column is cast_list.
  await pool.query(`ALTER TABLE tracker_dramas ADD COLUMN IF NOT EXISTS year INT`);
  await pool.query(`ALTER TABLE tracker_dramas ADD COLUMN IF NOT EXISTS country TEXT`);
  await pool.query(`ALTER TABLE tracker_dramas ADD COLUMN IF NOT EXISTS genres TEXT`);
  await pool.query(`ALTER TABLE tracker_dramas ADD COLUMN IF NOT EXISTS rating REAL
    CHECK (rating IS NULL OR (rating BETWEEN 0 AND 10))`);
  await pool.query(`ALTER TABLE tracker_dramas ADD COLUMN IF NOT EXISTS cast_list TEXT`);
  await pool.query(`ALTER TABLE tracker_dramas ADD COLUMN IF NOT EXISTS poster_url TEXT`);
  await pool.query(`ALTER TABLE tracker_dramas ADD COLUMN IF NOT EXISTS backdrop_url TEXT`);
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
  // Phase 5: where an episode's video lives, and its subtitles. Columns are
  // also added for databases created before they existed; the https check
  // lives in the API layer, which validates every write.
  await pool.query(`ALTER TABLE tracker_episodes ADD COLUMN IF NOT EXISTS media_url TEXT`);
  await pool.query(`ALTER TABLE tracker_episodes ADD COLUMN IF NOT EXISTS subtitle_url TEXT`);

  // Where the viewer stopped in an episode (the player reports it).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS playback (
      user_id BIGINT NOT NULL,
      episode_id BIGINT NOT NULL REFERENCES tracker_episodes(id) ON DELETE CASCADE,
      position_s INT NOT NULL DEFAULT 0,
      duration_s INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, episode_id)
    )`);
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

  // Phase 4a: comments (one level of replies), their likes, and drama
  // reviews. Each stores one person's own content, so each is
  // staging:private like follows/watches/reports. They reference only the
  // public dramas/episodes tables, so the public-to-private rule is not
  // triggered.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id BIGSERIAL PRIMARY KEY,
      episode_id BIGINT NOT NULL REFERENCES tracker_episodes(id) ON DELETE CASCADE,
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
      drama_id BIGINT NOT NULL REFERENCES tracker_dramas(id) ON DELETE CASCADE,
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
  await pool.query(`ALTER TABLE tracker_reports ADD COLUMN IF NOT EXISTS
    comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE`);
  // staging:private copies the schema to staging without the rows.
  await pool.query(`COMMENT ON TABLE tracker_follows IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE tracker_watches IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE tracker_reports IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE playback IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE events IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE client_errors IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE comments IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE comment_likes IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE reviews IS 'staging:private'`);

  // VIP: each episode is Free, VIP or Free with ads (decided server-side, see
  // gateEpisode); subscriptions, payments and coupons back the VIP plans.
  await pool.query(`
    ALTER TABLE tracker_episodes ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'free'
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
  // Sample video for the player, on two demo episodes only (the plain route
  // leaves is_demo rows out anyway). One is a real HLS test stream, the
  // other a small VP9 WebM served by the app itself: headless browsers that
  // ship no H.264 decoder (the check runner included) can still show real
  // playback, and being same-origin, Downloads work on it with no CORS
  // setup. The clip is Big Buck Bunny (CC BY, Blender Foundation), from
  // test-videos.co.uk.
  await pool.query(
    `UPDATE tracker_episodes SET media_url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        subtitle_url = '/demo/demo-subs.vtt'
      WHERE id = 9000012` // Harbour Lights, Season 2 Episode 6 "The Tide Table"
  );
  await pool.query(
    `UPDATE tracker_episodes SET media_url = '/demo/demo-video.webm'
      WHERE id = 9000063` // Copper Hill, Season 2 Episode 14 "The Last Shift"
  );
  // Access levels for the demo episodes: Harbour Lights season 2 mixes VIP
  // and ad episodes, The Quiet Wing is all VIP, Meridian Court has ads.
  await pool.query(`UPDATE tracker_episodes SET access = 'vip' WHERE is_demo AND (
    (drama_id = 900001 AND season = 2 AND number = 6) OR drama_id = 900002)`);
  await pool.query(`UPDATE tracker_episodes SET access = 'ads' WHERE is_demo AND (
    (drama_id = 900001 AND season = 2 AND number = 8) OR drama_id = 900004)`);
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

// ── Sample dramas (staging only) ─────────────────────────────────────────
// Twelve made-up dramas so a fresh preview looks full. Each carries full
// metadata (country, year, genres, an editorial rating out of 10, fictional
// cast) and 8 to 12 titled episodes, each with a placeholder watch link and
// a mix of Free, VIP and Free-with-ads access. Same rules as the demo
// above: fixed ids, ON CONFLICT DO NOTHING, fake identities only (Priya,
// Sam, Jun added them), is_demo rows only, nothing here runs in production,
// and every response without ?demo=1 leaves them out, so the plain route
// stays production-shaped. Posters stay the app's flat colour tiles unless
// a drama carries its own poster_url.
const SAMPLE_DRAMAS = [
  { id: 910001, title: 'Midnight Letters', country: 'Korea', year: 2025,
    genres: 'Romance', rating: 8.7, by: 'Priya', addedAgo: 45, epAgo: 12,
    cast: 'Han Ji-woo, Park Seo-yun, Lee Kang-min, Cho Da-in',
    synopsis: 'A night-shift postal clerk starts delivering letters that were never sent, and every one lands with the person who needed it most. When an envelope in her own handwriting arrives, dated ten years from now, she begins answering her future one letter at a time.',
    vip: [4, 9], ads: [6],
    eps: ['The Undelivered Tray', 'Return to Sender', "Ink That Won't Dry", 'The Night Desk', 'Ten Years Ahead', 'A Stamp for Tomorrow', 'The Dead Letter Shelf', 'Winter Deliveries', 'Her Own Handwriting', 'The Last Post'] },
  { id: 910002, title: 'The Last Harbor', country: 'Indonesia', year: 2024,
    genres: 'Thriller', rating: 8.2, by: 'Sam', addedAgo: 60, epAgo: 9,
    cast: 'Bagas Prasetyo, Rania Wijaya, Dimas Anggara, Sari Kusnadi',
    synopsis: 'A fishing crew returns to a Java Sea port one man short, and the captain swears the sea gave him no choice. A coast guard investigator with her own history in that port picks the story apart, tide by tide.',
    vip: [2, 7], ads: [4],
    eps: ['Nineteen Hours', 'The Missing Logbook', 'Slack Water', 'The Second Boat', 'Ghost Nets', 'Monsoon File', 'The Harbor Wall', 'What the Sea Kept'] },
  { id: 910003, title: 'Crown of Ash', country: 'China', year: 2023,
    genres: 'Historical', rating: 8.9, by: 'Jun', addedAgo: 75, epAgo: 30,
    cast: 'Lin Wanyu, Zhao Cheng, Xu Meilin, Fang Zhou',
    synopsis: "The empire's youngest general is handed a burnt province and an order to make it loyal again. Between a shrewd regent and a famine she cannot name in writing, she learns that ruling well costs more than winning wars.",
    vip: [5, 11], ads: [8],
    eps: ['The Burnt Province', 'An Oath of Rice', "The Regent's Game", 'Ash Roads', 'The Grain Convoy', 'A Season of Banners', 'The Paper Tiger', 'Frost over the Yamen', 'Letters from the Front', 'The Long Winter', 'A Crown of Ash', 'The Reckoning'] },
  { id: 910004, title: 'Neon Hearts', country: 'Japan', year: 2025,
    genres: 'Romance, Comedy', rating: 7.9, by: 'Jun', addedAgo: 20, epAgo: 6,
    cast: 'Aoi Fujimura, Ken Yamashiro, Miyu Tanabe, Riku Hoshino',
    synopsis: 'A failed idol and a nosy late-night radio host share an Osaka alley, a ruined karaoke booth and one increasingly public misunderstanding. Neither of them will admit the show everyone tunes in for is them.',
    vip: [7], ads: [3, 8],
    eps: ['Dead Air', 'The Karaoke Truce', 'Song Number Four', 'Rumors at 2 a.m.', 'The Apology Track', 'Live from the Alley', 'A Duet, Sort Of', 'The Ratings Spike', 'Sign-Off'] },
  { id: 910005, title: 'Shadow Archive', country: 'Korea', year: 2024,
    genres: 'Mystery', rating: 8.5, by: 'Priya', addedAgo: 40, epAgo: 15,
    cast: 'Yoon Tae-oh, Seo Ha-eun, Jung Min-seok, Bae Chae-rin',
    synopsis: 'An archivist in a sealed records hall finds a file about a murder that has not happened yet. Every folder she opens points at someone she knows, and the archive has already indexed her.',
    vip: [6, 10], ads: [2],
    eps: ['File 001', 'The Sealed Wing', 'A Borrowed Name', 'Index of the Missing', 'The Second Folder', 'Cold Stacks', 'The Wrong Record', 'Chain of Custody', 'The Archive Answers', 'Final Entry'] },
  { id: 910006, title: 'Café Under the Rain', country: 'Thailand', year: 2025,
    genres: 'Slice of Life', rating: 7.8, by: 'Sam', addedAgo: 25, epAgo: 4,
    cast: 'Nalin Suriya, Thanakit Boon, Ploy Rattanakorn, Anon Chai',
    synopsis: 'A Chiang Mai coffee shop opens its doors only when it rains, and the regulars plan their lives around the weather. Over one stormy season, four strangers become the kind of friends who refill each other\'s cups.',
    vip: [8], ads: [5],
    eps: ['Forecast: Open', "The Regulars' Table", 'One Sugar, No Rain', 'The Broken Umbrella', 'Monsoon Season', 'Closing Early', 'The Last Dry Day', 'Sunshine Policy'] },
  { id: 910007, title: "Dragon's Oath", country: 'China', year: 2024,
    genres: 'Fantasy, Action', rating: 8.8, by: 'Sam', addedAgo: 55, epAgo: 10,
    cast: 'Bai Luqing, Tang Renjie, Hua Ying, Guan Zhihao',
    synopsis: "A blacksmith's apprentice inherits an oath blade that chooses its own bearer, and a war between the nine river sects is already looking for it. To keep it, she has to honor a promise a dragon made two hundred years ago.",
    vip: [3, 9, 12], ads: [6],
    eps: ['The Oath Blade', 'Nine Rivers, Nine Sects', 'The Forge at Night', 'The River Gate', 'Smoke and Iron', "The Dragon's Term", 'Apprentice No More', 'The Broken Sheath', 'War Council', 'The Long Climb', 'Two Hundred Years', 'The Oath Kept'] },
  { id: 910008, title: 'Borrowed Time', country: 'Korea', year: 2026,
    genres: 'Sci-Fi, Drama', rating: 9.1, by: 'Jun', addedAgo: 10, epAgo: 2,
    cast: 'Kang Da-hyun, Im Yoo-ri, Shin Woo-jin, Oh Na-kyung',
    synopsis: 'A clockmaker signs up for a trial that lends her twenty extra years, payable in kind. The bills come due as memories, and the collector is someone she once loved.',
    vip: [4, 8, 10], ads: [7],
    eps: ['The Trial', 'Twenty Years, No Interest', 'The First Payment', 'Collateral', 'A Debt of Memories', 'The Collector Calls', 'Compounding', 'Grace Period', 'The Fine Print', 'Settled in Full'] },
  { id: 910009, title: 'Family Rules', country: 'Indonesia', year: 2025,
    genres: 'Comedy, Family', rating: 7.6, by: 'Priya', addedAgo: 30, epAgo: 7,
    cast: 'Bagus Nugroho, Lestari Halim, Fajar Pratama, Dewi Anggraini',
    synopsis: 'Three generations under one Jakarta roof agree on a house rulebook to stop the arguing, then spend the season lawyering every clause. Rule 12, about the last portion of sambal, nearly ends them all.',
    vip: [9], ads: [4],
    eps: ['The Rulebook', 'Clause by Clause', 'The Sambal Accords', 'Quiet Hours', 'The Remote Control Treaty', 'Family Court', 'Amendment Season', 'The House Meeting', 'House Rules, Revised'] },
  { id: 910010, title: 'Silent Witness', country: 'Japan', year: 2023,
    genres: 'Crime', rating: 8.3, by: 'Jun', addedAgo: 70, epAgo: 26,
    cast: 'Mizuki Harada, Sora Kitagawa, Naomi Ueshima, Takumi Ono',
    synopsis: 'A sign-language interpreter is the only person who saw what happened on the platform, and the suspect list includes the detective she must interpret for. Speaking up would end her career, and staying silent has its own price.',
    vip: [5, 9], ads: [3],
    eps: ['Platform Nine', 'The Interpreter', 'What the Hands Said', 'Chain of Silence', 'The Second Witness', 'Interview Room Three', 'The Loose Transcript', 'Cross-Examination', 'Spoken At Last'] },
  { id: 910011, title: 'Spring Again', country: 'Korea', year: 2026,
    genres: 'Romance', rating: 8.1, by: 'Priya', addedAgo: 8, epAgo: 1,
    cast: 'Cha Min-joon, Yeo Ha-rin, Kwon Do-yoon, Moon Se-yeon',
    synopsis: 'A botanist who catalogues cherry blossoms keeps meeting the same stranger one spring apart, each of them a year older and a year more careful. Somewhere between the first bloom and the last, they have to decide which spring is the real one.',
    vip: [7], ads: [2],
    eps: ['First Bloom', 'A Year Between', 'The Specimen Book', 'Petal Count', 'Late Frost', 'The Second Spring', 'Cherry Season', 'Full Bloom'] },
  { id: 910012, title: 'The Golden Heir', country: 'Thailand', year: 2024,
    genres: 'Drama', rating: 8.0, by: 'Sam', addedAgo: 50, epAgo: 20,
    cast: 'Kannika Prasert, Thanin Wattana, Malee Chaiyaporn, Nop Sangthong',
    synopsis: "A Bangkok family's gold-trading empire needs an heir, and the will names the one relative nobody has heard from in fifteen years. Every cousin, creditor and housekeeper picks a side before the reading is over.",
    vip: [4, 10], ads: [6],
    eps: ['The Reading', 'Fifteen Years Gone', 'The Gold Ledger', 'Cousins at War', "The Housekeeper's Key", 'A Long-Lost Letter', 'The Second Will', 'Gold and Water', 'The Family Meeting', 'The Vault', 'The Heir Chooses'] },
];

// Who of the fake members follows which sample drama: this is the signal the
// Trending Now row orders by, and nothing else reads it.
const SAMPLE_FOLLOWS = [
  ['Priya', 910001], ['Priya', 910005], ['Priya', 910011],
  ['Sam', 910002], ['Sam', 910007], ['Sam', 910012],
  ['Jun', 910003], ['Jun', 910004], ['Jun', 910008], ['Jun', 910010],
];

async function seedSampleDramas() {
  // Fixed episode ids from 9200001 upward, in definition order, so a re-seed
  // after a partial boot still lands on the same rows.
  let epId = 9200001;
  for (const s of SAMPLE_DRAMAS) {
    const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    await pool.query(
      `INSERT INTO tracker_dramas
         (id, title, synopsis, added_by_id, added_by_username, is_demo, created_at,
          year, country, genres, rating, cast_list, poster_url)
       VALUES ($1, $2, $3, $4, $5, true, now() - make_interval(days => $6::int),
               $7, $8, $9, $10, $11, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.title, s.synopsis, DEMO_USERS[s.by], s.by, s.addedAgo,
       s.year, s.country, s.genres, s.rating, s.cast]
    );
    for (let i = 0; i < s.eps.length; i++) {
      const number = i + 1;
      // 35 to 60 minutes, varied deterministically per drama and episode.
      const minutes = 38 + ((s.id + i * 7) % 20);
      const access = s.vip.includes(number) ? 'vip' : s.ads.includes(number) ? 'ads' : 'free';
      await pool.query(
        `INSERT INTO tracker_episodes
           (id, drama_id, season, number, title, minutes, watch_url, access,
            added_by_id, added_by_username, is_demo, created_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, true,
                 now() - make_interval(days => $10::int))
         ON CONFLICT (id) DO NOTHING`,
        [epId, s.id, number, s.eps[i], minutes,
         'https://example.com/watch/' + slug + '-e' + number, access,
         DEMO_USERS[s.by], s.by, s.epAgo]
      );
      epId++;
    }
  }
  for (const [name, dramaId] of SAMPLE_FOLLOWS) {
    await pool.query(
      `INSERT INTO tracker_follows (user_id, username, drama_id, created_at)
       VALUES ($1, $2, $3, now() - interval '8 days') ON CONFLICT DO NOTHING`,
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
      `SELECT id, season, number, title, minutes, watch_url, media_url, access
         FROM tracker_episodes
        WHERE drama_id = $1 AND ($3 OR NOT is_demo) AND NOT EXISTS (
          SELECT 1 FROM tracker_watches WHERE user_id = $2 AND episode_id = tracker_episodes.id)
        ORDER BY season, number LIMIT 1`,
      [row.drama_id, userId, demo]
    );
    if (!un.rows.length) continue;
    const hero = un.rows[0];
    const later = await pool.query(
      `SELECT id, season, number, title, minutes, watch_url, media_url, access
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

// ── Staging demo catalog ──────────────────────────────────────────────────
// The streaming catalog ships EMPTY and nothing reseeds it (see the October
// 2026 wipe): new dramas arrive only through the Posters studio. But a
// staging preview of an empty catalog would show nothing to review, so —
// like the tracker's demo dramas — staging seeds ten obviously fictional
// Chinese dramas, fixed ids 820001-820010, is_demo = true. Every plain route
// leaves is_demo rows out, so production reads stay production-shaped and
// the existing empty-state tests keep passing. poster_url/backdrop_url are
// NULL: the generated art renders, and no image URL is ever fabricated.
const DEMO_CATALOG = [
  { id: 820001, title: 'Lanterns Over Goose Hill', original: '鹅山灯火', year: 2025,
    genres: ['historical', 'romance'], genresRaw: ['古装', '爱情'], rating: 8.7, pop: 98,
    featured: 1, trending: true, type: 'series', eps: 16, dur: 45,
    cast: ['Lin Wanqing', 'Shen Muyang', 'Gao Zhilan', 'Xu Beiming'],
    director: 'Fang Yuran',
    en: 'In 1930s Jiangnan, a lantern-maker\'s daughter trades her family\'s craft for a printing press — and collides with the reformist schoolteacher who prints on it.',
    id_: 'Jiangnan tahun 1930-an: putri pembuat lentera menukar kerajinan keluarganya dengan mesin cetak, dan bertemu guru sekolah reformis yang mencetak di sana.' },
  { id: 820002, title: 'Cloud Sword Chronicles', original: '云剑纪', year: 2024,
    genres: ['fantasy', 'action'], genresRaw: ['玄幻', '动作'], rating: 8.2, pop: 95,
    featured: null, trending: true, type: 'series', eps: 24, dur: 45,
    cast: ['Qi Luochen', 'Bai Suxin', 'Tan Xiaohou', 'Mo Yunfei'],
    director: 'Liang Chenghai',
    en: 'A disgraced sword sect outcast climbs the Nine Cloud Peaks to reclaim a stolen blade, discovering the war between the sects was staged by the one master he trusted.',
    id_: 'Seorang buangan sekte pedang mendaki Sembilan Puncak Awan untuk merebut kembali pedang curian, dan menemukan perang antar-sekte direkayasa oleh guru yang ia percayai.' },
  { id: 820003, title: 'The Noodle Shop Next Door', original: '巷口面馆', year: 2025,
    genres: ['comedy', 'romance'], genresRaw: ['喜剧', '爱情'], rating: 8.0, pop: 88,
    featured: null, trending: false, type: 'series', eps: 12, dur: 40,
    cast: ['Weng Xiaoman', 'Du Chengyi', 'Lu Pipa', 'Auntie Hao'],
    director: 'Ruan Qiaosheng',
    en: 'A food critic who torched a noodle shop in a review is sentenced by the internet to eat there every day for a year. The owner keeps count, and keeps score.',
    id_: 'Kritikus makanan yang menghancurkan kedai mi dalam ulasannya dihukum internet untuk makan di sana setiap hari selama setahun.' },
  { id: 820004, title: 'Midnight at Perfume House', original: '香阁夜话', year: 2023,
    genres: ['thriller', 'drama'], genresRaw: ['悬疑', '剧情'], rating: 7.9, pop: 84,
    featured: null, trending: false, type: 'series', eps: 20, dur: 45,
    cast: ['Song Liuli', 'He Jinglan', 'Master Wei', 'Xiao Cui'],
    director: 'Kang Weizhi',
    en: 'Every midnight the 1930s perfume house blends one more scent for one more client — and every scent, the police later find, belongs to a missing person.',
    id_: 'Setiap tengah malam rumah parfum tahun 1930-an meracik satu wewangian lagi untuk satu klien lagi — dan setiap wewangian ternyata milik orang yang hilang.' },
  { id: 820005, title: 'Paper Cranes in Spring', original: '春日纸鹤', year: 2026,
    genres: ['youth', 'romance'], genresRaw: ['青春', '爱情'], rating: 8.4, pop: 90,
    featured: null, trending: false, type: 'series', eps: 16, dur: 40,
    cast: ['Cheng Yuwei', 'Nan Qiao', 'Fei Dongdong', 'Teacher Gu'],
    director: 'Bai Luoshan',
    en: 'Two rival cram-school students fold paper cranes with exam wishes into the same library book for a year, never knowing the other is the person they sit behind.',
    id_: 'Dua siswa bimbingan bersaing melipat origami berisi harapan ujian ke buku perpustakaan yang sama selama setahun, tanpa tahu mereka duduk bersebelahan.' },
  { id: 820006, title: 'Wolf General of the Northern Pass', original: '北关狼将', year: 2022,
    genres: ['action', 'historical'], genresRaw: ['动作', '古装'], rating: 7.6, pop: 80,
    featured: null, trending: false, type: 'series', eps: 30, dur: 45,
    cast: ['Huo Zhanbei', 'Princess Yelü', 'General Deng', 'Old Shi'],
    director: 'Qin Hanjue',
    en: 'The empire\'s exiled wolf general is recalled to hold the Northern Pass with a garrison of convicts, against a horde that knows his every tactic — because he taught it.',
    id_: 'Jenderal serigala yang diasingkan dipanggil kembali untuk mempertahankan Gerbang Utara dengan pasukan tahanan, melawan musuh yang mengenal semua taktiknya.' },
  { id: 820007, title: 'The Jade Mirror Case', original: '玉镜奇案', year: 2024,
    genres: ['thriller', 'historical'], genresRaw: ['悬疑', '古装'], rating: 8.1, pop: 86,
    featured: null, trending: false, type: 'series', eps: 18, dur: 45,
    cast: ['Coroner Shen', 'Magistrate Pei', 'Widow Cui', 'Little An'],
    director: 'Tang Shuyi',
    en: 'A Tang-dynasty coroner who reads corpses and a magistrate who reads people work nine impossible cases, each one hiding a piece of the same jade mirror.',
    id_: 'Tabib penggeledah dinasti Tang dan hakim yang membaca manusia menangani sembilan kasus mustahil, yang masing-masing menyimpan potongan cermin giok yang sama.' },
  { id: 820008, title: 'Six Minutes to Fall in Love', original: '恋爱六分钟', year: 2025,
    genres: ['romance'], genresRaw: ['爱情'], rating: 7.4, pop: 72,
    featured: null, trending: false, type: 'short', eps: 8, dur: 6,
    cast: ['Jiang Tingting', 'Ferryman No. 7', 'Baozi Granny', 'Raincoat Man'],
    director: 'Yuan Xiaoman',
    en: 'A city ferry ride takes six minutes. He has one season of six-minute episodes to make the commuter who sleeps through every stop miss her stop on purpose.',
    id_: 'Perjalanan feri kota hanya enam menit. Ia punya satu musim untuk membuat penumpang yang selalu tertidur sengaja melewatkan pemberhentiannya.' },
  { id: 820009, title: 'The Intern God of Wealth', original: '财神实习中', year: 2026,
    genres: ['comedy', 'fantasy'], genresRaw: ['喜剧', '玄幻'], rating: 7.2, pop: 70,
    featured: null, trending: false, type: 'short', eps: 10, dur: 7,
    cast: ['Zhao Jinbao', 'Auditor Mei', 'Landlord Qian', 'The Debit Demon'],
    director: 'Cui Dada',
    en: 'Heaven\'s worst accountant is sent to a failing corner shop as an intern god of wealth: one month, one ledger, and every blessing he grants deducts from his own score.',
    id_: 'Akuntan surga yang terburuk dikirim ke toko kelontong yang sekarat sebagai dewa kekayaan magang: setiap berkah yang ia berikan mengurangi nilainya sendiri.' },
  { id: 820010, title: 'Campus Diary: Exam Week', original: '校园日记·考试周', year: 2026,
    genres: ['youth'], genresRaw: ['青春'], rating: 7.0, pop: 66,
    featured: null, trending: false, type: 'short', eps: 6, dur: 8,
    cast: ['Gao Feifei', 'Monitor Zhou', 'Canteen Uncle', 'The Physics Paper'],
    director: 'Lin Shuwan',
    en: 'Six days before the gaokao, five classmates film one diary entry a night — a pact that outlives the exam and the year they thought would end everything.',
    id_: 'Enam hari sebelum ujian negara, lima siswa merekam satu entri buku harian setiap malam — janji yang bertahan lebih lama dari ujian itu sendiri.' },
];

async function seedDemoCatalog() {
  for (const s of DEMO_CATALOG) {
    await pool.query(
      `INSERT INTO dramas
         (id, title, original_title, year, country, language, genres, genres_raw,
          rating, popularity, featured, is_trending, is_demo, content_type,
          total_episodes, episode_duration_min, cast_names, director,
          synopsis_en, synopsis_id, verified, needs_review)
       VALUES ($1, $2, $3, $4, 'cn', 'zh', $5, $6, $7, $8, $9, $10, true, $11,
               $12, $13, $14, $15, $16, $17, false, false)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.title, s.original, s.year, s.genres, s.genresRaw, s.rating, s.pop,
        s.featured, s.trending, s.type, s.eps, s.dur, s.cast, s.director, s.en, s.id_]
    );
    for (let n = 1; n <= s.eps; n++) {
      // Same pool assignment the imports use: a stride coprime with 6, so
      // every demo drama cycles all six committed clips.
      const video = VIDEO_BASE + VIDEO_POOL[(s.id * 5 + n) % VIDEO_POOL.length];
      // Wolf General locks everything from episode 2 so the VIP paywall can
      // be seen on a demo route; Campus Diary episode 3 has no video URL, so
      // the player shows its streaming-unavailable state.
      const access = s.id === 820006 && n >= 2 ? 'vip' : 'free';
      const url = s.id === 820010 && n === 3 ? '' : video;
      await pool.query(
        `INSERT INTO episodes (drama_id, num, duration_min, video_url, access)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (drama_id, num) DO NOTHING`,
        [s.id, n, s.dur, url, access]
      );
    }
  }
}

// On the first ?demo=1 request of the viewing account, write its demo
// progress and list rows, once, with fixed keys: two half-watched dramas
// (Continue Watching) and two saved dramas (My List, and the genres that
// drive Recommended for You). Idempotent; what the viewer does to them stays.
const demoCatalogSeedPending = new Map();

async function seedDemoCatalogViewer(user) {
  const key = String(user.id);
  if (demoCatalogSeedPending.has(key)) return demoCatalogSeedPending.get(key);
  const p = (async () => {
    const has = await pool.query(
      `SELECT 1 FROM watch_progress WHERE user_id = $1 AND drama_id = 820001`, [user.id]
    );
    if (!has.rows.length) {
      await pool.query(
        `INSERT INTO watch_progress (user_id, drama_id, ep, seconds, duration, updated_at, is_demo)
         VALUES ($1, 820001, 5, 620, 2700, now() - interval '2 hours', true),
                ($1, 820005, 2, 95, 2400, now() - interval '3 days', true)
         ON CONFLICT (user_id, drama_id) DO NOTHING`,
        [user.id]
      );
      await pool.query(
        `INSERT INTO my_list (user_id, drama_id, added_at, is_demo)
         VALUES ($1, 820002, now() - interval '1 day', true),
                ($1, 820007, now() - interval '5 days', true)
         ON CONFLICT (user_id, drama_id) DO NOTHING`,
        [user.id]
      );
    }
  })();
  demoCatalogSeedPending.set(key, p);
  try {
    await p;
  } catch (err) {
    console.error('demo catalog viewer seed failed', err);
    demoCatalogSeedPending.delete(key);
  }
}

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
    const vip = (await vipStatus(req)).vip;
    // Dramas newest first.
    const dramas = await pool.query(
      `SELECT id, title, synopsis, added_by_id, added_by_username, created_at,
              year, country, genres, rating, cast_list, poster_url
         FROM tracker_dramas WHERE ${demoClause(req, 'is_demo', 1)}
        ORDER BY created_at DESC, id DESC`,
      demoParams(req)
    );
    const ids = dramas.rows.map(d => d.id);

    // Season and episode counts.
    const counts = ids.length ? await pool.query(
      `SELECT drama_id, COUNT(*) AS episodes, COUNT(DISTINCT season) AS seasons,
              COUNT(*) FILTER (WHERE access = 'vip') AS vip_count,
              COUNT(*) FILTER (WHERE access = 'ads') AS ads_count
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
        `SELECT e.id, e.drama_id, e.season, e.number, e.created_at,
                ARRAY(SELECT w.username FROM tracker_watches w WHERE w.episode_id = e.id
                      ORDER BY w.watched_at) AS watchers,
                EXISTS (SELECT 1 FROM tracker_watches w WHERE w.episode_id = e.id AND w.user_id = $3) AS viewer_watched,
                (e.created_at > now() - interval '7 days') AS is_new
           FROM tracker_episodes e
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
        year: d.year, country: d.country,
        genres: d.genres ? d.genres.split(',').map(g => g.trim()).filter(Boolean) : [],
        rating: d.rating == null ? null : Number(d.rating),
        poster_url: d.poster_url,
        seasons: Number(c.seasons), episodes: Number(c.episodes),
        following: followed.has(Number(d.id)),
        // Drama-level chip: VIP wins if any episode is VIP, then ads, then free.
        access_label: Number(c.vip_count) > 0 ? 'VIP' : (Number(c.ads_count) > 0 ? 'Free with ads' : 'Free'),
        mine: req.user && Number(d.added_by_id) === Number(req.user.id),
        note,
      };
    });

    // The Home rows: Trending Now (the most followed, then the best rated),
    // New Episodes (the drama whose newest episode was added most recently),
    // Top 10 (the best rated out of 10), and one row per genre. Same demo
    // gating as the feed itself, so the plain route renders these rows from
    // the dramas it really has: empty when there are none.
    const followCounts = ids.length ? await pool.query(
      `SELECT f.drama_id, COUNT(*)::int AS n FROM tracker_follows f
        WHERE f.drama_id = ANY($2)
          AND ($1 OR NOT EXISTS (SELECT 1 FROM tracker_dramas d WHERE d.id = f.drama_id AND d.is_demo))
        GROUP BY f.drama_id`,
      [...demoParams(req), ids]
    ) : { rows: [] };
    const followsBy = new Map(followCounts.rows.map(r => [Number(r.drama_id), Number(r.n)]));
    const latestEp = new Map();
    for (const e of eps.rows) {
      const dId = Number(e.drama_id);
      const t = e.created_at ? new Date(e.created_at).getTime() : 0;
      if (!latestEp.has(dId) || t > latestEp.get(dId)) latestEp.set(dId, t);
    }
    const card = d => ({ id: d.id, title: d.title, rating: d.rating,
      access_label: d.access_label, poster_url: d.poster_url });
    const trending = out.slice().sort((a, b) =>
      (followsBy.get(b.id) || 0) - (followsBy.get(a.id) || 0) ||
      (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating) ||
      a.id - b.id).slice(0, 12);
    const newEpisodes = out.slice()
      .sort((a, b) => (latestEp.get(b.id) || 0) - (latestEp.get(a.id) || 0) || a.id - b.id)
      .filter(d => latestEp.has(d.id)).slice(0, 12);
    const top = out.filter(d => d.rating != null)
      .sort((a, b) => b.rating - a.rating || a.id - b.id).slice(0, 10);
    const genres = new Map();
    // Every visible drama belongs in its genre rows, not only those that fit
    // in the trending row; within a genre, best rated first.
    const genreSource = out.slice().sort((a, b) =>
      (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating) || a.id - b.id);
    for (const d of genreSource) {
      for (const g of d.genres) {
        if (!genres.has(g)) genres.set(g, []);
        if (genres.get(g).length < 12) genres.get(g).push(card(d));
      }
    }
    const genreRows = [...genres.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([genre, list]) => ({ genre, dramas: list }));
    const rows = {
      trending: trending.map(card),
      new_episodes: newEpisodes.map(card),
      top: top.map(card),
      genres: genreRows,
    };

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
    return res.json({ vip, dramas: out, next, rows });
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
    // Optional metadata: genres as a comma-separated list, a year, a
    // country, an editorial rating out of 10 and a poster link. All may be
    // left out; dramas without them keep the flat colour poster tile.
    const year = req.body.year == null || req.body.year === '' ? null : parseInt(req.body.year, 10);
    if (year !== null && (isNaN(year) || year < 1900 || year > 2100)) {
      return res.status(400).json({ error: 'Year must be between 1900 and 2100' });
    }
    const country = typeof req.body.country === 'string' ? req.body.country.trim() : '';
    if (country.length > 60) return res.status(400).json({ error: 'Country must be 60 characters or fewer' });
    const genreList = typeof req.body.genres === 'string'
      ? req.body.genres.split(',').map(g => g.trim()).filter(Boolean).slice(0, 6)
      : [];
    if (genreList.some(g => g.length > 30)) {
      return res.status(400).json({ error: 'Each genre must be 30 characters or fewer' });
    }
    const rating = req.body.rating == null || req.body.rating === '' ? null : Number(req.body.rating);
    if (rating !== null && (!isFinite(rating) || rating < 0 || rating > 10)) {
      return res.status(400).json({ error: 'Rating must be between 0 and 10' });
    }
    const poster_url = typeof req.body.poster_url === 'string' && req.body.poster_url.trim()
      ? req.body.poster_url.trim() : null;
    if (poster_url && (!/^https:\/\//.test(poster_url) || poster_url.length > 500)) {
      return res.status(400).json({ error: 'The poster link must start with https://' });
    }
    const backdrop_url = typeof req.body.backdrop_url === 'string' && req.body.backdrop_url.trim()
      ? req.body.backdrop_url.trim() : null;
    if (backdrop_url && (!/^https:\/\//.test(backdrop_url) || backdrop_url.length > 500)) {
      return res.status(400).json({ error: 'The backdrop link must start with https://' });
    }
    const r = await pool.query(
      `INSERT INTO tracker_dramas (title, synopsis, year, country, genres, rating, poster_url, backdrop_url, added_by_id, added_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [title, synopsis || null, year, country || null,
       genreList.length ? genreList.join(', ') : null,
       rating == null ? null : Math.round(rating * 10) / 10,
       poster_url, backdrop_url, req.user.id, req.user.username]
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
    const vip = (await vipStatus(req)).vip;
    const d = await pool.query(
      `SELECT id, title, synopsis, added_by_id, added_by_username, created_at,
              year, country, genres, rating, cast_list, poster_url, backdrop_url
         FROM tracker_dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
      [req.params.id, ...demoParams(req)]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Drama not found' });
    const drama = d.rows[0];
    const eps = await pool.query(
      `SELECT e.id, e.season, e.number, e.title, e.minutes, e.watch_url,
              e.media_url, e.subtitle_url, e.access,
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
    const access = typeof req.body.access === 'string' && req.body.access ? req.body.access : 'free';
    if (!['free', 'vip', 'ads'].includes(access)) return res.status(400).json({ error: 'Access must be Free, VIP or Free with ads' });
    const exists = await pool.query(
      `SELECT 1 FROM tracker_episodes WHERE drama_id = $1 AND season = $2 AND number = $3`,
      [req.params.id, season, number]
    );
    if (exists.rows.length) return res.status(409).json({ error: 'That season and episode number already exists' });
    const r = await pool.query(
      `INSERT INTO tracker_episodes (drama_id, season, number, title, minutes, watch_url, media_url, subtitle_url, access, added_by_id, added_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.params.id, season, number, title, minutes, watch_url, media_url, subtitle_url, access, req.user.id, req.user.username]
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
    const e = await pool.query(`SELECT id, access FROM tracker_episodes WHERE id = $1`, [req.params.id]);
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
    // Server-side paywall: the write is refused and the answer explains why.
    if (e.rows[0].access === 'vip' && !(await vipStatus(req)).vip) {
      return res.status(403).json({ error: 'vip_required' });
    }
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
    const commentId = req.body.comment_id ? parseInt(req.body.comment_id, 10) : null;
    if (!dramaId && !episodeId && !commentId) return res.status(400).json({ error: 'A drama, an episode or a comment is required' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
    if (reason && reason.length > 500) return res.status(400).json({ error: 'The reason must be 500 characters or fewer' });
    await pool.query(
      `INSERT INTO tracker_reports (reporter_id, reporter_username, drama_id, episode_id, comment_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, req.user.username, dramaId, episodeId, commentId, reason]
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
tracker.get('/watch/:episodeId', async (req, res) => {
  try {
    const viewerId = req.user ? req.user.id : null;
    const demo = demoOn(req);
    const e = await pool.query(
      `SELECT e.id, e.drama_id, e.season, e.number, e.title, e.minutes, e.watch_url,
              e.media_url, e.subtitle_url, e.access,
              EXISTS (SELECT 1 FROM tracker_watches w WHERE w.episode_id = e.id AND w.user_id = $3::integer) AS viewer_watched
         FROM tracker_episodes e
        WHERE e.id = $1 AND ($2 OR NOT e.is_demo)`,
      [req.params.episodeId, demo, viewerId || 0]
    );
    if (!e.rows.length) return res.status(404).json({ error: 'Episode not found' });
    // A locked VIP episode arrives without its watch and video links.
    const ep = gateEpisode(e.rows[0], await viewerIsVip(req));
    const d = await pool.query(
      `SELECT id, title FROM tracker_dramas WHERE id = $1 AND ($2 OR NOT is_demo)`,
      [ep.drama_id, demo]
    );
    if (!d.rows.length) return res.status(404).json({ error: 'Episode not found' });
    const neighbours = await pool.query(
      `SELECT e.id, e.season, e.number, e.title, e.minutes, (e.media_url IS NOT NULL) AS has_media
         FROM tracker_episodes e
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
        access: ep.access, locked: ep.locked, requiresAd: ep.requiresAd,
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
tracker.put('/episodes/:id/progress', async (req, res) => {
  try {
    const exists = await pool.query(`SELECT id FROM tracker_episodes WHERE id = $1`, [req.params.id]);
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

// Whether the viewer is VIP, for the player and the Downloads view: the same
// answer as /api/me/subscription (vipStatus reads the subscriptions table
// against req.now), in the shape those views read. On the staging demo
// route, the demo viewer is VIP without storing anything (a row would leak
// into the plain route on the same staging database, which must stay
// production-shaped).
//
// The answer is always 200: a signed-out viewer and a viewer with no
// subscription record both get the free shape, and an unexpected database
// failure is logged here and answered as free too — the page must open
// either way, and the client treats every non-VIP answer as free.
const FREE_SUB = { vip: false, isVip: false, status: 'free', plan: null, expires_at: null };
function demoVip(req) {
  return IS_STAGING && req.query.demo === '1' && !!req.user;
}
async function viewerIsVip(req) {
  if (demoVip(req)) return true;
  return (await vipStatus(req)).vip;
}
// The subscription answer, shared by /api/tracker/subscription and the
// top-level /api/subscription: before the routes moved under /api/tracker,
// the VIP page called /api/subscription at the top level.
async function subscriptionAnswer(req, res) {
  try {
    if (demoVip(req)) {
      return res.json({ vip: true, isVip: true, plan: 'vip', status: 'active', expires_at: null, demo: true });
    }
    if (!req.user) return res.json(FREE_SUB);
    const s = await vipStatus(req);
    return res.json(s.vip
      ? { vip: true, isVip: true, plan: s.row.plan_id, status: 'active', expires_at: s.row.renewal_date }
      : FREE_SUB);
  } catch (err) {
    console.error('subscription lookup failed', err);
    return res.json(FREE_SUB);
  }
}

tracker.get('/subscription', subscriptionAnswer);
// Same answer at the old top-level path, which is still a public GET.
app.get('/api/subscription', subscriptionAnswer);

// First-party analytics. The event names are whitelisted server-side so a
// stray client cannot invent schema; nothing here hides or shows anything.
const EVENT_NAMES = new Set([
  'screen_view', 'watch_started', 'watch_heartbeat', 'watch_completed', 'drop_off',
  'download_started', 'download_completed', 'download_deleted',
  'subscription_intent', 'language_changed', 'install_prompt_accepted',
]);

tracker.post('/events', async (req, res) => {
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
  SELECT 1 FROM tracker_episodes e WHERE e.id = c.episode_id AND e.is_demo))`;

tracker.get('/episodes/:id/comments', async (req, res) => {
  try {
    const demo = demoOn(req);
    const viewerId = req.user ? req.user.id : null;
    const ep = await pool.query(
      `SELECT id FROM tracker_episodes WHERE id = $1 AND ($2 OR NOT is_demo)`,
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

tracker.post('/episodes/:id/comments', async (req, res) => {
  try {
    const demo = demoOn(req);
    const ep = await pool.query(
      `SELECT id FROM tracker_episodes WHERE id = $1 AND ($2 OR NOT is_demo)`,
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

tracker.post('/comments/:id/like', async (req, res) => {
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

tracker.delete('/comments/:id/like', async (req, res) => {
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

tracker.delete('/comments/:id', async (req, res) => {
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

tracker.get('/dramas/:id/reviews', async (req, res) => {
  try {
    const d = await pool.query(
      `SELECT id FROM tracker_dramas WHERE id = $1 AND ${demoClause(req, 'is_demo', 2)}`,
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

tracker.put('/dramas/:id/review', async (req, res) => {
  try {
    const demo = demoOn(req);
    const d = await pool.query(
      `SELECT id FROM tracker_dramas WHERE id = $1 AND ($2 OR NOT is_demo)`,
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

tracker.delete('/dramas/:id/review', async (req, res) => {
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
  // The shared drama tracker is its own page (/tracker, and Stripe's return
  // at /tracker/vip/return); everything else is the app.
  const isTracker = req.path === '/tracker' || req.path.startsWith('/tracker/');
  res.sendFile(path.join(__dirname, 'public', isTracker ? 'tracker.html' : 'index.html'));
});

// Graceful shutdown per the platform conventions: stop accepting, drain
// ~3s, close the pool, exit. Idempotent across SIGTERM + SIGINT.
const DRAIN_MS = 3000;
let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

async function start() {
  await migrateLegacyTrackerTables();
  await pool.query(SCHEMA_SQL);
  await pool.query(CATALOG_ALTER_SQL);
  // The one-time content wipe must land before anything seeds the catalog:
  // nothing reseeds it any more, but a later boot must also never delete
  // dramas imported after the wipe (the marker guards that).
  await wipeCatalogOnce();
  await ensureTrackerSchema();
  if (IS_STAGING) {
    try {
      await seedTrackerDemo();
      await seedSampleDramas();
      await seedDemoCatalog();
      await seedStagingVip();
    } catch (err) {
      console.error('staging demo seed failed', err);
    }
  }
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });

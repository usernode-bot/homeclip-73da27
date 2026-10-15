// HomeClip's API. Mounted under /api by server.js, behind the platform auth
// middleware (which already answers unauthenticated writes with 401 and a
// guest's writes with 401 account_required — routes can assume req.user for
// anything that writes).
//
// Identity is the platform's (req.user, from the iframe token). Everything a
// person saves — follows, watches, list, ratings, settings, searches — is
// keyed to a PROFILE owned by their account: every request that needs one
// carries the active profile id in the x-homeclip-profile header, and
// getProfile() validates that it belongs to req.user before touching data.
// A Kids profile filters every catalog read server-side (mature dramas are
// never sent to that profile, so no client toggle can leak them).

const { ensureShotsFixtures } = require('./seed');

const PROFILE_LIMIT = 4;

function bad(res, status, code) {
  return res.status(status).json({ error: code });
}

function slugify(title) {
  return title.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'drama';
}

// Escape LIKE metacharacters so a query like "50%" matches literally.
function likePattern(q) {
  return '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
}

function parseCursor(raw) {
  const m = typeof raw === 'string' ? raw.match(/^(.+)_(\d+)$/) : null;
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { at: m[1], id: Number(m[2]) };
}

function encodeCursor(row) {
  return `${new Date(row.created_at).toISOString()}_${row.id}`;
}

// Search pages order by (title, id) ascending, so its cursor carries the
// title — not a timestamp — as the keyset boundary.
function parseTextCursor(raw) {
  const m = typeof raw === 'string' ? raw.match(/^([\s\S]+)_(\d+)$/) : null;
  if (!m) return null;
  return { at: m[1], id: Number(m[2]) };
}

function encodeTextCursor(row) {
  return `${row.title}_${row.id}`;
}

const nowOf = (req) => req.now || new Date();

module.exports = function registerApi(app, pool, { isStaging }) {

  // ── Profile context ────────────────────────────────────────────────────
  // Resolves the active profile for the request: the one named in the
  // x-homeclip-profile header, else the account's first profile. Returns
  // null for guests and for accounts that have not created a profile yet —
  // read routes treat that as "no viewer state", write routes refuse.
  async function getProfile(req) {
    if (!req.user) return null;
    const headerId = Number(req.headers['x-homeclip-profile']);
    if (Number.isInteger(headerId) && headerId > 0) {
      const owned = await pool.query(
        `SELECT * FROM profiles WHERE id = $1 AND account_id = $2`,
        [headerId, req.user.id]);
      if (owned.rows.length === 0) return { invalid: true };
      return { profile: owned.rows[0] };
    }
    const first = await pool.query(
      `SELECT * FROM profiles WHERE account_id = $1 ORDER BY id LIMIT 1`,
      [req.user.id]);
    return { profile: first.rows[0] || null };
  }

  // For writes: a valid profile is required.
  async function requireProfile(req, res) {
    const ctx = await getProfile(req);
    if (ctx && ctx.invalid) { bad(res, 403, 'unknown_profile'); return null; }
    if (!ctx || !ctx.profile) { bad(res, 403, 'profile_required'); return null; }
    return ctx.profile;
  }

  // Kids profiles never receive mature dramas: this fragment goes into every
  // catalog read when the active profile is a Kids one.
  function kidsClause(profile, alias) {
    return profile && profile.is_kids ? ` AND ${alias}.maturity = 'all'` : '';
  }

  // ── Shared aggregate queries ───────────────────────────────────────────

  async function dramaCounts(dramaIds) {
    if (dramaIds.length === 0) return new Map();
    const rows = await pool.query(
      `SELECT s.drama_id,
              count(DISTINCT s.id)::int AS season_count,
              count(e.id)::int AS episode_count
       FROM seasons s LEFT JOIN episodes e ON e.season_id = s.id
       WHERE s.drama_id = ANY($1)
       GROUP BY s.drama_id`, [dramaIds]);
    // Map keys are String-normalized: dramas.id is bigint on databases this
    // schema did not create (pg returns it as a string) while the new
    // per-profile tables' drama_id is integer (returned as a number), and a
    // raw Map.get across that pair silently misses.
    return new Map(rows.rows.map(r => [String(r.drama_id), r]));
  }

  // The per-profile extras a feed or list row shows: follow/list flags,
  // progress through the season you're on, and whether you finished it.
  // `totals` is the seasonTotals map for the same drama ids (one query for
  // the whole page, not one per drama).
  async function profileDramaState(profileId, dramaIds, totals) {
    if (!profileId || dramaIds.length === 0) return new Map();
    const [follows, listed, watches, finishedRows] = await Promise.all([
      pool.query(`SELECT drama_id FROM follows WHERE profile_id = $1 AND drama_id = ANY($2)`,
        [profileId, dramaIds]),
      pool.query(`SELECT drama_id FROM my_list WHERE profile_id = $1 AND drama_id = ANY($2)`,
        [profileId, dramaIds]),
      // Watched count per (drama, season); the highest-numbered season with
      // any progress is "the season you're on".
      pool.query(
        `SELECT s.drama_id, s.number AS season_number,
                count(w.episode_id) FILTER (WHERE w.completed)::int AS watched
         FROM seasons s
         JOIN episodes e ON e.season_id = s.id
         JOIN episode_watches w ON w.episode_id = e.id AND w.profile_id = $1
         WHERE s.drama_id = ANY($2)
         GROUP BY s.drama_id, s.number`, [profileId, dramaIds]),
      // "You finished it": every episode of the drama is completed.
      pool.query(
        `SELECT s.drama_id
         FROM seasons s
         JOIN episodes e ON e.season_id = s.id
         LEFT JOIN episode_watches w
           ON w.episode_id = e.id AND w.profile_id = $1 AND w.completed
         WHERE s.drama_id = ANY($2)
         GROUP BY s.drama_id
         HAVING count(e.id) > 0 AND count(e.id) = count(w.episode_id)`,
        [profileId, dramaIds]),
    ]);
    const state = new Map(dramaIds.map(id => [String(id), {
      following: false, inList: false, finished: false,
      progressSeason: null, progressWatched: 0, progressTotal: 0,
    }]));
    for (const r of follows.rows) {
      const st = state.get(String(r.drama_id));
      if (st) st.following = true;
    }
    for (const r of listed.rows) {
      const st = state.get(String(r.drama_id));
      if (st) st.inList = true;
    }
    for (const r of finishedRows.rows) {
      const st = state.get(String(r.drama_id));
      if (st) st.finished = true;
    }
    const perDrama = new Map();
    for (const r of watches.rows) {
      if (!perDrama.has(String(r.drama_id))) perDrama.set(String(r.drama_id), []);
      perDrama.get(String(r.drama_id)).push(r);
    }
    for (const [dramaId, seasonsSeen] of perDrama) {
      const st = state.get(dramaId);
      if (!st) continue;
      const totalsForDrama = new Map((totals.get(dramaId) || [])
        .map(t => [t.season, t.total]));
      const active = seasonsSeen
        .filter(r => (totalsForDrama.get(r.season_number) || 0) > 0)
        .sort((a, b) => b.season_number - a.season_number)[0];
      if (active) {
        st.progressSeason = active.season_number;
        st.progressWatched = active.watched;
        st.progressTotal = totalsForDrama.get(active.season_number) || 0;
      }
    }
    return state;
  }

  async function maxSeasonNumber(dramaId) {
    const r = await pool.query(
      `SELECT max(number) AS n FROM seasons WHERE drama_id = $1`, [dramaId]);
    return r.rows[0].n || 0;
  }

  async function seasonTotals(dramaIds) {
    if (dramaIds.length === 0) return new Map();
    const rows = await pool.query(
      `SELECT s.drama_id, s.number, count(e.id)::int AS total
       FROM seasons s JOIN episodes e ON e.season_id = s.id
       WHERE s.drama_id = ANY($1)
       GROUP BY s.drama_id, s.number`, [dramaIds]);
    const map = new Map();
    for (const r of rows.rows) {
      const key = String(r.drama_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ season: r.number, total: r.total });
    }
    return map;
  }

  // Latest episode of each drama, plus whether it is new this week and who
  // else (other profiles) completed it.
  async function latestEpisodes(dramaIds, profileId) {
    if (dramaIds.length === 0) return new Map();
    const rows = await pool.query(
      `SELECT DISTINCT ON (s.drama_id)
              s.drama_id, e.id, e.title, e.number, e.created_at, s.number AS season_number
       FROM episodes e JOIN seasons s ON s.id = e.season_id
       WHERE s.drama_id = ANY($1)
       ORDER BY s.drama_id, s.number DESC, e.number DESC`, [dramaIds]);
    const map = new Map(rows.rows.map(r => [String(r.drama_id), r]));
    const episodeIds = rows.rows.map(r => r.id);
    if (profileId && episodeIds.length) {
      const mine = await pool.query(
        `SELECT episode_id FROM episode_watches
         WHERE profile_id = $1 AND episode_id = ANY($2) AND completed`,
        [profileId, episodeIds]);
      // String-normalized: episodes.id is bigint (a string from pg) on
      // legacy-shaped databases while episode_watches.episode_id is integer
      // (a number), so a raw Set.has across that pair misses.
      const watched = new Set(mine.rows.map(r => String(r.episode_id)));
      for (const [, ep] of map) ep.watchedByMe = watched.has(String(ep.id));
    }
    if (episodeIds.length) {
      const others = await pool.query(
        `SELECT w.episode_id, p.name
         FROM episode_watches w JOIN profiles p ON p.id = w.profile_id
         WHERE w.episode_id = ANY($1) AND w.completed AND w.profile_id <> $2
         ORDER BY w.last_watched_at DESC`,
        [episodeIds, profileId || 0]);
      for (const r of others.rows) {
        for (const ep of map.values()) {
          if (String(ep.id) === String(r.episode_id)) {
            ep.whoElse = ep.whoElse || [];
            if (ep.whoElse.length < 3) ep.whoElse.push(r.name);
          }
        }
      }
    }
    return map;
  }

  // One short note per feed row, in Phase 1's priority order: your progress
  // through the season you're on, a new episode this week, who else watched
  // the latest one, or "you finished it".
  function feedNote(state, latest, weekAgo) {
    if (state) {
      if (state.finished) return 'You finished it';
      if (state.progressSeason && state.progressWatched > 0) {
        return `${state.progressWatched} of ${state.progressTotal} watched in Season ${state.progressSeason}`;
      }
    }
    if (latest && new Date(latest.created_at) >= weekAgo && !(state && latest.watchedByMe)) {
      return 'New episode';
    }
    if (latest && latest.whoElse && latest.whoElse.length) {
      return 'Watched by ' + latest.whoElse.join(', ');
    }
    return '';
  }

  function dramaCard(drama, counts) {
    return {
      id: drama.id,
      slug: drama.slug,
      title: drama.title,
      summary: drama.summary,
      posterColor: drama.poster_color,
      maturity: drama.maturity,
      seasons: counts ? counts.season_count : 0,
      episodes: counts ? counts.episode_count : 0,
    };
  }

  // ── Me / profiles ──────────────────────────────────────────────────────

  app.get('/api/me', async (req, res) => {
    if (!req.user) return res.json({ guest: true });
    // The shots fixture account gets its viewing data on first sign-in
    // (staging only, by username — see server/seed.js).
    try { await ensureShotsFixtures(pool, isStaging, req.user); } catch (err) {
      console.warn('shots fixture seed failed: ' + err.message);
    }
    const profiles = await pool.query(
      `SELECT id, name, avatar_url, language, is_kids, created_at
       FROM profiles WHERE account_id = $1 ORDER BY id`, [req.user.id]);
    res.json({
      // One merged answer: the live client (public/app.js) reads the
      // Phase-1 shape (user + guest); the profiles screens read
      // account + profiles.
      user: { id: req.user.id, username: req.user.username },
      guest: false,
      account: { id: req.user.id, username: req.user.username, locale: req.user.locale || null },
      profiles: profiles.rows,
    });
  });

  app.post('/api/profiles', async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
    const language = String((req.body && req.body.language) || '').slice(0, 20);
    const isKids = Boolean(req.body && req.body.isKids);
    if (!name) return bad(res, 400, 'bad_request');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One writer per account at a time, so the 4-profile cap holds even
      // when two tabs race.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [String(req.user.id)]);
      const count = await client.query(
        `SELECT count(*)::int AS n FROM profiles WHERE account_id = $1`, [req.user.id]);
      if (count.rows[0].n >= PROFILE_LIMIT) {
        await client.query('ROLLBACK');
        return bad(res, 403, 'profile_limit');
      }
      const created = await client.query(
        `INSERT INTO profiles (account_id, name, language, is_kids)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.id, name, language, isKids]);
      await client.query(
        `INSERT INTO profile_settings (profile_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [created.rows[0].id]);
      await client.query('COMMIT');
      res.status(201).json({ profile: created.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return bad(res, 409, 'duplicate_name');
      throw err;
    } finally {
      client.release();
    }
  });

  app.patch('/api/profiles/:id', async (req, res) => {
    const id = Number(req.params.id);
    const owned = await pool.query(
      `SELECT * FROM profiles WHERE id = $1 AND account_id = $2`, [id, req.user.id]);
    if (owned.rows.length === 0) return bad(res, 404, 'not_found');
    const body = req.body || {};
    const sets = [], params = [];
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 40);
      if (!name) return bad(res, 400, 'bad_request');
      sets.push(`name = $${params.length + 1}`); params.push(name);
    }
    if (body.language !== undefined) {
      sets.push(`language = $${params.length + 1}`);
      params.push(String(body.language).slice(0, 20));
    }
    if (body.isKids !== undefined) {
      sets.push(`is_kids = $${params.length + 1}`); params.push(Boolean(body.isKids));
    }
    if (body.avatarUrl !== undefined) {
      sets.push(`avatar_url = $${params.length + 1}`);
      params.push(String(body.avatarUrl || '').slice(0, 600));
      sets.push(`avatar_file_id = $${params.length + 1}`);
      params.push(String(body.avatarFileId || '').slice(0, 80));
    }
    if (sets.length === 0) return bad(res, 400, 'bad_request');
    params.push(id, req.user.id);
    try {
      const updated = await pool.query(
        `UPDATE profiles SET ${sets.join(', ')}
         WHERE id = $${params.length - 1} AND account_id = $${params.length}
         RETURNING *`, params);
      res.json({ profile: updated.rows[0] });
    } catch (err) {
      if (err.code === '23505') return bad(res, 409, 'duplicate_name');
      throw err;
    }
  });

  app.delete('/api/profiles/:id', async (req, res) => {
    const id = Number(req.params.id);
    const owned = await pool.query(
      `SELECT * FROM profiles WHERE id = $1 AND account_id = $2`, [id, req.user.id]);
    if (owned.rows.length === 0) return bad(res, 404, 'not_found');
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM profiles WHERE account_id = $1`, [req.user.id]);
    if (count.rows[0].n <= 1) return bad(res, 403, 'last_profile');
    // The client deletes the avatar file through the bridge before calling;
    // the row's own data (follows, watches, list, ratings, settings,
    // searches) goes with the profile via ON DELETE CASCADE.
    await pool.query(`DELETE FROM profiles WHERE id = $1`, [id]);
    res.json({ ok: true });
  });

  // ── Catalog: feed, detail, add ─────────────────────────────────────────

  app.get('/api/dramas', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const cursor = parseCursor(req.query.cursor);
    const where = ['1 = 1'];
    const params = [];
    if (profile && profile.is_kids) {
      params.push('all'); where.push(`d.maturity = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.at, cursor.id);
      where.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::int)`);
    }
    params.push(limit + 1);
    const rows = await pool.query(
      `SELECT d.* FROM dramas d WHERE ${where.join(' AND ')}
       ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length}`, params);
    const hasNext = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    const ids = page.map(r => r.id);
    const [counts, totals] = await Promise.all([
      dramaCounts(ids),
      seasonTotals(ids),
    ]);
    const state = await profileDramaState(profile ? profile.id : null, ids, totals);
    const latest = await latestEpisodes(ids, profile ? profile.id : null);
    const weekAgo = new Date(nowOf(req).getTime() - 7 * 24 * 3600 * 1000);
    const dramas = page.map(d => {
      const c = counts.get(String(d.id));
      const st = state.get(String(d.id));
      const latestEp = latest.get(String(d.id));
      return {
        ...dramaCard(d, c),
        seasonTotals: totals.get(String(d.id)) || [],
        note: feedNote(st, latestEp, weekAgo),
        following: st ? st.following : false,
        inList: st ? st.inList : false,
      };
    });
    res.json({
      dramas,
      nextCursor: hasNext && page.length ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  app.get('/api/dramas/:slug', async (req, res, next) => {
    // Phase-1 routes address dramas by numeric id (the hash routes
    // #/drama/900001 and their path forms); only slugs resolve here.
    // Defer numeric ids to the Phase-1 route in server.js.
    if (/^\d+$/.test(String(req.params.slug))) return next();
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    const drama = (await pool.query(
      `SELECT * FROM dramas WHERE slug = $1`, [req.params.slug])).rows[0];
    if (!drama) return bad(res, 404, 'not_found');
    if (profile && profile.is_kids && drama.maturity === 'mature') {
      return bad(res, 403, 'mature_hidden');
    }
    const seasons = (await pool.query(
      `SELECT s.id, s.number, count(e.id)::int AS episode_count
       FROM seasons s LEFT JOIN episodes e ON e.season_id = s.id
       WHERE s.drama_id = $1 GROUP BY s.id, s.number ORDER BY s.number`,
      [drama.id])).rows;
    const episodes = (await pool.query(
      `SELECT e.id, e.season_id, e.number, e.title, e.watch_url, e.duration_seconds, e.created_at
       FROM episodes e JOIN seasons s ON s.id = e.season_id
       WHERE s.drama_id = $1 ORDER BY s.number, e.number`, [drama.id])).rows;
    const genres = (await pool.query(
      `SELECT g.name FROM drama_genres dg JOIN genres g ON g.id = dg.genre_id
       WHERE dg.drama_id = $1 ORDER BY g.name`, [drama.id])).rows.map(r => r.name);
    const cast = (await pool.query(
      `SELECT cm.name, dc.character_name FROM drama_cast dc
       JOIN cast_members cm ON cm.id = dc.cast_member_id
       WHERE dc.drama_id = $1 ORDER BY cm.name`, [drama.id])).rows;
    let viewer = null;
    let whoElse = {};
    // The live app's follow button writes the legacy user-keyed follows
    // (server.js), so the slug route counts those too when there is no
    // profile context — the button then reads back what it wrote.
    let legacyFollowing = false;
    if (req.user) {
      legacyFollowing = (await pool.query(
        `SELECT 1 FROM follows_legacy WHERE user_id = $1 AND drama_id = $2`,
        [req.user.id, drama.id])).rows.length > 0;
    }
    if (profile) {
      const [follow, listed, rating, watches, avg] = await Promise.all([
        pool.query(`SELECT 1 FROM follows WHERE profile_id = $1 AND drama_id = $2`,
          [profile.id, drama.id]),
        pool.query(`SELECT 1 FROM my_list WHERE profile_id = $1 AND drama_id = $2`,
          [profile.id, drama.id]),
        pool.query(`SELECT stars FROM ratings WHERE profile_id = $1 AND drama_id = $2`,
          [profile.id, drama.id]),
        pool.query(
          `SELECT episode_id, position_seconds, completed
           FROM episode_watches WHERE profile_id = $1 AND episode_id = ANY(
             SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id
             WHERE s.drama_id = $2)`, [profile.id, drama.id]),
        pool.query(
          `SELECT avg(stars)::numeric(3,1) AS average, count(*)::int AS count
           FROM ratings WHERE drama_id = $1`, [drama.id]),
      ]);
      const mine = new Map(watches.rows.map(r => [r.episode_id, {
        positionSeconds: r.position_seconds, completed: r.completed,
      }]));
      viewer = {
        following: follow.rows.length > 0 || legacyFollowing,
        inList: listed.rows.length > 0,
        myStars: rating.rows.length ? rating.rows[0].stars : null,
        watches: Object.fromEntries(mine),
        groupAverage: avg.rows[0].count > 0 ? Number(avg.rows[0].average) : null,
        groupRatingCount: avg.rows[0].count,
      };
      const others = await pool.query(
        `SELECT w.episode_id, p.name
         FROM episode_watches w JOIN profiles p ON p.id = w.profile_id
         WHERE w.completed AND w.profile_id <> $1 AND w.episode_id = ANY(
           SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id
           WHERE s.drama_id = $2)
         ORDER BY w.last_watched_at DESC`, [profile.id, drama.id]);
      for (const r of others.rows) {
        const list = whoElse[r.episode_id] || (whoElse[r.episode_id] = []);
        if (list.length < 3) list.push(r.name);
      }
    } else if (req.user) {
      // No profile yet: the follow state still comes from the legacy
      // table, so the follow button reads back what it wrote.
      viewer = { following: legacyFollowing, inList: false, myStars: null,
                 watches: {}, groupAverage: null, groupRatingCount: 0 };
    }
    res.json({
      drama: {
        ...dramaCard(drama, null),
        addedBy: drama.added_by,
        createdAt: drama.created_at,
      },
      seasons, episodes, genres, cast, viewer, whoElse,
    });
  });

  app.post('/api/dramas', async (req, res, next) => {
    const body = req.body || {};
    // The Phase-1 "Add a drama" sheet posts the legacy shape (synopsis,
    // year, country, rating, poster_url); those go to the Phase-1 route
    // in server.js. Only the new form's shape (summary / maturity /
    // genres array / cast) creates a drama here.
    const legacyShape = body.synopsis !== undefined || body.year !== undefined
      || body.country !== undefined || body.rating !== undefined
      || body.poster_url !== undefined;
    const newShape = body.summary !== undefined || body.maturity !== undefined
      || body.cast !== undefined || Array.isArray(body.genres);
    if (legacyShape || !newShape) return next();
    const title = String(body.title || '').trim().slice(0, 80);
    if (!title) return bad(res, 400, 'bad_request');
    const maturity = body.maturity === 'mature' ? 'mature' : 'all';
    const summary = String(body.summary || '').trim().slice(0, 600);
    const genres = Array.isArray(body.genres)
      ? body.genres.map(g => String(g).trim().slice(0, 40)).filter(Boolean).slice(0, 6)
      : [];
    const castNames = Array.isArray(body.cast)
      ? body.cast.map(c => String(c).trim().slice(0, 60)).filter(Boolean).slice(0, 12)
      : [];
    // A unique slug: title-based, with a numeric suffix when taken.
    let slug = slugify(title);
    for (let i = 2; ; i++) {
      const taken = await pool.query(`SELECT 1 FROM dramas WHERE slug = $1`, [slug]);
      if (taken.rows.length === 0) break;
      slug = `${slugify(title)}-${i}`;
    }
    const created = await pool.query(
      `INSERT INTO dramas (slug, title, summary, poster_color, maturity, added_by, created_at, updated_at)
       VALUES ($1, $2, $3, '', $4, $5, $6, $6) RETURNING *`,
      [slug, title, summary, maturity, req.user.username, nowOf(req)]);
    const dramaId = created.rows[0].id;
    for (const genreName of genres) {
      await pool.query(`INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [genreName]);
      await pool.query(
        `INSERT INTO drama_genres (drama_id, genre_id)
         SELECT $1, id FROM genres WHERE name = $2 ON CONFLICT DO NOTHING`,
        [dramaId, genreName]);
    }
    for (const castName of castNames) {
      await pool.query(`INSERT INTO cast_members (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [castName]);
      await pool.query(
        `INSERT INTO drama_cast (drama_id, cast_member_id)
         SELECT $1, id FROM cast_members WHERE name = $2 ON CONFLICT DO NOTHING`,
        [dramaId, castName]);
    }
    res.status(201).json({ drama: created.rows[0] });
  });

  app.post('/api/dramas/:slug/episodes', async (req, res, next) => {
    // Numeric ids belong to the Phase-1 episodes route (server.js), like
    // the GET above.
    if (/^\d+$/.test(String(req.params.slug))) return next();
    const drama = (await pool.query(
      `SELECT * FROM dramas WHERE slug = $1`, [req.params.slug])).rows[0];
    if (!drama) return bad(res, 404, 'not_found');
    const body = req.body || {};
    const title = String(body.title || '').trim().slice(0, 80);
    if (!title) return bad(res, 400, 'bad_request');
    const watchUrl = String(body.watchUrl || '').trim().slice(0, 600);
    const durationSeconds = Math.max(Number(body.durationSeconds) || 0, 0) | 0;
    let seasonNumber = Number(body.seasonNumber) | 0;
    if (seasonNumber < 1) {
      const max = await maxSeasonNumber(drama.id);
      seasonNumber = max + 1;
    }
    let season = (await pool.query(
      `SELECT * FROM seasons WHERE drama_id = $1 AND number = $2`,
      [drama.id, seasonNumber])).rows[0];
    if (!season) {
      season = (await pool.query(
        `INSERT INTO seasons (drama_id, number, title) VALUES ($1, $2, $3) RETURNING *`,
        [drama.id, seasonNumber, 'Season ' + seasonNumber])).rows[0];
    }
    const nextNumber = (await pool.query(
      `SELECT coalesce(max(number), 0) + 1 AS n FROM episodes WHERE season_id = $1`,
      [season.id])).rows[0].n;
    const created = await pool.query(
      `INSERT INTO episodes (season_id, number, title, watch_url, duration_seconds, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [season.id, nextNumber, title, watchUrl, durationSeconds, nowOf(req)]);
    await pool.query(`UPDATE dramas SET updated_at = $2 WHERE id = $1`, [drama.id, nowOf(req)]);
    res.status(201).json({ episode: created.rows[0], seasonNumber });
  });

  // Episode lookup for the player screen.
  app.get('/api/episodes/:id', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    const rows = await pool.query(
      `SELECT e.*, s.number AS season_number, s.drama_id,
              d.slug AS drama_slug, d.title AS drama_title, d.maturity
       FROM episodes e
       JOIN seasons s ON s.id = e.season_id
       JOIN dramas d ON d.id = s.drama_id
       WHERE e.id = $1`, [Number(req.params.id)]);
    if (rows.rows.length === 0) return bad(res, 404, 'not_found');
    const ep = rows.rows[0];
    if (profile && profile.is_kids && ep.maturity === 'mature') {
      return bad(res, 403, 'mature_hidden');
    }
    let watch = null;
    if (profile) {
      const w = await pool.query(
        `SELECT position_seconds, completed FROM episode_watches
         WHERE profile_id = $1 AND episode_id = $2`, [profile.id, ep.id]);
      watch = w.rows[0] || null;
    }
    res.json({
      episode: {
        id: ep.id, number: ep.number, title: ep.title,
        watchUrl: ep.watch_url, durationSeconds: ep.duration_seconds,
        seasonNumber: ep.season_number,
      },
      drama: { id: ep.drama_id, slug: ep.drama_slug, title: ep.drama_title },
      watch,
    });
  });

  // ── Follows ────────────────────────────────────────────────────────────

  app.post('/api/follows', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    const dramaId = Number(req.body && req.body.dramaId);
    const drama = (await pool.query(`SELECT id FROM dramas WHERE id = $1`, [dramaId])).rows[0];
    if (!drama) return bad(res, 404, 'not_found');
    if (profile.is_kids) {
      const m = (await pool.query(`SELECT maturity FROM dramas WHERE id = $1`, [dramaId])).rows[0];
      if (m.maturity === 'mature') return bad(res, 403, 'mature_hidden');
    }
    await pool.query(
      `INSERT INTO follows (profile_id, drama_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [profile.id, dramaId]);
    res.status(201).json({ ok: true });
  });

  app.delete('/api/follows/:dramaId', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    await pool.query(
      `DELETE FROM follows WHERE profile_id = $1 AND drama_id = $2`,
      [profile.id, Number(req.params.dramaId)]);
    res.json({ ok: true });
  });

  // ── Watches: marks, resume positions ───────────────────────────────────

  app.put('/api/watches', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    const body = req.body || {};
    const episodeId = Number(body.episodeId);
    const exists = (await pool.query(
      `SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id
       JOIN dramas d ON d.id = s.drama_id WHERE e.id = $1`, [episodeId])).rows[0];
    if (!exists) return bad(res, 404, 'not_found');
    if (profile.is_kids) {
      const m = (await pool.query(
        `SELECT d.maturity FROM episodes e JOIN seasons s ON s.id = e.season_id
         JOIN dramas d ON d.id = s.drama_id WHERE e.id = $1`, [episodeId])).rows[0];
      if (m.maturity === 'mature') return bad(res, 403, 'mature_hidden');
    }
    const positionSeconds = Math.min(Math.max(Number(body.positionSeconds) || 0, 0) | 0, 863999);
    const completed = Boolean(body.completed);
    // Idempotent upsert: an offline replay sends the same body twice and
    // must not corrupt the position or lose the completed flag.
    await pool.query(
      `INSERT INTO episode_watches
         (profile_id, episode_id, position_seconds, completed, first_opened_at, last_watched_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (profile_id, episode_id) DO UPDATE SET
         position_seconds = CASE WHEN EXCLUDED.position_seconds > 0
                                 THEN EXCLUDED.position_seconds
                                 ELSE episode_watches.position_seconds END,
         completed = episode_watches.completed OR EXCLUDED.completed,
         first_opened_at = COALESCE(episode_watches.first_opened_at, EXCLUDED.first_opened_at),
         last_watched_at = EXCLUDED.last_watched_at`,
      [profile.id, episodeId, positionSeconds, completed, nowOf(req)]);
    res.json({ ok: true });
  });

  app.delete('/api/watches/:episodeId', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    await pool.query(
      `DELETE FROM episode_watches WHERE profile_id = $1 AND episode_id = $2`,
      [profile.id, Number(req.params.episodeId)]);
    res.json({ ok: true });
  });

  // ── Continue watching ──────────────────────────────────────────────────

  app.get('/api/continue-watching', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    if (!profile) return res.json({ items: [] });
    const rows = await pool.query(
      `SELECT e.id AS episode_id, e.title AS episode_title, e.number AS episode_number,
              e.duration_seconds, w.position_seconds, w.first_opened_at,
              s.number AS season_number,
              d.id AS drama_id, d.slug, d.title AS drama_title, d.poster_color, d.maturity
       FROM episode_watches w
       JOIN episodes e ON e.id = w.episode_id
       JOIN seasons s ON s.id = e.season_id
       JOIN dramas d ON d.id = s.drama_id
       WHERE w.profile_id = $1 AND w.completed = false${kidsClause(profile, 'd')}
       ORDER BY w.last_watched_at DESC LIMIT 10`, [profile.id]);
    res.json({
      items: rows.rows.map(r => ({
        episodeId: r.episode_id,
        episodeTitle: r.episode_title,
        episodeNumber: r.episode_number,
        seasonNumber: r.season_number,
        dramaSlug: r.slug,
        dramaTitle: r.drama_title,
        posterColor: r.poster_color,
        positionSeconds: r.position_seconds,
        durationSeconds: r.duration_seconds,
        played: r.position_seconds > 0,
      })),
    });
  });

  // ── My List ────────────────────────────────────────────────────────────

  app.get('/api/my-list', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    if (!profile) return res.json({ items: [] });
    const rows = await pool.query(
      `SELECT d.*, l.added_at FROM my_list l
       JOIN dramas d ON d.id = l.drama_id
       WHERE l.profile_id = $1${kidsClause(profile, 'd')}
       ORDER BY l.added_at DESC LIMIT 50`, [profile.id]);
    const ids = rows.rows.map(r => r.id);
    const counts = await dramaCounts(ids);
    res.json({
      items: rows.rows.map(d => ({ ...dramaCard(d, counts.get(String(d.id))), addedAt: d.added_at })),
    });
  });

  app.post('/api/my-list', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    const dramaId = Number(req.body && req.body.dramaId);
    const drama = (await pool.query(
      `SELECT id, maturity FROM dramas WHERE id = $1`, [dramaId])).rows[0];
    if (!drama) return bad(res, 404, 'not_found');
    if (profile.is_kids && drama.maturity === 'mature') return bad(res, 403, 'mature_hidden');
    await pool.query(
      `INSERT INTO my_list (profile_id, drama_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [profile.id, dramaId]);
    res.status(201).json({ ok: true });
  });

  app.delete('/api/my-list/:dramaId', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    await pool.query(
      `DELETE FROM my_list WHERE profile_id = $1 AND drama_id = $2`,
      [profile.id, Number(req.params.dramaId)]);
    res.json({ ok: true });
  });

  // ── Ratings ────────────────────────────────────────────────────────────

  app.put('/api/ratings', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    const body = req.body || {};
    const dramaId = Number(body.dramaId);
    const stars = Number(body.stars) | 0;
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return bad(res, 400, 'bad_request');
    const drama = (await pool.query(
      `SELECT id, maturity FROM dramas WHERE id = $1`, [dramaId])).rows[0];
    if (!drama) return bad(res, 404, 'not_found');
    if (profile.is_kids && drama.maturity === 'mature') return bad(res, 403, 'mature_hidden');
    await pool.query(
      `INSERT INTO ratings (profile_id, drama_id, stars, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (profile_id, drama_id)
       DO UPDATE SET stars = EXCLUDED.stars, updated_at = EXCLUDED.updated_at`,
      [profile.id, dramaId, stars, nowOf(req)]);
    res.json({ ok: true });
  });

  // ── Settings ───────────────────────────────────────────────────────────

  app.get('/api/settings', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    if (!profile) return bad(res, 403, 'profile_required');
    await pool.query(
      `INSERT INTO profile_settings (profile_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [profile.id]);
    const s = (await pool.query(
      `SELECT theme, notify_new_episode FROM profile_settings WHERE profile_id = $1`,
      [profile.id])).rows[0];
    res.json({
      profileId: profile.id,
      name: profile.name,
      language: profile.language,
      isKids: profile.is_kids,
      theme: s.theme,
      notifyNewEpisode: s.notify_new_episode,
      account: { username: req.user.username, locale: req.user.locale || null },
    });
  });

  app.put('/api/settings', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    const body = req.body || {};
    const sets = [], params = [];
    if (body.theme !== undefined) {
      if (!['auto', 'light', 'dark'].includes(body.theme)) return bad(res, 400, 'bad_request');
      sets.push(`theme = $${params.length + 1}`); params.push(body.theme);
    }
    if (body.notifyNewEpisode !== undefined) {
      sets.push(`notify_new_episode = $${params.length + 1}`);
      params.push(Boolean(body.notifyNewEpisode));
    }
    if (sets.length === 0) return bad(res, 400, 'bad_request');
    params.push(profile.id);
    await pool.query(
      `INSERT INTO profile_settings (profile_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [profile.id]);
    await pool.query(
      `UPDATE profile_settings SET ${sets.join(', ')} WHERE profile_id = $${params.length}`,
      params);
    res.json({ ok: true });
  });

  // ── Search ─────────────────────────────────────────────────────────────

  app.get('/api/search', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (!q) return res.json({ dramas: [], nextCursor: null });
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const cursor = parseTextCursor(req.query.cursor);
    const where = [
      `(d.title ILIKE $1 OR d.summary ILIKE $1
        OR EXISTS (SELECT 1 FROM drama_cast dc JOIN cast_members cm ON cm.id = dc.cast_member_id
                   WHERE dc.drama_id = d.id AND cm.name ILIKE $1))`,
    ];
    const params = [likePattern(q)];
    if (profile && profile.is_kids) { params.push('all'); where.push(`d.maturity = $${params.length}`); }
    if (cursor) {
      params.push(cursor.at, cursor.id);
      where.push(`(d.title, d.id) > ($${params.length - 1}, $${params.length}::int)`);
    }
    params.push(limit + 1);
    const rows = await pool.query(
      `SELECT d.* FROM dramas d WHERE ${where.join(' AND ')}
       ORDER BY d.title ASC, d.id ASC LIMIT $${params.length}`, params);
    const hasNext = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    const counts = await dramaCounts(page.map(r => r.id));
    res.json({
      dramas: page.map(d => dramaCard(d, counts.get(String(d.id)))),
      nextCursor: hasNext && page.length ? encodeTextCursor(page[page.length - 1]) : null,
    });
  });

  app.get('/api/search/suggestions', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ suggestions: [] });
    const pat = likePattern(q);
    const dramaRows = await pool.query(
      `SELECT slug, title FROM dramas d
       WHERE d.title ILIKE $1${kidsClause(profile, 'd')}
       ORDER BY (d.title ILIKE $2) DESC, d.title ASC LIMIT 5`,
      [pat, q.replace(/[\\%_]/g, '\\$&') + '%']);
    const castRows = await pool.query(
      `SELECT cm.name,
              array_agg(d.title ORDER BY d.title) FILTER (WHERE d.title IS NOT NULL) AS dramas
       FROM cast_members cm
       JOIN drama_cast dc ON dc.cast_member_id = cm.id
       JOIN dramas d ON d.id = dc.drama_id${profile && profile.is_kids ? ` AND d.maturity = 'all'` : ''}
       WHERE cm.name ILIKE $1
       GROUP BY cm.id, cm.name ORDER BY cm.name LIMIT 3`, [pat]);
    const suggestions = [
      ...dramaRows.rows.map(d => ({ type: 'drama', slug: d.slug, title: d.title })),
      ...castRows.rows.map(c => ({
        type: 'cast', name: c.name,
        dramas: (c.dramas || []).slice(0, 2),
      })),
    ].slice(0, 8);
    res.json({ suggestions });
  });

  app.get('/api/search/recent', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    if (!profile) return res.json({ items: [] });
    const rows = await pool.query(
      `SELECT id, query, created_at FROM search_history
       WHERE profile_id = $1 ORDER BY created_at DESC, id DESC LIMIT 12`, [profile.id]);
    res.json({ items: rows.rows.map(r => ({ id: r.id, query: r.query })) });
  });

  app.post('/api/search/recent', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    const query = String(req.body && req.body.query || '').trim().slice(0, 80);
    if (!query) return bad(res, 400, 'bad_request');
    await pool.query(
      `DELETE FROM search_history WHERE profile_id = $1 AND lower(query) = lower($2)`,
      [profile.id, query]);
    await pool.query(
      `INSERT INTO search_history (profile_id, query, created_at) VALUES ($1, $2, $3)`,
      [profile.id, query, nowOf(req)]);
    // Keep only the 12 latest per profile.
    await pool.query(
      `DELETE FROM search_history WHERE profile_id = $1 AND id NOT IN (
         SELECT id FROM search_history WHERE profile_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 12)`, [profile.id]);
    res.status(201).json({ ok: true });
  });

  app.delete('/api/search/recent', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    await pool.query(`DELETE FROM search_history WHERE profile_id = $1`, [profile.id]);
    res.json({ ok: true });
  });

  app.delete('/api/search/recent/:id', async (req, res) => {
    const profile = await requireProfile(req, res);
    if (!profile) return;
    await pool.query(
      `DELETE FROM search_history WHERE profile_id = $1 AND id = $2`,
      [profile.id, Number(req.params.id)]);
    res.json({ ok: true });
  });

  // ── Because you watched ────────────────────────────────────────────────

  app.get('/api/recommendations', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    if (!profile) return res.json({ base: null, items: [] });
    const base = (await pool.query(
      `SELECT d.id, d.slug, d.title
       FROM episode_watches w
       JOIN episodes e ON e.id = w.episode_id
       JOIN seasons s ON s.id = e.season_id
       JOIN dramas d ON d.id = s.drama_id
       WHERE w.profile_id = $1 AND w.completed = true${kidsClause(profile, 'd')}
       ORDER BY w.last_watched_at DESC LIMIT 1`, [profile.id])).rows[0];
    if (!base) return res.json({ base: null, items: [] });
    const items = (await pool.query(
      `SELECT d.id, d.slug, d.title, d.summary, d.poster_color, d.maturity,
              (count(DISTINCT g.genre_id) + count(DISTINCT dc.cast_member_id))::int AS shared
       FROM dramas d
       LEFT JOIN drama_genres g
         ON g.drama_id = d.id AND g.genre_id IN (SELECT genre_id FROM drama_genres WHERE drama_id = $1)
       LEFT JOIN drama_cast dc
         ON dc.drama_id = d.id AND dc.cast_member_id IN (SELECT cast_member_id FROM drama_cast WHERE drama_id = $1)
       WHERE d.id <> $1${kidsClause(profile, 'd')}
         AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.profile_id = $2 AND f.drama_id = d.id)
         AND NOT EXISTS (SELECT 1 FROM my_list m WHERE m.profile_id = $2 AND m.drama_id = d.id)
         AND NOT EXISTS (
           SELECT 1 FROM episode_watches w
           JOIN episodes e ON e.id = w.episode_id
           JOIN seasons s ON s.id = e.season_id
           WHERE w.profile_id = $2 AND s.drama_id = d.id)
       GROUP BY d.id
       HAVING (count(DISTINCT g.genre_id) + count(DISTINCT dc.cast_member_id)) > 0
       ORDER BY shared DESC, d.title ASC
       LIMIT 6`, [base.id, profile.id])).rows;
    const counts = await dramaCounts(items.map(r => r.id));
    res.json({
      base: { slug: base.slug, title: base.title },
      items: items.map(d => ({ ...dramaCard(d, counts.get(String(d.id))), shared: d.shared })),
    });
  });

  // ── Next to watch ──────────────────────────────────────────────────────

  app.get('/api/next-to-watch', async (req, res) => {
    const ctx = await getProfile(req);
    const profile = ctx && ctx.profile;
    if (!profile) return res.json({ next: null });
    const followed = (await pool.query(
      `SELECT d.id, d.slug, d.title,
              greatest(coalesce(max(w.last_watched_at), 'epoch'::timestamptz), f.created_at) AS activity
       FROM follows f
       JOIN dramas d ON d.id = f.drama_id
       LEFT JOIN seasons s ON s.drama_id = d.id
       LEFT JOIN episodes e ON e.season_id = s.id
       LEFT JOIN episode_watches w ON w.episode_id = e.id AND w.profile_id = $1
       WHERE 1 = 1${kidsClause(profile, 'd')}
       GROUP BY d.id, f.created_at
       ORDER BY activity DESC
       LIMIT 1`, [profile.id])).rows[0];
    if (!followed) return res.json({ next: null });
    const episodes = (await pool.query(
      `SELECT e.id, e.number, e.title, e.watch_url, e.duration_seconds, s.number AS season_number
       FROM episodes e JOIN seasons s ON s.id = e.season_id
       WHERE s.drama_id = $1 ORDER BY s.number, e.number`, [followed.id])).rows;
    const watched = (await pool.query(
      `SELECT w.episode_id, w.completed, w.position_seconds
       FROM episode_watches w
       WHERE w.profile_id = $1 AND w.episode_id = ANY($2)`,
      [profile.id, episodes.map(e => e.id)])).rows;
    // String-normalized: episodes.id is bigint (a string from pg) on
    // legacy-shaped databases while episode_watches.episode_id is integer (a
    // number), so a raw Set.has across that pair silently misses.
    const done = new Set(watched.filter(w => w.completed).map(w => String(w.episode_id)));
    const target = episodes.find(e => !done.has(String(e.id)));
    if (!target) {
      return res.json({ next: null, finished: { slug: followed.slug, title: followed.title } });
    }
    const seasonEpisodes = episodes.filter(e => e.season_number === target.season_number);
    const watchedInSeason = seasonEpisodes.filter(e => done.has(String(e.id))).length;
    const position = watched.find(w => String(w.episode_id) === String(target.id));
    const startIdx = episodes.indexOf(target);
    res.json({
      next: {
        drama: { slug: followed.slug, title: followed.title },
        seasonNumber: target.season_number,
        seasonTotal: seasonEpisodes.length,
        watchedInSeason,
        episode: {
          id: target.id, number: target.number, title: target.title,
          watchUrl: target.watch_url, durationSeconds: target.duration_seconds,
          positionSeconds: position ? position.position_seconds : 0,
        },
        nextEpisodes: episodes.slice(startIdx, startIdx + 4).map(e => ({
          id: e.id, number: e.number, title: e.title, seasonNumber: e.season_number,
        })),
      },
    });
  });
};

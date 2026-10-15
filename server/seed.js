// HomeClip's catalog source data and staging seeds.
//
// The dramas, seasons, episodes, genres and cast below are the app's own
// sample catalog — the data the first versions shipped in a JS module, now
// imported into the real Postgres tables at boot. In staging (USERNODE_ENV
// === 'staging') the import runs on every boot, idempotently, so previews and
// the proposal checks always have this catalog to show; production starts
// with an empty catalog that the group fills by adding dramas in the app.
//
// Rules followed here (platform conventions, "Staging mock data"):
// - the whole block is gated on IS_STAGING and is a no-op in production;
// - every insert is ON CONFLICT DO NOTHING, so reboots change nothing;
// - rows use fixed ids in the 900000 range and "Staging demo" titles, so
//   they can never be mistaken for real user content;
// - identities are fake ("Demo mate" belongs to a made-up account id) —
//   no rows are ever created for whoever opens a preview. The one exception
//   is the shots fixture account (`usernode-capture`), created lazily by
//   username on its own sign-in, as the before/after-shots convention allows.

const CATALOG = [
  {
    id: 930001,
    slug: 'staging-demo-harbour-lights',
    title: 'Staging demo: Harbour Lights',
    summary: 'Two lighthouse keepers and a harbourmaster’s office unravel a small town’s oldest mystery, one tide at a time.',
    posterColor: '#0f766e',
    maturity: 'all',
    addedBy: 'staging-demo-user',
    ageDays: 30,
    genres: ['Mystery', 'Drama'],
    cast: [
      { name: 'Mara Hardwick', character: 'Eva Marsh' },
      { name: 'Tomas Reyes', character: 'Danny Cole' },
    ],
    seasons: [
      {
        number: 1,
        episodes: [
          { id: 900001, title: 'Pilot Light', ageDays: 30 },
          { id: 900002, title: 'Salt in the Air', ageDays: 29 },
          { id: 900003, title: 'Low Tide', ageDays: 28, watchUrl: '/demo/clip.mp4', durationSeconds: 24 },
          { id: 900004, title: 'Tide and Teeth', ageDays: 21 },
          { id: 900005, title: 'The Beacon', ageDays: 14 },
          { id: 900006, title: 'Storm Warning', ageDays: 7 },
        ],
      },
      {
        number: 2,
        episodes: [
          { id: 900007, title: 'New Mooring', ageDays: 26 },
          { id: 900008, title: 'Old Debts', ageDays: 25 },
          { id: 900009, title: 'The Ledger', ageDays: 24 },
          { id: 900010, title: 'Harbour Lights', ageDays: 23 },
        ],
      },
    ],
  },
  {
    id: 930002,
    slug: 'staging-demo-night-market-chef',
    title: 'Staging demo: Night Market Chef',
    summary: 'A late-night market cook trades her family recipe for a shot at her own stall, one order at a time.',
    posterColor: '#b45309',
    maturity: 'all',
    addedBy: 'staging-demo-user',
    ageDays: 26,
    genres: ['Food', 'Romance'],
    cast: [
      { name: 'Ayu Prameswari', character: 'Chef Ayu' },
      { name: 'Kwame Boateng', character: 'Sam' },
    ],
    seasons: [
      {
        number: 1,
        episodes: [
          { id: 900011, title: 'Night Shift', ageDays: 26, watchUrl: '/demo/clip.mp4', durationSeconds: 24 },
          { id: 900012, title: 'Wok This Way', ageDays: 20 },
          { id: 900013, title: 'Family Recipe', ageDays: 13 },
          { id: 900014, title: 'The Regulars', ageDays: 6 },
          { id: 900015, title: 'Closing Time', ageDays: 5 },
          { id: 900016, title: 'One More Order', ageDays: 2 },
        ],
      },
    ],
  },
  {
    id: 930003,
    slug: 'staging-demo-tide-house',
    title: 'Staging demo: Tide House',
    summary: 'A young building manager discovers her block’s flooded ground floor hides more than old furniture.',
    posterColor: '#1d4ed8',
    maturity: 'all',
    addedBy: 'staging-demo-user',
    ageDays: 18,
    genres: ['Mystery', 'Drama'],
    cast: [
      { name: 'Devi Lestari', character: 'Nadia' },
      { name: 'Tomas Reyes', character: 'Owen' },
    ],
    seasons: [
      {
        number: 1,
        episodes: [
          { id: 900017, title: 'The Keys', ageDays: 18 },
          { id: 900018, title: 'Ground Floor', ageDays: 17 },
          { id: 900019, title: 'Watermark', ageDays: 12 },
          { id: 900020, title: 'The Tenant', ageDays: 9 },
          { id: 900021, title: 'Floodline', ageDays: 4 },
        ],
      },
    ],
  },
  {
    id: 930004,
    slug: 'staging-demo-fog-line',
    title: 'Staging demo: Fog Line',
    summary: 'The last ferry route in the bay gets one more season, and its passenger lists hide a quiet mystery.',
    posterColor: '#57534e',
    maturity: 'all',
    addedBy: 'staging-demo-user',
    ageDays: 11,
    genres: ['Mystery'],
    cast: [
      { name: 'Mara Hardwick', character: 'Ines' },
    ],
    seasons: [
      {
        number: 1,
        episodes: [
          { id: 900022, title: 'Arrivals', ageDays: 11 },
          { id: 900023, title: 'The Ferry Schedule', ageDays: 10 },
          { id: 900024, title: 'Crossings', ageDays: 8 },
          { id: 900025, title: 'Departures', ageDays: 3 },
          { id: 900026, title: 'Last Boat', ageDays: 1 },
        ],
      },
    ],
  },
  {
    id: 930005,
    slug: 'staging-demo-the-vault-job',
    title: 'Staging demo: The Vault Job',
    summary: 'Four retired museum staff plan a paperwork-perfect return of a long-borrowed painting, a gentle caper where the loudest thing is a squeaky floorboard.',
    posterColor: '#7c3aed',
    maturity: 'mature',
    addedBy: 'staging-demo-user',
    ageDays: 8,
    genres: ['Heist'],
    cast: [
      { name: 'Kwame Boateng', character: 'The Fixer' },
    ],
    seasons: [
      {
        number: 1,
        episodes: [
          { id: 900027, title: 'The Plan', ageDays: 8 },
          { id: 900028, title: 'The Crew', ageDays: 7 },
          { id: 900029, title: 'The Window', ageDays: 6 },
          { id: 900030, title: 'The Vault', ageDays: 5 },
        ],
      },
    ],
  },
];

const FAKE_ACCOUNT_ID = -900001; // the made-up "Demo mate" profile owner

// Bump each serial sequence past the fixed ids the seed inserted, so later
// user-created rows never collide with them.
async function realignSequences(pool, tables) {
  for (const table of tables) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT MAX(id) FROM ${table}), 1))`,
      [table]
    );
  }
}

// Import the catalog into the public tables. Staging only: production keeps
// an empty catalog for the group to fill with real dramas.
async function seedCatalog(pool) {
  const dramaIds = [];
  for (const drama of CATALOG) {
    dramaIds.push(drama.id);
    await pool.query(
      `INSERT INTO dramas (id, slug, title, summary, poster_color, maturity, added_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - ($8 || ' days')::interval, now() - ($8 || ' days')::interval)
       ON CONFLICT (id) DO NOTHING`,
      [drama.id, drama.slug, drama.title, drama.summary, drama.posterColor,
       drama.maturity, drama.addedBy, String(drama.ageDays)]
    );
    for (const genreName of drama.genres) {
      await pool.query(
        `INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [genreName]
      );
      await pool.query(
        `INSERT INTO drama_genres (drama_id, genre_id)
         SELECT $1, id FROM genres WHERE name = $2
         ON CONFLICT DO NOTHING`,
        [drama.id, genreName]
      );
    }
    for (const member of drama.cast) {
      await pool.query(
        `INSERT INTO cast_members (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [member.name]
      );
      await pool.query(
        `INSERT INTO drama_cast (drama_id, cast_member_id, character_name)
         SELECT $1, id, $3 FROM cast_members WHERE name = $2
         ON CONFLICT (drama_id, cast_member_id) DO NOTHING`,
        [drama.id, member.name, member.character]
      );
    }
  }
  // Seasons and episodes get derived ids so they stay stable across boots:
  // season id = drama id * 100 + number, episode id is inserted explicitly.
  for (const drama of CATALOG) {
    for (const season of drama.seasons) {
      const seasonId = drama.id * 100 + season.number; // e.g. 930101
      await pool.query(
        `INSERT INTO seasons (id, drama_id, number, title)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [seasonId, drama.id, season.number, 'Season ' + season.number]
      );
      for (const episode of season.episodes) {
        await pool.query(
          `INSERT INTO episodes (id, season_id, number, title, watch_url, duration_seconds, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval)
           ON CONFLICT (id) DO NOTHING`,
          [episode.id, seasonId, season.episodes.indexOf(episode) + 1, episode.title,
           episode.watchUrl || '', episode.durationSeconds || 0, String(episode.ageDays)]
        );
      }
    }
  }
  await realignSequences(pool, ['dramas', 'seasons', 'episodes']);
}

// A fake viewer so "who else watched" and group ratings show activity in
// previews without ever referencing a real user. Private table, seeded here
// because staging copies private tables schema-only.
async function seedFakeViewer(pool) {
  await pool.query(
    `INSERT INTO profiles (id, account_id, name, is_kids)
     VALUES (950001, $1, 'Demo mate', false)
     ON CONFLICT (id) DO NOTHING`,
    [FAKE_ACCOUNT_ID]
  );
  await realignSequences(pool, ['profiles']);
  // Follows Harbour Lights and watched its first two episodes.
  await pool.query(
    `INSERT INTO follows (profile_id, drama_id) VALUES (950001, 930001) ON CONFLICT DO NOTHING`
  );
  for (const [episodeId, days] of [[900001, 20], [900002, 19]]) {
    await pool.query(
      `INSERT INTO episode_watches (profile_id, episode_id, position_seconds, completed, first_opened_at, last_watched_at)
       VALUES (950001, $1, 0, true, now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval)
       ON CONFLICT (profile_id, episode_id) DO NOTHING`,
      [episodeId, String(days)]
    );
  }
  await pool.query(
    `INSERT INTO episode_watches (profile_id, episode_id, position_seconds, completed, first_opened_at, last_watched_at)
     VALUES (950001, 900003, 9, false, now() - interval '4 days', now() - interval '4 days')
     ON CONFLICT (profile_id, episode_id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO ratings (profile_id, drama_id, stars, updated_at)
     VALUES (950001, 930001, 4, now() - interval '10 days')
     ON CONFLICT (profile_id, drama_id) DO NOTHING`
  );
}

// Boot seed: everything a staging preview or check run needs to see. Never
// runs in production.
async function seedIfStaging(pool, isStaging) {
  if (!isStaging) return;
  await seedCatalog(pool);
  await seedFakeViewer(pool);
}

// Lazily give the before/after shots' fixture account its viewing data, the
// one sanctioned exception to "never seed the visitor": a named account
// seeded by username (not "whoever opened the preview"), staging only,
// idempotent. Called from GET /api/me before answering.
const SHOTS_FIXTURE_USERNAMES = new Set(['usernode-capture']);

async function ensureShotsFixtures(pool, isStaging, user) {
  if (!isStaging || !user || !SHOTS_FIXTURE_USERNAMES.has(user.username)) return;
  const accountId = user.id;
  const existing = await pool.query(
    `SELECT count(*)::int AS n FROM profiles WHERE account_id = $1`, [accountId]);
  if (existing.rows[0].n > 0) return; // only on the very first sign-in
  await pool.query(
    `INSERT INTO profiles (account_id, name, is_kids) VALUES ($1, 'Demo viewer', false)
     ON CONFLICT (account_id, name) DO NOTHING`, [accountId]);
  await pool.query(
    `INSERT INTO profiles (account_id, name, is_kids) VALUES ($1, 'Milo', true)
     ON CONFLICT (account_id, name) DO NOTHING`, [accountId]);
  const viewer = await pool.query(
    `SELECT id FROM profiles WHERE account_id = $1 AND name = 'Demo viewer'`, [accountId]);
  const profileId = viewer.rows[0]?.id;
  if (!profileId) return;
  await pool.query(
    `INSERT INTO follows (profile_id, drama_id) VALUES ($1, 930001), ($1, 930002)
     ON CONFLICT DO NOTHING`, [profileId]);
  for (const episodeId of [900001, 900002]) {
    await pool.query(
      `INSERT INTO episode_watches (profile_id, episode_id, position_seconds, completed, first_opened_at, last_watched_at)
       VALUES ($1, $2, 0, true, now() - interval '3 days', now() - interval '3 days')
       ON CONFLICT (profile_id, episode_id) DO NOTHING`, [profileId, episodeId]);
  }
  await pool.query(
    `INSERT INTO episode_watches (profile_id, episode_id, position_seconds, completed, first_opened_at, last_watched_at)
     VALUES ($1, 900003, 9, false, now() - interval '2 days', now() - interval '2 days')
     ON CONFLICT (profile_id, episode_id) DO NOTHING`, [profileId]);
  await pool.query(
    `INSERT INTO ratings (profile_id, drama_id, stars, updated_at)
     VALUES ($1, 930001, 4, now() - interval '2 days')
     ON CONFLICT (profile_id, drama_id) DO NOTHING`, [profileId]);
  await pool.query(
    `INSERT INTO my_list (profile_id, drama_id) VALUES ($1, 930002)
     ON CONFLICT DO NOTHING`, [profileId]);
  for (const queryText of ['harbour', 'tide']) {
    await pool.query(
      `INSERT INTO search_history (profile_id, query) VALUES ($1, $2)`,
      [profileId, queryText]);
  }
}

module.exports = { seedIfStaging, ensureShotsFixtures, CATALOG };

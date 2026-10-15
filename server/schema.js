// Boot-time schema migration for HomeClip.
//
// Runs on every boot, before the server accepts traffic. Every statement is
// idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) so a
// container restart — or a staging container built from a copy of the
// production database — can run it repeatedly.
//
// Table visibility: catalog tables (dramas, seasons, episodes, genres, cast)
// are public — reference data the whole group sees in-app. Everything keyed
// to a profile (profiles, follows, episode_watches, my_list, ratings,
// profile_settings, search_history) holds one person's viewing data, so it is
// marked `staging:private` with COMMENT ON TABLE: staging previews copy those
// schema-only, and server/seed.js seeds fake rows for them (see
// "Public vs private tables" in the platform conventions).

const PRIVATE = 'staging:private';

async function migrate(pool) {
  const q = (text) => pool.query(text);

  // ── Legacy reconciliation ──────────────────────────────────────────────
  // Phases 1-4a kept the catalog in a user-keyed shape: dramas/episodes
  // owned by added_by_id/added_by_username, follows keyed by user_id +
  // username. A staging database is a COPY of production, so on it those
  // tables already exist when this migration runs and every CREATE TABLE
  // IF NOT EXISTS here is a silent no-op — which used to fail the whole
  // boot with 'error: column "season_id" does not exist' when the index
  // below touched the legacy episodes table.
  //
  // The per-profile `follows` this app uses now shares its name with the
  // legacy user-keyed table. Rename the legacy one aside before the
  // per-profile schema is created: legacy routes keep reading and writing
  // follows_legacy (see server.js), and the new per-profile table is
  // created fresh below.
  await q(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'follows' AND column_name = 'user_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'follows' AND column_name = 'profile_id') THEN
        ALTER TABLE follows RENAME TO follows_legacy;
      END IF;
    END $$`);
  await q(`DO $$
    BEGIN
      IF to_regclass('follows_legacy') IS NOT NULL THEN
        EXECUTE format('COMMENT ON TABLE follows_legacy IS %L', $private$${PRIVATE}$private$);
      END IF;
    END $$`);

  // ── Public catalog ─────────────────────────────────────────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS dramas (
      id serial PRIMARY KEY,
      slug text NOT NULL,
      title text NOT NULL,
      summary text NOT NULL DEFAULT '',
      poster_color text NOT NULL DEFAULT '',
      maturity text NOT NULL DEFAULT 'all' CHECK (maturity IN ('all', 'mature')),
      added_by text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS seasons (
      id serial PRIMARY KEY,
      drama_id integer NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      number integer NOT NULL,
      title text NOT NULL DEFAULT '',
      UNIQUE (drama_id, number)
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS episodes (
      id serial PRIMARY KEY,
      season_id integer NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      number integer NOT NULL,
      title text NOT NULL,
      watch_url text NOT NULL DEFAULT '',
      duration_seconds integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (season_id, number)
    )`);
  await q(`CREATE TABLE IF NOT EXISTS genres (
      id serial PRIMARY KEY,
      name text UNIQUE NOT NULL
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS drama_genres (
      drama_id integer NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      genre_id integer NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
      PRIMARY KEY (drama_id, genre_id)
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS cast_members (
      id serial PRIMARY KEY,
      name text UNIQUE NOT NULL
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS drama_cast (
      drama_id integer NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      cast_member_id integer NOT NULL REFERENCES cast_members(id) ON DELETE CASCADE,
      character_name text NOT NULL DEFAULT '',
      PRIMARY KEY (drama_id, cast_member_id)
    )`);

  // ── Legacy table upgrade ───────────────────────────────────────────────
  // On a database that predates this schema, the CREATEs above were
  // no-ops and dramas/episodes still carry the legacy shape. Add the new
  // columns and fill them from the legacy equivalents, so one table serves
  // both the legacy routes (server.js) and the Phase-2 routes
  // (server/api.js). On a database this file created, the columns already
  // exist and every backfill below matches nothing.
  await q(`ALTER TABLE dramas ADD COLUMN IF NOT EXISTS slug text`);
  await q(`ALTER TABLE dramas ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE dramas ADD COLUMN IF NOT EXISTS poster_color text NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE dramas ADD COLUMN IF NOT EXISTS maturity text NOT NULL DEFAULT 'all'`);
  await q(`ALTER TABLE dramas ADD COLUMN IF NOT EXISTS added_by text NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE dramas ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await q(`ALTER TABLE episodes ADD COLUMN IF NOT EXISTS season_id integer`);
  await q(`ALTER TABLE episodes ADD COLUMN IF NOT EXISTS duration_seconds integer NOT NULL DEFAULT 0`);

  // Slugs for dramas that predate them, taken from the title. Legacy seed
  // dramas already insert namespaced slugs ("demo-…", "sample-…"), so the
  // backfill only ever fills rows that have none.
  await q(`DO $$
    BEGIN
      UPDATE dramas
      SET slug = trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'))
      WHERE slug IS NULL OR slug = '';
      UPDATE dramas SET slug = 'drama-' || id WHERE slug IS NULL OR slug = '';
      WHILE EXISTS (SELECT 1 FROM dramas
                    WHERE slug IS NOT NULL GROUP BY slug HAVING count(*) > 1) LOOP
        UPDATE dramas d SET slug = d.slug || '-' || d.id
        WHERE EXISTS (SELECT 1 FROM dramas d2
                      WHERE d2.slug = d.slug AND d2.id <> d.id AND d2.id < d.id);
      END LOOP;
    END $$`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS dramas_slug_idx ON dramas (slug)`);

  // Summary, poster and adder for legacy rows.
  await q(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'dramas' AND column_name = 'synopsis') THEN
        UPDATE dramas SET summary = synopsis
        WHERE summary = '' AND synopsis IS NOT NULL AND synopsis <> '';
      END IF;
    END $$`);
  await q(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'dramas' AND column_name = 'added_by_username') THEN
        UPDATE dramas SET added_by = added_by_username WHERE added_by = '';
      END IF;
    END $$`);

  // The legacy watch_url CHECK allowed only https links; episodes now may
  // carry app-relative URLs (the staging demo clip is /demo/clip.mp4), so
  // drop whatever CHECK constrains that column.
  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'episodes'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) ILIKE '%watch_url%'
    LOOP
      EXECUTE 'ALTER TABLE episodes DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
  END $$`);

  // Legacy episodes are keyed by (drama_id, season); derive the seasons and
  // point each episode at its season, so both code paths address the same
  // rows. The new route's inserts leave drama_id/season empty (their
  // linkage is season_id), so those two legacy NOT NULLs are relaxed.
  await q(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'episodes' AND column_name = 'drama_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'episodes' AND column_name = 'season') THEN
        ALTER TABLE episodes ALTER COLUMN drama_id DROP NOT NULL;
        ALTER TABLE episodes ALTER COLUMN season DROP NOT NULL;
        INSERT INTO seasons (drama_id, number, title)
        SELECT DISTINCT e.drama_id, e.season, 'Season ' || e.season
        FROM episodes e
        WHERE e.season_id IS NULL AND e.drama_id IS NOT NULL AND e.season IS NOT NULL
        ON CONFLICT (drama_id, number) DO NOTHING;
        UPDATE episodes e SET season_id = s.id
        FROM seasons s
        WHERE e.season_id IS NULL AND e.drama_id = s.drama_id AND e.season = s.number;
      END IF;
    END $$`);

  // Indices the feed, search and recommendation queries use.
  await q(`CREATE INDEX IF NOT EXISTS dramas_created_idx ON dramas (created_at DESC, id DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS episodes_season_idx ON episodes (season_id, number)`);
  await q(`CREATE INDEX IF NOT EXISTS drama_genres_genre_idx ON drama_genres (genre_id)`);
  await q(`CREATE INDEX IF NOT EXISTS drama_cast_member_idx ON drama_cast (cast_member_id)`);

  // ── Per-profile tables (private) ───────────────────────────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS profiles (
      id serial PRIMARY KEY,
      account_id bigint NOT NULL,
      name text NOT NULL,
      avatar_url text NOT NULL DEFAULT '',
      avatar_file_id text NOT NULL DEFAULT '',
      language text NOT NULL DEFAULT '',
      is_kids boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, name)
    )`);
  await q(`CREATE INDEX IF NOT EXISTS profiles_account_idx ON profiles (account_id)`);

  await q(`
    CREATE TABLE IF NOT EXISTS follows (
      profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      drama_id integer NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, drama_id)
    )`);

  await q(`
    CREATE TABLE IF NOT EXISTS episode_watches (
      profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      episode_id integer NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      position_seconds integer NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
      completed boolean NOT NULL DEFAULT false,
      first_opened_at timestamptz,
      last_watched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, episode_id)
    )`);
  await q(`CREATE INDEX IF NOT EXISTS episode_watches_profile_idx ON episode_watches (profile_id, last_watched_at DESC)`);

  await q(`
    CREATE TABLE IF NOT EXISTS my_list (
      profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      drama_id integer NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, drama_id)
    )`);

  await q(`
    CREATE TABLE IF NOT EXISTS ratings (
      profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      drama_id integer NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
      stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, drama_id)
    )`);

  await q(`
    CREATE TABLE IF NOT EXISTS profile_settings (
      profile_id integer PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      theme text NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark')),
      notify_new_episode boolean NOT NULL DEFAULT true
    )`);

  await q(`
    CREATE TABLE IF NOT EXISTS search_history (
      id serial PRIMARY KEY,
      profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      query text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await q(`CREATE INDEX IF NOT EXISTS search_history_profile_idx ON search_history (profile_id, created_at DESC)`);

  // Mark the per-profile tables private AFTER creating them, in the same
  // migration: staging copies then carry their schema but none of their rows.
  // COMMENT does not accept bind parameters, and PRIVATE is a fixed constant
  // from this file, so it is inlined directly.
  for (const table of [
    'profiles', 'follows', 'episode_watches', 'my_list',
    'ratings', 'profile_settings', 'search_history',
  ]) {
    await q(`COMMENT ON TABLE ${table} IS '${PRIVATE}'`);
  }
}

module.exports = { migrate };

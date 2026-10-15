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

  // ── Public catalog ─────────────────────────────────────────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS dramas (
      id serial PRIMARY KEY,
      slug text UNIQUE NOT NULL,
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

// TMDB metadata provider. Like the Stripe adapter: plain fetch over the
// REST API, no runtime dependency, the API key read from the environment
// (dapp.json's TMDB_API_KEY) and never sent to the browser. Used only by
// the server-side curator routes (/api/admin/tmdb/*, /api/admin/dramas/*):
// search, record fetch and image-URL building.
//
// Verification is fail-closed and happens in server.js: an import re-fetches
// the record HERE and confirms the curator's title + year against it before
// anything is written. This module just talks to TMDB.

const API = 'https://api.themoviedb.org/3';
const CONFIG_TTL = 24 * 60 * 60 * 1000;

function configured() {
  return Boolean(process.env.TMDB_API_KEY);
}

function tmdbError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

async function call(path, params) {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw tmdbError('tmdb_not_configured');
  const url = new URL(API + path);
  url.searchParams.set('api_key', key);
  for (const k in (params || {})) url.searchParams.set(k, params[k]);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw tmdbError('tmdb_unreachable', 'TMDB request failed: ' + e.message);
  }
  if (res.status === 401) throw tmdbError('tmdb_auth', 'TMDB rejected the API key');
  if (!res.ok) throw tmdbError('tmdb_error', 'TMDB returned ' + res.status);
  return res.json();
}

// The provider's image configuration, cached for a day: image URLs must be
// built from secure_base_url + a size the provider actually serves.
let cfg = null;
let cfgAt = 0;
async function imageConfig() {
  if (cfg && Date.now() - cfgAt < CONFIG_TTL) return cfg;
  const c = await call('/configuration');
  cfg = {
    secureBaseUrl: c.images.secure_base_url,
    posterSizes: c.images.poster_sizes,
    backdropSizes: c.images.backdrop_sizes,
  };
  cfgAt = Date.now();
  return cfg;
}

// One image URL from the provider's own configuration. `preferred` is used
// when the provider lists it; otherwise the largest listed size before
// "original" (an "original" poster can be many megabytes).
async function imageUrl(kind, path, preferred) {
  if (!path) return null;
  const c = await imageConfig();
  const sizes = kind === 'poster' ? c.posterSizes : c.backdropSizes;
  const size = sizes.includes(preferred)
    ? preferred
    : sizes.filter((s) => s !== 'original').slice(-1)[0] || 'original';
  return c.secureBaseUrl + size + path;
}

// Search candidates. Read-only; the caller never saves from this shape.
async function searchTv(q) {
  const r = await call('/search/tv', { query: q, include_adult: 'false' });
  const cfgC = await imageConfig();
  return r.results.map((t) => ({
    tmdbId: t.id,
    title: t.name,
    originalTitle: t.original_name,
    year: t.first_air_date ? Number(String(t.first_air_date).slice(0, 4)) : null,
    posterUrl: t.poster_path ? cfgC.secureBaseUrl + 'w300' + t.poster_path : null,
    overview: t.overview || '',
    originCountry: (t.origin_country && t.origin_country[0]
      ? t.origin_country[0].toLowerCase() : '') || null,
  }));
}

// One full record, fetched in a single round trip: metadata + the
// selectable artwork lists + alternative titles + credits.
async function getTv(tmdbId) {
  const raw = await call('/tv/' + tmdbId, {
    append_to_response: 'images,alternative_titles,credits',
    include_image_language: 'en,null',
  });
  const cfgC = await imageConfig();
  return {
    tmdbId: raw.id,
    title: raw.name,
    originalTitle: raw.original_name,
    year: raw.first_air_date ? Number(String(raw.first_air_date).slice(0, 4)) : null,
    language: raw.original_language || null,
    country: (raw.origin_country && raw.origin_country[0]
      ? raw.origin_country[0].toLowerCase() : '') || null,
    genresRaw: (raw.genres || []).map((g) => g.name),
    overview: raw.overview || '',
    cast: (raw.credits && raw.credits.cast ? raw.credits.cast : [])
      .slice(0, 4).map((c) => c.name),
    director: (raw.created_by || []).map((c) => c.name).join(', ') || null,
    totalEpisodes: raw.number_of_episodes || null,
    episodeDurationMin: (raw.episode_run_time && raw.episode_run_time[0]) || null,
    rating: raw.vote_average || 0,
    alternativeTitles: (raw.alternative_titles && raw.alternative_titles.results
      ? raw.alternative_titles.results : []).map((t) => t.title).slice(0, 20),
    posters: (raw.images && raw.images.posters ? raw.images.posters : [])
      .map((p) => ({ path: p.file_path, thumb: cfgC.secureBaseUrl + 'w300' + p.file_path })),
    backdrops: (raw.images && raw.images.backdrops ? raw.images.backdrops : [])
      .map((p) => ({ path: p.file_path, thumb: cfgC.secureBaseUrl + 'w300' + p.file_path })),
  };
}

// Build the stored URLs from chosen paths, per the provider's image
// configuration. Called by the import/PATCH routes after the paths are
// validated against the record's own image lists.
async function artworkUrls(posterPath, backdropPath) {
  const [posterUrl, backdropUrl] = await Promise.all([
    posterPath ? imageUrl('poster', posterPath, 'w500') : null,
    backdropPath ? imageUrl('backdrop', backdropPath, 'w780') : null,
  ]);
  return { posterUrl, backdropUrl };
}

// TMDB genre names -> the app's six-genre vocabulary (+ drama). Unmapped
// names stay in genres_raw only, never force-fitted.
const GENRE_NAME_MAP = {
  'drama': 'drama',
  'romance': 'romance',
  'comedy': 'comedy',
  'mystery': 'thriller',
  'crime': 'thriller',
  'thriller': 'thriller',
  'sci-fi & fantasy': 'fantasy',
  'sci-fi': 'fantasy',
  'fantasy': 'fantasy',
  'history': 'historical',
  'action & adventure': 'action',
  'action': 'action',
  'war & politics': 'action',
};

function mapGenres(names) {
  const mapped = [];
  for (const n of names || []) {
    const g = GENRE_NAME_MAP[String(n).toLowerCase()];
    if (g && !mapped.includes(g)) mapped.push(g);
  }
  return mapped;
}

module.exports = {
  id: 'tmdb',
  configured,
  searchTv,
  getTv,
  imageUrl,
  artworkUrls,
  mapGenres,
  GENRE_NAME_MAP,
};

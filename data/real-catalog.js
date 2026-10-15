// Curated seed list for the real drama catalog. Unlike data/catalog.js
// (the invented sample dramas), these are REAL series: at boot, when
// TMDB_API_KEY is set, server.js resolves each entry against the provider
// and imports it through the same verify path the curator studio uses —
// normalized title (against the provider's title OR original title) and an
// exact release-year match, both checked against a fresh provider fetch.
// An entry that fails verification is skipped and reported; it is never
// paired with a guessed poster. tmdbId pins a known provider record to
// skip the search step; entries without one resolve by search (year ±1 and
// origin-country match), then face the same exact verify.
//
// popularity / featured / isTrending are editorial weight for the Home
// rows, applied after the verified import (a studio import never sets
// them). vipEpisodes marks the drama's final N episodes VIP so the
// player's paywall stays demonstrable once the sample catalog leaves the
// plain viewer reads.
//
// Indonesian short dramas have thin provider coverage today, so short-form
// is still represented by the staging demo shorts; more arrive through the
// Posters studio's search or manual-add path.
const REAL_CATALOG = [
  { title: 'Crash Landing on You', year: 2019, country: 'kr', popularity: 90, featured: 1, isTrending: true },
  { title: 'Squid Game', year: 2021, country: 'kr', popularity: 88, featured: 2, isTrending: true, vipEpisodes: 2 },
  { title: 'Reply 1988', year: 2015, country: 'kr', popularity: 84, isTrending: true },
  { title: 'Guardian: The Lonely and Great God', year: 2016, country: 'kr', popularity: 82, isTrending: true },
  { title: 'Extraordinary Attorney Woo', year: 2022, country: 'kr', popularity: 80, featured: 3, isTrending: true },
  { title: 'Hometown Cha-Cha-Cha', year: 2021, country: 'kr', popularity: 74 },
  { title: 'The Untamed', year: 2019, country: 'cn', popularity: 78, featured: 4, isTrending: true, vipEpisodes: 2 },
  { title: 'Nirvana in Fire', year: 2015, country: 'cn', popularity: 72, isTrending: true },
  { title: 'Love Between Fairy and Devil', year: 2022, country: 'cn', popularity: 70, isTrending: true },
  { title: 'Story of Yanxi Palace', year: 2018, country: 'cn', popularity: 66 },
  { title: 'Great Teacher Onizuka', year: 1998, country: 'jp', popularity: 64, isTrending: true },
  { title: '1 Litre of Tears', year: 2005, country: 'jp', popularity: 60 },
  { title: 'First Love', year: 2022, country: 'jp', popularity: 58 },
  { title: 'Girl from Nowhere', year: 2018, country: 'th', popularity: 68, featured: 5, isTrending: true },
  { title: '2gether', year: 2020, country: 'th', popularity: 56 },
  { title: 'Garis Waktu', year: 2022, country: 'id', popularity: 54 },
];

module.exports = { REAL_CATALOG };

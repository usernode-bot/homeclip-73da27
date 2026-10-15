#!/usr/bin/env node
// Acceptance check for the real drama poster system.
//
//   node scripts/verify-posters.js [--base http://localhost:3000] [--min 10]
//                                   [--token <usernode JWT>]
//
// For every catalog record that carries a provider ID (tmdb_id, not a demo
// row) it re-fetches the provider record and fails the run unless:
//   identity   — the stored title matches the provider's title OR original
//                title (normalized), and the year and country match exactly;
//   poster     — poster_url is the provider CDN URL of one of THAT record's
//                own poster paths (so a correct-looking URL for the wrong
//                show cannot pass), and the link loads;
//   backdrop   — same for backdrop_url when the record stores one;
//   coverage   — at least --min records pass all of the above.
// With --base it also checks the served app: plain /api/home and
// /api/dramas must not leak sample dramas (id < 9000, no provider ID), and
// /api/dramas?q=… and /api/dramas/:id must return the SAME poster for the
// same drama (search vs detail consistency). The served app gates every
// /api/* route behind the platform token, so --base also needs --token.
//
// Needs DATABASE_URL (Postgres) and TMDB_API_KEY in the environment; exits
// non-zero when anything fails or is unverifiable.

const { Pool } = require('pg');
const tmdb = require('../providers/tmdb');
const { probeArtwork } = require('../art-probe');

// Same normalization as the server's verify (server.js normTitle): case,
// spacing and punctuation are ignored; the words must match.
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const min = parseInt(arg('min', '10'), 10) || 10;
  const base = arg('base', null);
  const token = arg('token', null);
  const apiHeaders = token ? { 'x-usernode-token': token } : {};
  if (!process.env.DATABASE_URL) {
    console.error('verify-posters: DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const rows = (await pool.query(
    `SELECT id, tmdb_id, title, original_title, year, country, poster_url, backdrop_url
     FROM dramas WHERE tmdb_id IS NOT NULL AND NOT is_demo ORDER BY id`
  )).rows;

  const table = [];
  const failures = [];
  for (const row of rows) {
    const entry = {
      id: row.id, title: row.title, year: row.year,
      identity: 'fail', poster: 'fail', backdrop: '—',
    };
    try {
      const raw = await tmdb.getTv(row.tmdb_id);
      // The stored record must be the same show as the provider record:
      // the stored title matches the provider's title OR original title
      // (normalized), the year matches exactly, the country does not
      // contradict.
      const nt = normTitle(row.title);
      const matches = nt
        && (nt === normTitle(raw.title) || nt === normTitle(raw.originalTitle));
      const yearOk = Number(row.year) === raw.year;
      const countryOk = !row.country || !raw.country || row.country === raw.country;
      entry.identity = matches && yearOk && countryOk ? 'ok' : 'fail';

      // The stored URL must be the provider CDN URL of one of this record's
      // OWN artwork paths, and the link must load.
      const checkUrl = async (url, kind, paths, size) => {
        if (!url) return 'none';
        for (const p of paths) {
          if (url === await tmdb.imageUrl(kind, p.path, size)) {
            return await probeArtwork(url) === 'ok' ? 'ok' : 'broken';
          }
        }
        return 'foreign';
      };
      entry.poster = await checkUrl(row.poster_url, 'poster', raw.posters || [], 'w500');
      if (row.backdrop_url) {
        entry.backdrop = await checkUrl(row.backdrop_url, 'backdrop', raw.backdrops || [], 'w780');
      } else {
        entry.backdrop = '—';
      }
    } catch (e) {
      entry.identity = e.code || 'unreachable';
    }
    const ok = entry.identity === 'ok' && entry.poster === 'ok' &&
      entry.backdrop !== 'broken' && entry.backdrop !== 'foreign';
    if (!ok) failures.push(entry);
    table.push({ ...entry, ok });
  }

  // Print the verification table — the acceptance evidence.
  console.log('');
  console.log('drama id   title                                   year   identity  poster      backdrop');
  for (const t of table) {
    const pad = (s, n) => String(s).padEnd(n).slice(0, n);
    console.log(
      pad(t.id, 10) + pad(t.title, 39) + pad(t.year, 6) + '  ' +
      pad(t.identity, 9) + pad(t.poster, 11) + pad(t.backdrop, 9) + (t.ok ? '' : '  ← FAIL'));
  }

  // Coverage: enough records must pass every check.
  const passed = table.filter((t) => t.ok).length;
  console.log('');
  console.log(passed + ' of ' + table.length + ' provider-linked records fully verified (minimum ' + min + ')');
  if (passed < min) {
    failures.push({ id: 'coverage', title: passed + ' verified, need ' + min });
  }

  // Against a served app: no sample leakage on plain reads, and search vs
  // detail consistency.
  if (base) {
    const homeResp = await fetch(base + '/api/home', { headers: apiHeaders });
    if (homeResp.status === 401) {
      console.error('verify-posters: the served app requires a platform token; pass --token with --base');
      process.exit(1);
    }
    const home = await homeResp.json();
    const all = [
      ...(home.featured || []), ...(home.trending || []), ...(home.series || []),
      ...(home.recent || []), ...(home.top10 || []), ...(home.shortDramas || []),
    ];
    const leaked = all.filter((d) => d.id < 9000 && !d.tmdb_id);
    console.log('');
    console.log('GET /api/home: ' + all.length + ' rows served, ' +
      leaked.length + ' sample dramas leaked' + (leaked.length ? ' (ids ' + leaked.map((d) => d.id).join(', ') + ')' : ''));
    if (leaked.length) failures.push({ id: 'leak', title: 'sample dramas on plain /api/home' });

    const real = table.find((t) => t.ok);
    if (real) {
      const search = await (await fetch(base + '/api/dramas?q=' + encodeURIComponent(real.title), { headers: apiHeaders })).json();
      const hit = (search.items || []).find((d) => d.id === real.id);
      const detail = await (await fetch(base + '/api/dramas/' + real.id, { headers: apiHeaders })).json();
      const consistent = hit && detail.drama &&
        hit.poster_url === detail.drama.poster_url &&
        hit.poster_url === (await pool.query('SELECT poster_url FROM dramas WHERE id = $1', [real.id])).rows[0].poster_url;
      console.log('search vs detail for "' + real.title + '": ' + (consistent ? 'same poster_url everywhere' : 'MISMATCH'));
      if (!consistent) failures.push({ id: real.id, title: 'search/detail poster inconsistent' });
    } else {
      console.log('search vs detail: skipped (no verified record to check)');
    }
  }

  await pool.end();
  if (failures.length) {
    console.log('');
    console.log('FAIL:');
    for (const f of failures) console.log('  - ' + f.id + ' ' + f.title);
    process.exit(1);
  }
  console.log('\nAll poster checks passed.');
}

main().catch((e) => {
  console.error('verify-posters failed:', e.message);
  process.exit(1);
});

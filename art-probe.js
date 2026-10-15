// Artwork link probe, shared by the server's artwork check/scan routes and
// scripts/verify-posters.js. Probes ONE stored artwork URL: absolute URLs
// (the provider CDN) are HEADed; a same-origin relative path is always one
// of the app's own committed files, so it is checked against public/ on
// disk — fetch cannot open a relative URL, and a self-request would need a
// base URL the server does not reliably know. Returns 'ok' | 'broken' |
// 'missing'.
const fs = require('fs');
const path = require('path');

const PROBE_TIMEOUT_MS = 10_000;

async function probeArtwork(url) {
  if (!url) return 'missing';
  if (url.startsWith('/')) {
    try {
      await fs.promises.access(path.join(__dirname, 'public', url.replace(/^\/+/, '')));
      return 'ok';
    } catch (e) {
      return 'broken';
    }
  }
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return r.ok ? 'ok' : 'broken';
  } catch (e) {
    return 'broken';
  }
}

module.exports = { probeArtwork };

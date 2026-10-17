// Artwork resolution is RECORD-driven: a drama's poster and backdrop come
// from its own database record (poster_url / backdrop_url) — filled at seed
// time for the sample catalog and by the curator's verified TMDB import for
// imported dramas. There is no hand-maintained drama→photo map in the
// client: one drama, one artwork, and the mapping for the samples is
// curated server-side in data/catalog.js (SAMPLE_ART), next to the titles
// it is matched against. A record without artwork renders the neutral
// placeholder; a FAILED image falls back to the record's own generated
// titled art (samples) or the placeholder (imports) — never to an
// unrelated photo. No real show, person or logo is depicted in the
// committed art.
//
// The sample records point at committed same-origin files under /img/ by
// the seed's URL convention (below). Sizes: poster thumbs 300×450 and
// detail posters 600×900 (2:3 crops), backdrops 1200×675 and episode stills
// 320×180 (16:9 crops), and tiny ~350-byte blurred WebP stand-ins
// (/img/lqip/) painted as the image's own background while it loads.
// Committed art and the placeholders are same-origin files; TMDB record
// URLs are public CDN links and carry no key.

// The committed photo id behind a sample record's artwork, parsed from the
// record's own URL. The seed's documented same-origin convention is
// poster_url = /img/poster/<photoId>-<width>.webp and
// backdrop_url = /img/backdrop/<photoId>.webp. Null for an imported TMDB
// record (its URLs are public CDN links) or a record without artwork —
// those have no committed art, and the episode-still row renders its quiet
// raised tile with the episode number, as it always did.
const POSTER_URL_RE = /^\/img\/poster\/(\d+)-\d+\.webp$/;
const BACKDROP_URL_RE = /^\/img\/backdrop\/(\d+)\.webp$/;

function samplePhotoId(d) {
  if (!d) return null;
  let m = POSTER_URL_RE.exec(d.poster_url || '');
  if (m) return +m[1];
  m = BACKDROP_URL_RE.exec(d.backdrop_url || '');
  return m ? +m[1] : null;
}

const STILL_POOL = {
  romance: [344, 141, 177],
  thriller: [552, 551, 536, 30],
  fantasy: [509, 615, 294],
  historical: [619, 134, 375],
  comedy: [639, 635, 549],
  action: [520, 563, 585],
};

// The fallback gradient art hues (the same values the server's SVG
// generators use, /poster/:id.svg).
const GENRE_HUES = {
  romance: 335, thriller: 255, fantasy: 200,
  comedy: 28, historical: 165, action: 280,
};

// Neutral placeholders for records without verified artwork: a quiet grey
// film-frame glyph, no title, no photo — the same one everywhere, and it is
// never a stand-in that could belong to another show.
const PLACEHOLDER_POSTER = '/img/placeholder-poster.svg';
const PLACEHOLDER_BACKDROP = '/img/placeholder-backdrop.svg';

// Poster URL for a drama record at a given width (300 for cards and rows,
// 600 for the detail page). The record carries one URL per artwork (the
// 600-wide crop, the detail-page size) and it is used at every width, like
// the imported and demo records. Null when the record carries no artwork —
// callers render the placeholder.
export function posterArt(d, width) {
  return (d && d.poster_url) || null;
}

export function backdropArt(d) {
  return (d && d.backdrop_url) || null;
}

// Banner art: a wide backdrop when the record carries one, otherwise the
// record's own poster — cover-cropped into the banner's 16:9 frame — so a
// verified record with only a poster still fills the hero with its own art.
// Callers keep the generated-art / placeholder fallback for a FAILED image.
export function bannerArt(d) {
  return backdropArt(d) || posterArt(d, 600);
}

// First fallback for a FAILED image: a sample record (committed art by the
// URL convention above) falls to the generated gradient art (titled
// correctly), every other record falls to the neutral placeholder — never
// to an unrelated photo.
export function posterFallback(d) {
  return samplePhotoId(d) ? '/poster/' + d.id + '.svg' : PLACEHOLDER_POSTER;
}

export function backdropFallback(d) {
  return samplePhotoId(d) ? '/banner/' + d.id + '.svg' : PLACEHOLDER_BACKDROP;
}

// Episode still: the sample drama's own photo and its genre's pool cycle by
// episode number, so a season's rows do not all show the same frame.
// Imported dramas have no committed stills yet: null (the row renders its
// quiet raised tile with the episode number).
export function stillArt(d, ep, genre) {
  const p = samplePhotoId(d);
  if (!p) return null;
  const pool = [p].concat(STILL_POOL[genre] || []);
  const n = pool[((ep || 1) - 1) % pool.length];
  return '/img/still/' + n + '.webp';
}

// Tiny blurred stand-in painted behind committed art while it loads.
export function lqipArt(d, shape) {
  const p = samplePhotoId(d);
  return p ? '/img/lqip/' + p + '-' + shape + '.webp' : null;
}

// A poster <img> for a card or row: the record's art, the blurred stand-in
// as its background while it loads, and the neutral placeholder as the
// fallback when it fails. Callers wrap it in an aspect-ratio box (.poster
// or a fixed-size span) so the page never shifts while it loads.
export function artImg(d, opts) {
  const o = opts || {};
  const alt = (o.alt || '').replace(/"/g, '&quot;');
  const src = posterArt(d, o.width || 300);
  if (!src) {
    return '<img data-art class="' + (o.cls || '') + '" src="' + PLACEHOLDER_POSTER +
      '" alt="' + alt + '" loading="lazy" decoding="async">';
  }
  const lqip = lqipArt(d, 'p');
  return '<img data-art data-fallback="' + posterFallback(d) + '"' +
    ' class="' + (o.cls || '') + '"' +
    (lqip && o.lqip !== false
      ? ' style="background-image:url(' + lqip + ');background-size:cover;background-position:center"'
      : '') +
    ' loading="lazy" decoding="async" src="' + src + '" alt="' + alt + '">';
}

// Every art <img> falls back gracefully: first to its data-fallback (the
// generated gradient art for committed art, the neutral placeholder for
// record-driven art), then, if that fails too, to a quiet hidden image
// over its box's raised background. One delegated listener handles every
// image on every screen, including memoized cards that arrive as clones
// (clones keep attributes, not listeners).
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-art')) return;
  const fb = img.getAttribute('data-fallback');
  if (fb) {
    img.removeAttribute('data-fallback');
    img.style.backgroundImage = '';
    img.src = fb;
  } else {
    img.removeAttribute('data-art');
    img.style.visibility = 'hidden';
  }
}, true);
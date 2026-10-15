// Artwork resolution is RECORD-driven: a drama's poster and backdrop come
// from its own database record (poster_url / backdrop_url, filled by the
// curator's verified TMDB import) first, then the catalog's committed
// original artwork (the sample dramas), then the neutral placeholder for
// records without verified artwork. Artwork is never derived from a
// hand-maintained photo map for imported dramas — one drama, one artwork.
//
// The committed sample artwork (one free-license photograph per sample
// drama, picsum.photos / Unsplash license, compressed to WebP under /img/)
// still serves the 30 original sample dramas. No real show, person or logo
// is depicted in any of them.
//
// Photo ids and their authors, for the record:
//   30 Shyamanta Baruah, 82 Rula Sibai, 100 Tina Rataj, 104 Dyaa Eldin,
//   133 Dietmar Becker, 141 Greg Shield, 163 Linh Nguyen, 177 Danka &
//   Peter, 211 Martin Wessely, 218 Monika Majkowska, 223 Maria Carrasco,
//   232 Hide Obara, 249 Anders Jildn, 288 Stockholm, 294 Robin Benad,
//   344 Alex Gindin, 375 Wellington Sanipe, 376 Andrew Ruiz,
//   380 Michael Quinn, 405 Daniel Robert, 406 Roland Batke-Mutschler,
//   419 POR7O, 449 Maciej Serafinowicz, 488 Monstruo Estudio,
//   502 Sven Schlager, 509 Jeff Sheldon, 520 Dorothee Hübner,
//   524 Charles Forerunner, 536 David Di Veroli, 537 Juskteez Vu,
//   538 Julia Revitt, 545 Ryan Lum, 549 Artur Pokusin, 551 Forrest
//   Cavale, 552 Hugo Kerr, 563 Bec Brown, 564 Sebastian Boguszewicz,
//   568 Dakota Roos, 575 Alberto Restifo, 585 Abigail & Keenan,
//   594 Aurélien Bellanger, 612 Justin Leibow, 615 Josefa Holland-Merten,
//   616 Sylwia Bartyzel, 619 Davey Heuser, 635 André Freitas, 639 Ilya.
//
// Sizes: poster thumbs 300×450 and detail posters 600×900 (2:3 crops),
// backdrops 1200×675 and episode stills 320×180 (16:9 crops), and tiny
// ~350-byte blurred WebP stand-ins (/img/lqip/) painted as the image's
// own background while it loads. Committed art and the placeholders are
// same-origin files; TMDB record URLs are public CDN links.

// Drama id -> photo id, for the committed sample artwork only.
const PHOTO = {
  1: 223, 2: 594, 3: 218, 4: 502, 5: 232, 6: 380, 7: 612, 8: 574, 9: 163,
  10: 564, 11: 405, 12: 449, 13: 538, 14: 249, 15: 568, 16: 376, 17: 211,
  18: 82, 19: 133, 20: 616, 21: 288, 22: 537, 23: 104, 24: 406, 25: 545,
  26: 419, 27: 524, 28: 100, 29: 575, 30: 488,
};

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

function photoOf(id) {
  return PHOTO[id] || null;
}

// Poster URL for a drama record at a given width (300 for cards and rows,
// 600 for the detail page). Null when the record carries no artwork and no
// committed photo (unverified records) — callers render the placeholder.
export function posterArt(d, width) {
  if (d && d.poster_url) return d.poster_url;
  const p = d ? photoOf(d.id) : null;
  return p ? '/img/poster/' + p + '-' + (width || 300) + '.webp' : null;
}

export function backdropArt(d) {
  if (d && d.backdrop_url) return d.backdrop_url;
  const p = d ? photoOf(d.id) : null;
  return p ? '/img/backdrop/' + p + '.webp' : null;
}

// First fallback for a FAILED image: committed art falls to the generated
// gradient art (titled correctly), record-driven art falls to the neutral
// placeholder — never to an unrelated photo.
export function posterFallback(d) {
  return photoOf(d && d.id) ? '/poster/' + d.id + '.svg' : PLACEHOLDER_POSTER;
}

export function backdropFallback(d) {
  return photoOf(d && d.id) ? '/banner/' + d.id + '.svg' : PLACEHOLDER_BACKDROP;
}

// Episode still: the sample drama's own photo and its genre's pool cycle by
// episode number, so a season's rows do not all show the same frame.
// Imported dramas have no committed stills yet: null (the row renders its
// quiet raised tile with the episode number).
export function stillArt(d, ep, genre) {
  const p = d ? photoOf(d.id) : null;
  if (!p) return null;
  const pool = [p].concat(STILL_POOL[genre] || []);
  const n = pool[((ep || 1) - 1) % pool.length];
  return '/img/still/' + n + '.webp';
}

// Tiny blurred stand-in painted behind committed art while it loads.
export function lqipArt(d, shape) {
  const p = d ? photoOf(d.id) : null;
  return p ? '/img/lqip/' + p + '-' + shape + '.webp' : null;
}

// A poster <img> for a card or row: the record's art (or the committed
// sample art at 300 wide), the blurred stand-in as its background while it
// loads, and the neutral placeholder as the fallback when it fails.
// Callers wrap it in an aspect-ratio box (.poster or a fixed-size span) so
// the page never shifts while it loads.
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

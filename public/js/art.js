// Artwork resolution is RECORD-driven: a drama's poster and backdrop come
// from its own database record (poster_url / backdrop_url, filled by the
// curator's verified TMDB import). A record without artwork shows its own
// generated art first, then the neutral placeholder. Artwork is never
// derived from a hand-maintained photo map — one drama, one artwork.

// Wordless placeholders — the LAST resort only (a generated art URL that
// failed too) and the studio's thumbs, where a curator must still tell "no
// artwork" from "generated art". Viewer screens fall back to the drama's
// own generated title art first, never straight to a blank frame.
const PLACEHOLDER_POSTER = '/img/placeholder-poster.svg';
const PLACEHOLDER_BACKDROP = '/img/placeholder-backdrop.svg';

// Poster URL for a drama record at a given width (300 for cards and rows,
// 600 for the detail page). Null when the record carries no artwork —
// callers render the generated art, then the placeholder.
export function posterArt(d, width) {
  return d && d.poster_url ? d.poster_url : null;
}

export function backdropArt(d) {
  return d && d.backdrop_url ? d.backdrop_url : null;
}

// Banner art: a wide backdrop when the record carries one, otherwise the
// record's own poster — cover-cropped into the banner's 16:9 frame — so a
// verified record with only a poster still fills the hero with its own art.
// Callers keep the generated-art / placeholder fallback for a FAILED image.
export function bannerArt(d) {
  return backdropArt(d) || posterArt(d, 600);
}

// First fallback for a FAILED image, and the art for a record with no
// verified artwork at all: the app's own generated art (/poster/:id.svg,
// /banner/:id.svg), built from the drama's own record — its title, year
// and country on a genre-hued gradient. It is never an unrelated image:
// the same drama reads the same titled art everywhere until real artwork
// is imported. The wordless neutral placeholder is only the LAST resort
// (a generated URL that failed too) and the studio's thumbs, where a
// curator must still be able to tell "no artwork" from "generated art".
export function posterFallback(d) {
  return d && d.id ? '/poster/' + d.id + '.svg' : PLACEHOLDER_POSTER;
}

export function backdropFallback(d) {
  return d && d.id ? '/banner/' + d.id + '.svg' : PLACEHOLDER_BACKDROP;
}

// Episode stills: imported dramas carry none yet, so the row renders its
// quiet raised tile with the episode number.
export function stillArt(_d, _ep, _genre) {
  return null;
}

// No blurred stand-ins any more: records carry no committed photos.
export function lqipArt(_d, _shape) {
  return null;
}

// A poster <img> for a card or row: the record's art when it has one, and
// the neutral placeholder as the fallback when it fails. Callers wrap it in
// an aspect-ratio box (.poster or a fixed-size span) so the page never
// shifts while it loads.
export function artImg(d, opts) {
  const o = opts || {};
  const alt = (o.alt || '').replace(/"/g, '&quot;');
  const src = posterArt(d, o.width || 300);
  if (!src) {
    // No verified artwork: the drama's own generated title art (see
    // posterFallback). The wordless placeholder only when even the record's
    // id is unknown.
    const gen = posterFallback(d);
    return '<img data-art class="' + (o.cls || '') + '" src="' + gen +
      '" alt="' + alt + '" loading="lazy" decoding="async">';
  }
  return '<img data-art data-fallback="' + posterFallback(d) + '"' +
    ' class="' + (o.cls || '') + '"' +
    ' loading="lazy" decoding="async" src="' + src + '" alt="' + alt + '">';
}

// Every art <img> falls back gracefully: first to its data-fallback (the
// generated gradient art for record art), then, if that fails too, to a
// quiet hidden image over its box's raised background. One delegated
// listener handles every image on every screen, including memoized cards
// that arrive as clones (clones keep attributes, not listeners).
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
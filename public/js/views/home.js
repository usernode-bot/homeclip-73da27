// Home: search, the auto-sliding featured banner, genre chips and the
// horizontal rows (Continue Watching, Trending Now, New Episodes, Top 10).

import { api } from '../api.js';
import { el, dramaCard, hRow, skeletonHome, errorState, emptyState, icon, metaLine } from '../ui.js';
import { artImg, bannerArt, backdropArt, backdropFallback, posterFallback, lqipArt } from '../art.js';
import { t, genreLabel, GENRES } from '../i18n.js';
import { navigate } from '../router.js';

let bannerTimer = null;
let visibilityHandler = null;
let searchDebounce = null;

export function unmount() {
  stopBanner();
  if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
}

function stopBanner() {
  if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; }
  if (visibilityHandler) {
    document.removeEventListener('usernode:visibility-changed', visibilityHandler);
    visibilityHandler = null;
  }
}

function buildBanner(featured, container, demoParam) {
  if (!featured.length) return;
  // A labelled region with two controls: the artwork link opens the drama's
  // detail page, the round Play button opens the player at episode 1. They
  // must not be nested inside each other, so the banner itself is neither.
  const banner = el(
    '<div class="hc-banner mb-6" role="group" aria-label="' + featured[0].title.replace(/"/g, '&quot;') + '">' +
      '<a class="absolute inset-0" data-nav href="/drama/' + featured[0].id + demoParam + '" aria-label="' + featured[0].title.replace(/"/g, '&quot;') + '">' +
        '<div class="absolute inset-0">' +
          featured.map((d, i) => {
            // Record art first: the backdrop when the record carries one,
            // otherwise its own poster (cover-cropped into the 16:9 frame).
            // The fallback for a FAILED image follows the same record chain.
            const src = bannerArt(d) || backdropFallback(d);
            const fb = bannerArt(d)
              ? (backdropArt(d) ? backdropFallback(d) : posterFallback(d))
              : '';
            const lqip = lqipArt(d, 'b');
            return '<img src="' + src + '" alt="" loading="lazy" decoding="async" data-art' +
              (fb ? ' data-fallback="' + fb + '"' : '') +
              (lqip ? ' style="background-image:url(' + lqip + ');background-size:cover;background-position:center"' : '') +
              ' class="absolute inset-0 h-full w-full object-cover ' +
              (i === 0 ? 'opacity-100' : 'opacity-0') + ' motion-safe:transition-opacity motion-safe:duration-500" data-slide="' + i + '">';
          }).join('') +
        '</div>' +
      '</a>' +
      '<div class="hc-banner-text">' +
        '<p class="text-small text-muted" data-b-meta>' + metaLine(featured[0]) + '</p>' +
        '<p class="text-heading" data-b-title>' + featured[0].title + '</p>' +
      '</div>' +
      '<div class="absolute right-3 top-3 flex gap-1" data-b-dots>' +
        featured.map((_d, i) =>
          '<span class="hc-banner-dot ' + (i === 0 ? 'is-active' : '') + '"></span>').join('') +
      '</div>' +
      '<button type="button" class="hc-playfab absolute bottom-3 right-3 z-10" aria-label="' + t('home.play') + '" data-b-play>' +
        icon('play', 'h-5 w-5') +
      '</button>' +
    '</div>'
  );
  const imgs = banner.querySelectorAll('img[data-slide]');
  const dots = banner.querySelectorAll('.hc-banner-dot');
  const title = banner.querySelector('[data-b-title]');
  const meta = banner.querySelector('[data-b-meta]');
  const link = banner.querySelector('a[data-nav]');
  const play = banner.querySelector('[data-b-play]');
  let i = 0;
  const show = (n) => {
    i = (n + featured.length) % featured.length;
    imgs.forEach((img, k) => {
      img.classList.toggle('opacity-100', k === i);
      img.classList.toggle('opacity-0', k !== i);
    });
    dots.forEach((dot, k) => dot.classList.toggle('is-active', k === i));
    title.textContent = featured[i].title;
    meta.textContent = metaLine(featured[i]);
    const href = '/drama/' + featured[i].id + demoParam;
    link.setAttribute('href', href);
    link.setAttribute('aria-label', featured[i].title.replace(/"/g, '&quot;'));
    banner.setAttribute('aria-label', featured[i].title.replace(/"/g, '&quot;'));
    play.setAttribute('aria-label', t('home.play') + ' ' + featured[i].title);
  };
  play.addEventListener('click', () => navigate('/watch/' + featured[i].id + '/1'));
  let paused = false;
  bannerTimer = setInterval(() => {
    if (paused || document.hidden) return;
    show(i + 1);
  }, 5000);
  // Stop sliding while the shell keeps this app hidden in the background.
  visibilityHandler = (e) => {
    paused = !!(e.detail && e.detail.hidden);
    if (!paused) show(i + 1);
  };
  document.addEventListener('usernode:visibility-changed', visibilityHandler);
  container.appendChild(banner);
}

function buildSearch(container, demoParam) {
  const wrap = el(
    '<div class="hc-search relative mb-6">' +
      '<input class="field pr-4" type="search" name="q" autocomplete="off" ' +
        'placeholder="' + t('home.search') + '" aria-label="' + t('home.search') + '">' +
      '<div class="absolute inset-x-0 top-12 z-30 hidden overflow-hidden rounded-xl border border-line bg-surface" data-results role="listbox"></div>' +
    '</div>'
  );
  const input = wrap.querySelector('input');
  const results = wrap.querySelector('[data-results]');
  const hide = () => { results.classList.add('hidden'); results.innerHTML = ''; };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (searchDebounce) clearTimeout(searchDebounce);
    if (q.length < 2) { hide(); return; }
    searchDebounce = setTimeout(async () => {
      try {
        const r = await api('/api/dramas?q=' + encodeURIComponent(q) + '&limit=6' + demoParam);
        if (input.value.trim() !== q) return;
        results.innerHTML = '';
        if (!r.items.length) {
          results.appendChild(el('<p class="px-4 py-3 text-small text-muted">' + t('search.empty') + '</p>'));
        } else {
          for (const d of r.items) {
            const item = el(
              '<button type="button" class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised" role="option">' +
                '<span class="block h-14 w-10 shrink-0 overflow-hidden rounded-md bg-raised" style="aspect-ratio:2/3">' +
                  artImg(d, { cls: 'h-full w-full object-cover', lqip: false }) + '</span>' +
                '<span class="min-w-0"><span class="block truncate text-small font-medium text-fg">' + d.title + '</span>' +
                '<span class="block truncate text-small text-muted">' + metaLine(d) + '</span></span>' +
              '</button>'
            );
            item.addEventListener('click', () => { hide(); input.value = ''; navigate('/drama/' + d.id + demoParam); });
            results.appendChild(item);
          }
        }
        results.classList.remove('hidden');
      } catch (e) {
        hide();
      }
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      hide();
      navigate('/search?q=' + encodeURIComponent(input.value.trim()));
    }
  });
  input.addEventListener('blur', () => setTimeout(hide, 180));
  container.appendChild(wrap);
}

function buildChips(container) {
  const section = el('<section class="mb-5"><h2 class="section-label">' + t('home.browseGenres') + '</h2>' +
    '<div class="hc-row"></div></section>');
  const row = section.querySelector('.hc-row');
  for (const g of GENRES) {
    const chip = el('<a class="chip" data-nav href="/discover?genre=' + g + '">' + genreLabel(g) + '</a>');
    row.appendChild(chip);
  }
  container.appendChild(section);
}

export async function render({ view, query }) {
  view.innerHTML = '';
  view.appendChild(skeletonHome());
  const demo = query.get('demo') === '1';
  const demoParam = demo ? '?demo=1' : '';
  let data;
  try {
    data = await api('/api/home' + demoParam);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorState(() => render({ view, query })));
    return;
  }

  view.innerHTML = '';
  if (demo) {
    view.appendChild(el(
      '<p class="mb-3 rounded-lg border border-line bg-raised px-3 py-2 text-center text-small text-muted" data-usernode-demo-note>' +
        t('demo.note') + '</p>'
    ));
  }
  buildSearch(view, demoParam);
  buildBanner(data.featured, view, demoParam);
  buildChips(view);

  // On the demo page every link keeps ?demo=1 so a demo drama's detail
  // and player routes (which hide is_demo rows without it) keep working.
  const hrefD = (d) => '/drama/' + d.id + demoParam;
  const playD = (d, ep) => '/watch/' + d.id + '/' + (ep || 1) + demoParam;
  const continueRow = (data.continue || []).filter(Boolean);
  if (continueRow.length) {
    view.appendChild(hRow(t('home.continue'),
      continueRow.map((d) => dramaCard(d, {
        progress: { ep: d.ep, seconds: d.seconds, duration: d.duration },
        href: '/watch/' + d.id + '/' + d.ep + demoParam,
        playHref: playD(d, d.ep),
      }))
    ));
  }
  // A demo page's cards keep ?demo=1 on both of their links.
  const cardD = (d, extra) => dramaCard(d, Object.assign({ href: hrefD(d), playHref: playD(d) }, extra || {}));

  // Watchlist: what the viewer saved, only when they saved something —
  // guests and fresh viewers see no row at all.
  const watchRow = (data.watchlist || []).filter(Boolean);
  if (watchRow.length) {
    view.appendChild(hRow(t('home.watchlist'), watchRow.map((d) => cardD(d))));
  }
  const trendingRow = (data.trending || []).filter(Boolean);
  if (trendingRow.length) {
    view.appendChild(hRow(t('home.trending'), trendingRow.map((d) => cardD(d))));
  }
  // Recommended for You: dramas sharing a genre with what the viewer has
  // watched or saved; the server falls back to top-rated without that
  // history, so the row fills whenever the catalog has dramas.
  const recRow = (data.recommended || []).filter(Boolean);
  if (recRow.length) {
    view.appendChild(hRow(t('home.recommended'), recRow.map((d) => cardD(d))));
  }
  // Popular Series: the catalog's series, most popular first — the shorts'
  // counterpart row. Hidden when the catalog has none, like the shorts row.
  const seriesRow = (data.series || []).filter(Boolean);
  if (seriesRow.length) {
    view.appendChild(hRow(t('home.series'), seriesRow.map((d) => cardD(d))));
  }
  // Short dramas: a row of their own, only when the catalog has any —
  // never an empty row.
  const shortRow = (data.shortDramas || []).filter(Boolean);
  if (shortRow.length) {
    view.appendChild(hRow(t('home.short'), shortRow.map((d) => cardD(d))));
  }
  // Recently Added: the newest catalog entries first, so a drama a curator
  // just imported leads the row.
  const recentRow = (data.recent || []).filter(Boolean);
  if (recentRow.length) {
    view.appendChild(hRow(t('home.recent'), recentRow.map((d) => cardD(d))));
  }
  const topRow = (data.top10 || []).filter(Boolean);
  if (topRow.length) {
    view.appendChild(hRow(t('home.top10'), topRow.map((d, i) => cardD(d, { rank: i + 1 }))));
  }
  // One row per genre the catalog actually has; the server leaves genres
  // with no dramas out, so nothing renders empty.
  for (const gr of (data.genreRows || [])) {
    if (!gr.items || !gr.items.length) continue;
    view.appendChild(hRow(genreLabel(gr.genre), gr.items.map((d) => cardD(d))));
  }

  // Nothing in the catalog yet (and nothing to continue): the search and
  // the genre chips above stay, the rows are gone, and one quiet empty
  // state says where the content would be.
  if (!data.featured.length && !continueRow.length && !trendingRow.length) {
    view.appendChild(emptyState(t('home.empty'), t('home.emptyBody')));
  }
}

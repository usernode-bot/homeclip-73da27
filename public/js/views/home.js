// Home: search, the auto-sliding featured banner, genre chips and the
// horizontal rows (Continue Watching, Trending Now, New Episodes, Top 10).

import { api } from '../api.js';
import { el, dramaCard, hRow, skeletonHome, errorState } from '../ui.js';
import { artImg, backdropArt, backdropFallback, lqipArt } from '../art.js';
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
  const banner = el(
    '<a class="hc-banner mb-6 block" data-nav href="/drama/' + featured[0].id + demoParam + '" aria-label="' + featured[0].title.replace(/"/g, '&quot;') + '">' +
      '<div class="absolute inset-0">' +
        featured.map((d, i) => {
          const src = backdropArt(d) || backdropFallback(d);
          const fb = backdropArt(d) ? backdropFallback(d) : '';
          const lqip = lqipArt(d, 'b');
          return '<img src="' + src + '" alt="" loading="lazy" decoding="async" data-art' +
            (fb ? ' data-fallback="' + fb + '"' : '') +
            (lqip ? ' style="background-image:url(' + lqip + ');background-size:cover;background-position:center"' : '') +
            ' class="absolute inset-0 h-full w-full object-cover ' +
            (i === 0 ? 'opacity-100' : 'opacity-0') + ' motion-safe:transition-opacity motion-safe:duration-500" data-slide="' + i + '">';
        }).join('') +
      '</div>' +
      '<div class="hc-banner-text">' +
        '<p class="text-small text-muted" data-b-meta>' + featured[0].year + ' · ' + featured[0].genres.map(genreLabel).join(', ') + '</p>' +
        '<p class="text-heading" data-b-title>' + featured[0].title + '</p>' +
      '</div>' +
      '<div class="absolute right-3 top-3 flex gap-1" data-b-dots>' +
        featured.map((_d, i) =>
          '<span class="hc-banner-dot ' + (i === 0 ? 'is-active' : '') + '"></span>').join('') +
      '</div>' +
    '</a>'
  );
  const imgs = banner.querySelectorAll('img[data-slide]');
  const dots = banner.querySelectorAll('.hc-banner-dot');
  const title = banner.querySelector('[data-b-title]');
  const meta = banner.querySelector('[data-b-meta]');
  let i = 0;
  const show = (n) => {
    i = (n + featured.length) % featured.length;
    imgs.forEach((img, k) => {
      img.classList.toggle('opacity-100', k === i);
      img.classList.toggle('opacity-0', k !== i);
    });
    dots.forEach((dot, k) => dot.classList.toggle('is-active', k === i));
    title.textContent = featured[i].title;
    meta.textContent = featured[i].year + ' · ' + featured[i].genres.map(genreLabel).join(', ');
    banner.setAttribute('href', '/drama/' + featured[i].id + demoParam);
  };
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
                '<span class="block truncate text-small text-muted">' + d.year + ' · ' + d.genres.map(genreLabel).join(', ') + '</span></span>' +
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
  const continueRow = (data.continue || []).filter(Boolean);
  if (continueRow.length) {
    view.appendChild(hRow(t('home.continue'),
      continueRow.map((d) => dramaCard(d, {
        progress: { ep: d.ep, seconds: d.seconds, duration: d.duration },
        href: '/watch/' + d.id + '/' + d.ep + demoParam,
      }))
    ));
  }
  view.appendChild(hRow(t('home.trending'), data.trending.map((d) => dramaCard(d, { href: hrefD(d) }))));
  view.appendChild(hRow(t('home.new'), data.newEpisodes.map((d) => dramaCard(d, { href: hrefD(d) }))));
  // Short dramas: a row of their own, only when the catalog has any —
  // never an empty row.
  const shortRow = (data.shortDramas || []).filter(Boolean);
  if (shortRow.length) {
    view.appendChild(hRow(t('home.short'), shortRow.map((d) => dramaCard(d, { href: hrefD(d) }))));
  }
  view.appendChild(hRow(t('home.top10'), data.top10.map((d, i) => dramaCard(d, { rank: i + 1, href: hrefD(d) }))));
}

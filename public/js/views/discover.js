// Discover: filter by genre, country and year, sort by popularity or
// newest, with a paginated poster grid (Load more).

import { api } from '../api.js';
import { el, dramaCard, skeletonGrid, errorState, emptyState, toast } from '../ui.js';
import { t, genreLabel, countryLabel, countLabel, GENRES } from '../i18n.js';

let searchDebounce = null;

export function unmount() {
  if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
}

function stateFromQuery(query) {
  return {
    genre: query.get('genre') || '',
    country: query.get('country') || '',
    year: query.get('year') || '',
    sort: query.get('sort') === 'newest' ? 'newest' : 'popularity',
    q: query.get('q') || '',
  };
}

function qs(state) {
  const p = new URLSearchParams();
  if (state.genre) p.set('genre', state.genre);
  if (state.country) p.set('country', state.country);
  if (state.year) p.set('year', state.year);
  if (state.sort && state.sort !== 'popularity') p.set('sort', state.sort);
  if (state.q) p.set('q', state.q);
  const s = p.toString();
  return s ? '?' + s : '';
}

function buildQueryUrl(state, page) {
  const p = new URLSearchParams();
  if (state.genre) p.set('genre', state.genre);
  if (state.country) p.set('country', state.country);
  if (state.year) p.set('year', state.year);
  if (state.sort) p.set('sort', state.sort);
  if (state.q) p.set('q', state.q);
  p.set('page', String(page));
  return '/api/dramas?' + p.toString();
}

export async function render({ view, query }) {
  const state = stateFromQuery(query);
  view.innerHTML = '';
  view.appendChild(skeletonGrid(9));

  let facets;
  try {
    facets = await api('/api/facets');
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorState(() => render({ view, query })));
    return;
  }

  view.innerHTML = '';

  // Header + sort
  view.appendChild(el(
    '<div class="mb-4 flex items-center justify-between gap-3">' +
      '<h1 class="text-title">' + t('discover.title') + '</h1>' +
    '</div>'
  ));

  // Search: same field as Home's, feeding the query the grid already reads.
  // Debounced so typing narrows the grid without a request per keystroke.
  const searchWrap = el(
    '<div class="mb-4">' +
      '<input class="field" type="search" name="q" autocomplete="off" ' +
        'placeholder="' + t('home.search') + '" aria-label="' + t('home.search') + '">' +
    '</div>'
  );
  const searchInput = searchWrap.querySelector('input');
  searchInput.value = state.q;
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => setState({ q: searchInput.value.trim() }), 250);
  });
  view.appendChild(searchWrap);

  const sortSeg = el(
    '<div class="hc-segment mb-4" role="group" aria-label="' + t('discover.sort') + '">' +
      '<button type="button" data-sort="popularity" aria-pressed="' + (state.sort === 'popularity') + '">' + t('discover.sort.popularity') + '</button>' +
      '<button type="button" data-sort="newest" aria-pressed="' + (state.sort === 'newest') + '">' + t('discover.sort.newest') + '</button>' +
    '</div>'
  );
  view.appendChild(sortSeg);

  // Genre chips (All + six genres)
  const genreRow = el('<div class="hc-row mb-4" role="group" aria-label="' + t('discover.genre') + '"></div>');
  const allChip = el('<button type="button" class="chip' + (state.genre ? '' : ' is-active') + '" aria-pressed="' + (!state.genre) + '">' + t('discover.all') + '</button>');
  allChip.addEventListener('click', () => setState({ genre: '' }));
  genreRow.appendChild(allChip);
  for (const g of GENRES) {
    const chip = el('<button type="button" class="chip' + (state.genre === g ? ' is-active' : '') + '" aria-pressed="' + (state.genre === g) + '">' + genreLabel(g) + '</button>');
    chip.addEventListener('click', () => setState({ genre: g }));
    genreRow.appendChild(chip);
  }
  view.appendChild(genreRow);

  // Country + year selects
  const selects = el(
    '<div class="mb-4 grid grid-cols-2 gap-3">' +
      '<label class="block"><span class="section-label">' + t('discover.country') + '</span>' +
        '<select class="field" data-country><option value="">' + t('discover.all') + '</option>' +
        facets.countries.map((c) => '<option value="' + c + '"' + (state.country === c ? ' selected' : '') + '>' + countryLabel(c) + '</option>').join('') +
        '</select></label>' +
      '<label class="block"><span class="section-label">' + t('discover.year') + '</span>' +
        '<select class="field" data-year><option value="">' + t('discover.all') + '</option>' +
        facets.years.map((y) => '<option value="' + y + '"' + (String(state.year) === String(y) ? ' selected' : '') + '>' + y + '</option>').join('') +
        '</select></label>' +
    '</div>'
  );
  selects.querySelector('[data-country]').addEventListener('change', (e) => setState({ country: e.target.value }));
  selects.querySelector('[data-year]').addEventListener('change', (e) => setState({ year: e.target.value }));
  view.appendChild(selects);

  // Results
  const count = el('<p class="section-label" data-count></p>');
  view.appendChild(count);
  const grid = el('<div class="hc-grid grid grid-cols-3 gap-3 sm:grid-cols-4"></div>');
  view.appendChild(grid);

  let page = 1;
  let hasMore = false;
  let loadingMore = false;

  const moreWrap = el('<div class="mt-4 flex justify-center"></div>');
  const moreBtn = el('<button type="button" class="btn-secondary">' + t('discover.loadMore') + '</button>');
  moreBtn.addEventListener('click', loadMore);
  moreWrap.appendChild(moreBtn);
  moreWrap.hidden = true;
  view.appendChild(moreWrap);

  async function fetchPage(p) {
    const r = await api(buildQueryUrl(state, p));
    return r;
  }

  function renderPage(result, append) {
    if (!append) {
      grid.innerHTML = '';
      page = 1;
      if (result.total === 0) {
        const box = emptyState(t('discover.empty'), '');
        const clear = el('<button type="button" class="btn-secondary mt-2">' + t('discover.clear') + '</button>');
        clear.addEventListener('click', () => {
          searchInput.value = '';
          setState({ genre: '', country: '', year: '', q: '' });
        });
        box.appendChild(clear);
        grid.appendChild(box);
        count.textContent = '';
        moreWrap.hidden = true;
        hasMore = false;
        return;
      }
    }
    for (const d of result.items) {
      grid.appendChild(dramaCard(d, { grid: true }));
    }
    count.textContent = countLabel(result.total);
    hasMore = result.hasMore;
    moreWrap.hidden = !hasMore;
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    moreBtn.disabled = true;
    try {
      const r = await fetchPage(page + 1);
      page += 1;
      for (const d of r.items) grid.appendChild(dramaCard(d, { grid: true }));
      hasMore = r.hasMore;
      moreWrap.hidden = !hasMore;
    } catch (e) {
      toast(t('common.errorBody'));
    } finally {
      loadingMore = false;
      moreBtn.disabled = false;
    }
  }

  async function refresh() {
    try {
      const r = await fetchPage(1);
      renderPage(r, false);
    } catch (e) {
      grid.innerHTML = '';
      grid.appendChild(el('<div class="col-span-3 sm:col-span-4"></div>'));
      grid.firstElementChild.appendChild(errorState(refresh));
    }
  }

  function setState(patch) {
    Object.assign(state, patch);
    history.replaceState({}, '', '/discover' + qs(state));
    // Sync the chip pressed states without rebuilding the page.
    genreRow.querySelectorAll('.chip').forEach((chip, idx) => {
      const g = idx === 0 ? '' : GENRES[idx - 1];
      const active = state.genre === g;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    sortSeg.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
    moreWrap.hidden = true;
    refresh();
  }

  // First load
  sortSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => setState({ sort: b.dataset.sort }));
  });
  try {
    const r = await fetchPage(1);
    renderPage(r, false);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorState(() => render({ view, query })));
    return;
  }
}

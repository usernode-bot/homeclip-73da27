// Search results: a grid of matches for a query, paginated with Load more.
// Reached from the home search bar (Enter or a suggestion tap).

import { api } from '../api.js';
import { el, icon, dramaCard, skeletonGrid, errorState, emptyState, toast } from '../ui.js';
import { t, countLabel } from '../i18n.js';

export async function render({ view, query }) {
  const q = (query.get('q') || '').trim();
  view.innerHTML = '';

  // Back + the query echoed into a field the viewer can edit.
  view.appendChild(el(
    '<div class="mb-4 flex items-center gap-2">' +
      '<a class="hc-iconbtn" data-nav href="/" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</a>' +
      '<h1 class="min-w-0 truncate text-title">' + (q ? q : t('search.title')) + '</h1>' +
    '</div>'
  ));

  view.appendChild(skeletonGrid(9));

  let result;
  try {
    const p = new URLSearchParams({ q, page: '1' });
    result = await api('/api/dramas?' + p.toString());
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorState(() => render({ view, query })));
    return;
  }

  view.innerHTML = '';

  if (!result.total) {
    view.appendChild(el(
      '<div class="state-empty"><p class="text-heading">' + t('search.none') + '</p>' +
      '<p class="mt-1 text-small text-muted">' + t('search.noneBody') + '</p>' +
      '<a class="btn-primary mt-2" data-nav href="/discover">' + t('search.browse') + '</a></div>'
    ));
    return;
  }

  view.appendChild(el('<p class="section-label">' + countLabel(result.total) + '</p>'));

  const grid = el('<div class="hc-grid mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4"></div>');
  for (const d of result.items) grid.appendChild(dramaCard(d, { grid: true }));
  view.appendChild(grid);

  if (result.hasMore) {
    let page = 1;
    let loading = false;
    const moreBtn = el('<button type="button" class="btn-secondary mt-4">' + t('discover.loadMore') + '</button>');
    moreBtn.addEventListener('click', async () => {
      if (loading) return;
      loading = true;
      moreBtn.disabled = true;
      try {
        page += 1;
        const p = new URLSearchParams({ q, page: String(page) });
        const r = await api('/api/dramas?' + p.toString());
        for (const d of r.items) grid.appendChild(dramaCard(d, { grid: true }));
        if (!r.hasMore) moreBtn.remove();
      } catch (e) {
        toast(t('common.errorBody'));
      } finally {
        loading = false;
        moreBtn.disabled = false;
      }
    });
    view.appendChild(moreBtn);
  }
}

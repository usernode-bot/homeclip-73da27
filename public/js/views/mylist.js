// My List: the user's saved dramas and their watch history, with
// continue-from-last-minute and removal.

import { api } from '../api.js';
import { el, posterUrl, icon, toast, timeFmt, errorState } from '../ui.js';
import { t, genreLabel } from '../i18n.js';
import { navigate } from '../router.js';

let tab = 'list';

export function unmount() {
  tab = 'list';
}

function skeletonList() {
  return el(
    '<div>' +
      '<div class="hc-segment mb-4"><div class="skeleton h-8 w-28 rounded-md"></div><div class="skeleton h-8 w-28 rounded-md"></div></div>' +
      '<div class="list">' +
      Array.from({ length: 4 }, () =>
        '<div class="list-row"><div class="skeleton h-20 w-14 rounded-md"></div>' +
        '<div class="flex-1"><div class="skeleton h-4 w-40"></div><div class="skeleton mt-1 h-3 w-24"></div></div></div>').join('') +
      '</div>' +
    '</div>'
  );
}

function posterThumb(d) {
  return '<img class="h-20 w-14 shrink-0 rounded-md border border-line object-cover" loading="lazy" decoding="async" src="' + posterUrl(d.id) + '" alt="">';
}

export async function render({ view, query }) {
  view.innerHTML = '';
  view.appendChild(skeletonList());
  const demoParam = query.get('demo') === '1' ? '?demo=1' : '';

  let listData, historyData;
  try {
    [listData, historyData] = await Promise.all([
      api('/api/my-list' + demoParam),
      api('/api/history' + demoParam),
    ]);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorState(() => render({ view, query })));
    return;
  }

  view.innerHTML = '';

  if (demoParam) {
    view.appendChild(el(
      '<p class="mb-3 rounded-lg border border-line bg-raised px-3 py-2 text-center text-small text-muted" data-usernode-demo-note>' +
        t('demo.note') + '</p>'
    ));
  }

  // Tabs
  const seg = el(
    '<div class="hc-segment mb-4" role="group">' +
      '<button type="button" data-tab="list" aria-pressed="' + (tab === 'list') + '">' + t('mylist.tab.list') + '</button>' +
      '<button type="button" data-tab="history" aria-pressed="' + (tab === 'history') + '">' + t('mylist.tab.history') + '</button>' +
    '</div>'
  );
  seg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    });
  });
  view.appendChild(seg);

  const content = el('<div data-content></div>');
  view.appendChild(content);

  function listRow(d) {
    const row = el(
      '<li><div class="list-row">' +
        '<a class="flex min-w-0 flex-1 items-center gap-3" data-nav href="/drama/' + d.id + '">' +
          posterThumb(d) +
          '<span class="min-w-0"><span class="block truncate text-body font-medium text-fg">' + d.title + '</span>' +
          '<span class="block truncate text-small text-muted">' + d.year + ' · ' + d.genres.map(genreLabel).join(', ') + ' · ' + icon('star', 'h-3.5 w-3.5 inline align-text-bottom') + ' ' + d.rating.toFixed(1) + '</span></span>' +
        '</a>' +
        '<button type="button" class="hc-iconbtn text-muted" aria-label="' + t('mylist.remove') + '" data-remove>' + icon('trash') + '</button>' +
      '</div></li>'
    );
    row.querySelector('[data-remove]').addEventListener('click', async () => {
      try {
        await api('/api/my-list/' + d.id, { method: 'DELETE', action: 'remove dramas from your list' });
        row.remove();
        if (!content.querySelector('li')) draw();
      } catch (e) { /* surfaced by api.js */ }
    });
    return row;
  }

  function historyRow(d) {
    const row = el(
      '<li><div class="list-row">' +
        '<a class="flex min-w-0 flex-1 items-center gap-3" data-nav href="/watch/' + d.id + '/' + d.ep + '">' +
          posterThumb(d) +
          '<span class="min-w-0"><span class="block truncate text-body font-medium text-fg">' + d.title + '</span>' +
          '<span class="block truncate text-small text-muted">' + t('history.epShort', { n: d.ep }) + ' · ' + timeFmt(d.seconds) + '</span></span>' +
        '</a>' +
        '<a class="btn-secondary min-h-9 px-3 text-small" data-nav href="/watch/' + d.id + '/' + d.ep + '">' + t('history.continue') + '</a>' +
        '<button type="button" class="hc-iconbtn text-muted" aria-label="' + t('history.remove') + '" data-remove>' + icon('trash') + '</button>' +
      '</div></li>'
    );
    row.querySelector('[data-remove]').addEventListener('click', async () => {
      try {
        await api('/api/history/' + d.id, { method: 'DELETE', action: 'remove episodes from your history' });
        row.remove();
        if (!content.querySelector('li')) draw();
      } catch (e) { /* surfaced by api.js */ }
    });
    return row;
  }

  function draw() {
    content.innerHTML = '';
    if (tab === 'list') {
      const items = listData.items;
      if (!items.length) {
        content.appendChild(el(
          '<div class="state-empty"><p class="text-heading">' + t('mylist.empty') + '</p>' +
          '<a class="btn-primary mt-2" data-nav href="/discover">' + t('mylist.browse') + '</a></div>'
        ));
        return;
      }
      const ul = el('<ul class="list"></ul>');
      items.forEach((d) => ul.appendChild(listRow(d)));
      content.appendChild(ul);
    } else {
      const items = historyData.items;
      if (!items.length) {
        content.appendChild(el(
          '<div class="state-empty"><p class="text-heading">' + t('history.empty') + '</p>' +
          '<a class="btn-primary mt-2" data-nav href="/discover">' + t('mylist.browse') + '</a></div>'
        ));
        return;
      }
      const ul = el('<ul class="list"></ul>');
      items.forEach((d) => ul.appendChild(historyRow(d)));
      content.appendChild(ul);
    }
  }

  draw();
}

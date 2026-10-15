// Drama detail: poster, title, rating, year, country, genres, synopsis,
// cast, episode list, Play / Continue and Add to My List.

import { api } from '../api.js';
import { el, skeletonDetail, errorState, posterUrl, emptyState, icon, toast, timeFmt } from '../ui.js';
import { t, genreLabel, countryLabel, getLang } from '../i18n.js';
import { navigate } from '../router.js';

let synopsisOpen = false;

export function unmount() {
  synopsisOpen = false;
}

function goBack() {
  if (history.length > 1) history.back();
  else navigate('/');
}

export async function render({ view, params, query }) {
  const id = params[0];
  const wasOpen = synopsisOpen;
  synopsisOpen = false;
  // A demo page load forwards demo=1, matching the player: staging can show
  // the VIP episodes unlocked (server grants VIP in memory only).
  const demoParam = query && query.get('demo') === '1' ? '?demo=1' : '';
  view.innerHTML = '';
  view.appendChild(skeletonDetail());

  let data;
  try {
    data = await api('/api/dramas/' + id + demoParam);
  } catch (e) {
    view.innerHTML = '';
    if (e.status === 404) {
      view.appendChild(emptyState(t('detail.notFound'), ''));
    } else {
      view.appendChild(errorState(() => render({ view, params, query })));
    }
    return;
  }

  const { drama: d, episodes, inMyList, progress } = data;
  const lang = getLang();
  const synopsis = lang === 'id' ? d.synopsis_id : d.synopsis_en;
  let inList = inMyList;

  view.innerHTML = '';

  // Back
  const back = el('<button type="button" class="hc-iconbtn mb-1" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</button>');
  back.addEventListener('click', goBack);
  view.appendChild(back);

  const root = el('<div class="hc-detail"></div>');
  view.appendChild(root);

  // Header: poster + facts
  root.appendChild(el(
    '<div class="flex gap-4">' +
      '<span class="poster w-32 shrink-0"><img loading="lazy" decoding="async" src="' + posterUrl(d.id) + '" alt="' + d.title.replace(/"/g, '&quot;') + '"></span>' +
      '<div class="flex min-w-0 flex-1 flex-col justify-center gap-1">' +
        '<h1 class="text-heading">' + d.title + '</h1>' +
        '<p class="text-small text-muted">' + d.year + ' · ' + countryLabel(d.country) + '</p>' +
        '<p class="text-small text-muted">' + d.genres.map(genreLabel).join(', ') + '</p>' +
        '<p class="flex items-center gap-1 text-small font-medium text-fg">' +
          '<span class="text-accent">' + icon('star', 'h-4 w-4') + '</span>' + d.rating.toFixed(1) +
        '</p>' +
      '</div>' +
    '</div>'
  ));

  // Actions: Play / Continue (primary), Add to My List (secondary).
  const startEp = progress && progress.ep ? progress.ep : 1;
  const actions = el('<div class="mt-4 flex flex-wrap gap-2"></div>');
  const playBtn = el(
    '<a class="btn-primary flex-1" data-nav href="/watch/' + d.id + '/' + startEp + '">' +
      icon('play', 'h-5 w-5') + '<span>' +
      (progress && progress.ep ? t('detail.resume', { n: progress.ep }) : t('detail.play')) +
      '</span></a>'
  );
  const listBtn = el(
    '<button type="button" class="btn-secondary flex-1">' +
      '<span data-icon>' + icon(inList ? 'check' : 'plus', 'h-5 w-5') + '</span><span data-label>' +
      (inList ? t('detail.added') : t('detail.add')) + '</span></button>'
  );
  listBtn.addEventListener('click', async () => {
    const method = inList ? 'DELETE' : 'POST';
    try {
      await api('/api/my-list/' + d.id, { method, action: 'add dramas to your list' });
      inList = !inList;
      listBtn.querySelector('[data-icon]').innerHTML = icon(inList ? 'check' : 'plus', 'h-5 w-5');
      listBtn.querySelector('[data-label]').textContent = inList ? t('detail.added') : t('detail.add');
      toast(inList ? t('detail.added') : t('detail.add'));
    } catch (e) { /* account_required already surfaced; other failures are silent no-ops on the button */ }
  });
  actions.appendChild(playBtn);
  actions.appendChild(listBtn);
  root.appendChild(actions);

  // Synopsis with show more / less.
  const synWrap = el(
    '<section class="mt-5"><h2 class="section-label">' + t('detail.synopsis') + '</h2>' +
      '<p class="text-body text-fg' + ' ' + (wasOpen ? '' : 'line-clamp-3') + '" data-syn></p>' +
      '<button type="button" class="mt-1 px-1 text-small font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-syn-toggle></button>' +
    '</section>'
  );
  synWrap.querySelector('[data-syn]').textContent = synopsis;
  const synToggle = synWrap.querySelector('[data-syn-toggle]');
  const updateToggle = () => { synToggle.textContent = synopsisOpen ? t('detail.showLess') : t('detail.showMore'); };
  updateToggle();
  synToggle.addEventListener('click', () => {
    synopsisOpen = !synopsisOpen;
    synWrap.querySelector('[data-syn]').classList.toggle('line-clamp-3', !synopsisOpen);
    updateToggle();
  });
  root.appendChild(synWrap);

  // Cast
  root.appendChild(el(
    '<section class="mt-5"><h2 class="section-label">' + t('detail.cast') + '</h2>' +
      '<p class="px-1 text-body text-fg">' + d.cast_names.join(', ') + '</p>' +
    '</section>'
  ));

  // Episode list
  const epSection = el(
    '<section class="mt-5"><h2 class="section-label">' + t('detail.episodes') + ' (' + episodes.length + ')</h2>' +
      '<ul class="list" data-episodes></ul>' +
    '</section>'
  );
  const epList = epSection.querySelector('[data-episodes]');
  for (const epn of episodes) {
    // VIP episodes carry the tracker's chip-vip marker so a person sees
    // which ones need the plan before tapping in.
    const tail = epn.access === 'vip'
      ? '<span class="chip chip-vip">' + icon('lock', 'h-3.5 w-3.5') + 'VIP</span>'
      : '<span class="text-muted">' + icon('play', 'h-4 w-4') + '</span>';
    const row = el(
      '<li><a class="list-row" data-nav href="/watch/' + d.id + '/' + epn.num + '">' +
        '<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-small font-medium text-fg">' + epn.num + '</span>' +
        '<span class="min-w-0 flex-1">' +
          '<span class="block truncate text-body text-fg">' + t('detail.episode', { n: epn.num }) + '</span>' +
          '<span class="block text-small text-muted">' + epn.duration_min + ' ' + t('time.min') +
          (progress && progress.ep === epn.num ? ' · ' + timeFmt(progress.seconds) : '') +
          '</span>' +
        '</span>' +
        tail +
      '</a></li>'
    );
    epList.appendChild(row);
  }
  root.appendChild(epSection);
}

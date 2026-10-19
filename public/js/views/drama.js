// Drama detail: poster, title, rating, year, country, genres, synopsis,
// cast, episode list, Play / Continue and Add to My List.

import { api } from '../api.js';
import { el, skeletonDetail, errorState, emptyState, icon, toast, timeFmt, esc, hRow, dramaCard } from '../ui.js';
import { artImg, backdropArt, backdropFallback, lqipArt, stillArt } from '../art.js';
import { t, genreLabel, countryLabel, langLabel, getLang } from '../i18n.js';
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

  // Demo rows (staging seed) need the ?demo=1 param forwarded to the API,
  // and their watch links carry it too so playback reaches the same data.
  const demo = query.get('demo') === '1';
  const demoQ = demo ? '?demo=1' : '';

  let data;
  try {
    data = await api('/api/dramas/' + id + demoQ);
  } catch (e) {
    view.innerHTML = '';
    if (e.status === 404) {
      view.appendChild(emptyState(t('detail.notFound'), ''));
    } else {
      view.appendChild(errorState(() => render({ view, params, query })));
    }
    return;
  }

  const { drama: d, episodes, inMyList, progress, similar } = data;
  const lang = getLang();
  // A verified record's synopsis comes from the provider (English); the
  // Indonesian field stays empty until translated, so fall back.
  const synopsis = (lang === 'id' && d.synopsis_id) ? d.synopsis_id : d.synopsis_en;
  let inList = inMyList;

  view.innerHTML = '';

  // Back
  const back = el('<button type="button" class="hc-iconbtn mb-1" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</button>');
  back.addEventListener('click', goBack);
  view.appendChild(back);

  const root = el('<div class="hc-detail"></div>');
  view.appendChild(root);

  if (demo) {
    root.appendChild(el(
      '<p class="mb-3 rounded-lg border border-line bg-raised px-3 py-2 text-center text-small text-muted" data-usernode-demo-note>' +
        t('demo.note') + '</p>'
    ));
  }

  // Wide backdrop above the facts (16:9 so the page never shifts while it
  // loads): the record's backdrop, the committed sample art, or the neutral
  // placeholder when the record has no verified artwork.
  {
    const src = backdropArt(d) || backdropFallback(d);
    const fb = backdropArt(d) ? backdropFallback(d) : '';
    const lqip = lqipArt(d, 'b');
    root.appendChild(el(
      '<div class="hc-backdrop mb-4">' +
        '<img data-art' + (fb ? ' data-fallback="' + fb + '"' : '') + ' src="' + src + '" alt="" loading="lazy" decoding="async"' +
        (lqip ? ' style="background-image:url(' + lqip + ');background-size:cover;background-position:center"' : '') +
      '></div>'
    ));
  }

  // Header: poster + facts
  const facts = [];
  facts.push('<h1 class="text-heading">' + esc(d.title) + '</h1>');
  facts.push('<p class="text-small text-muted">' + d.year + ' · ' + countryLabel(d.country) + '</p>');
  const genreNames = d.genres.length ? d.genres : [];
  facts.push('<p class="text-small text-muted">' +
    (genreNames.length ? genreNames.map(genreLabel).join(', ') : (d.genres_raw || []).join(', ')) + '</p>');
  if (d.original_title && d.original_title !== d.title) {
    facts.push('<p class="text-small text-muted">' + t('detail.originalTitle') + ' · ' + esc(d.original_title) + '</p>');
  }
  if (d.director) {
    facts.push('<p class="text-small text-muted">' + t('detail.director') + ' · ' + esc(d.director) + '</p>');
  }
  const epBits = [];
  if (d.language) epBits.push(langLabel(d.language));
  if (d.total_episodes) epBits.push(t('detail.epCount', { n: d.total_episodes }));
  if (d.episode_duration_min) epBits.push(t('detail.epDuration', { n: d.episode_duration_min }));
  if (epBits.length) {
    facts.push('<p class="text-small text-muted">' + epBits.join(' · ') + '</p>');
  }
  facts.push('<p class="flex items-center gap-1 text-small font-medium text-fg">' +
    '<span class="text-accent">' + icon('star', 'h-4 w-4') + '</span>' + d.rating.toFixed(1) +
  '</p>');
  // Where the facts came from: verified records link the provider page;
  // records without verified artwork say so instead of hiding it.
  if (d.verified) {
    const source = d.source_url
      ? ' · <a class="text-accent" href="' + esc(d.source_url) + '" target="_blank" rel="noopener">' + t('detail.verifiedSource') + '</a>'
      : '';
    facts.push('<p class="text-small text-muted">' + t('detail.verified') + source + '</p>');
  } else if (d.needs_review) {
    facts.push('<p class="text-small text-muted">' + t('detail.needsReview') + '</p>');
  }
  root.appendChild(el(
    '<div class="flex gap-4">' +
      '<span class="poster w-32 shrink-0">' + artImg(d, { width: 600, alt: d.title.replace(/"/g, '&quot;') }) + '</span>' +
      '<div class="flex min-w-0 flex-1 flex-col justify-center gap-1">' + facts.join('') + '</div>' +
    '</div>'
  ));

  // Actions: Play / Continue (primary), Add to My List (secondary).
  const startEp = progress && progress.ep ? progress.ep : 1;
  const actions = el('<div class="mt-4 flex flex-wrap gap-2"></div>');
  const playBtn = el(
    '<a class="btn-primary flex-1" data-nav href="/watch/' + d.id + '/' + startEp + demoQ + '">' +
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
  if (d.cast_names && d.cast_names.length) {
    root.appendChild(el(
      '<section class="mt-5"><h2 class="section-label">' + t('detail.cast') + '</h2>' +
        '<p class="px-1 text-body text-fg">' + d.cast_names.map(esc).join(', ') + '</p>' +
      '</section>'
    ));
  }

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
    const still = stillArt(d, epn.num, d.genres[0]);
    const row = el(
      '<li><a class="list-row" data-nav href="/watch/' + d.id + '/' + epn.num + demoQ + '">' +
        '<span class="hc-still relative shrink-0">' +
          (still
            ? '<img data-art loading="lazy" decoding="async" src="' + still + '" alt="">'
            : '') +
          '<span class="hc-still-num">' + epn.num + '</span>' +
        '</span>' +
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

  // More like this: dramas sharing a genre or country with this one,
  // ranked by the server. Only when the catalog actually has some.
  const similarRow = (similar || []).filter(Boolean);
  if (similarRow.length) {
    root.appendChild(el('<section class="mt-6" data-similar></section>'));
    root.querySelector('[data-similar]').appendChild(
      hRow(t('detail.similar'), similarRow.map((s) => dramaCard(s, {
        href: '/drama/' + s.id + demoQ,
        playHref: '/watch/' + s.id + '/1' + demoQ,
      })))
    );
  }

  // Provider attribution, required for TMDB-sourced metadata and artwork.
  // Shown only where TMDB data is actually on screen (a verified record);
  // an app with no key and only sample content needs no notice.
  if (d.verified || d.tmdb_id) {
    root.appendChild(el(
      '<p class="px-1 pt-4 text-small text-muted">' + t('detail.tmdbNotice') + '</p>'
    ));
  }
}

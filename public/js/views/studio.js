// Contributor Studio (the Chinese Drama Hub Studio): one screen where a
// signed-in contributor builds a drama title and its first season together.
// A dark fixed top bar carries the Studio's own mark and its one action
// (Upload video); a nested genre sidebar filters the title list; the work
// area holds "Create a new drama title" and, under it, "Episodic structure"
// (a Season 1 container, the Add new episode sub-form, an Upload season
// poster drop zone and the growing episode list).
//
// Everything a title or episode needs already exists in the shared drama
// tracker, so the Studio writes the tracker's own tables through its writers
// (POST /api/tracker/dramas, POST /api/tracker/dramas/:id/episodes, ...) and
// a new title shows up in the group's feed at /tracker. Nothing here writes
// Home's verified catalog. Images go through the platform's storage (the
// bridge) exactly as the existing Add a drama and Posters screens do it;
// only the returned URL is kept, never the bytes.

import { api, askForAccount } from '../api.js';
import { el, icon, toast } from '../ui.js';
import { t } from '../i18n.js';
import { store } from '../store.js';

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_GENRES = 6;

// The sidebar's genre list. "Popular" is a sort (the default selection, so
// no genre filter), and it is not one of the filterable slugs. The list is
// its own constant: the tracker's `genres` column is free text, so no schema
// change and no migration of existing genres.
const SIDEBAR_GENRES = [
  { slug: 'thriller', key: 'studio.genreThriller' },
  { slug: 'horror', key: 'studio.genreHorror' },
  { slug: 'adventure', key: 'studio.genreAdventure' },
  { slug: 'mystic', key: 'studio.genreMystic' },
  { slug: 'sci-fi', key: 'studio.genreSciFi' },
  { slug: 'fantasy', key: 'studio.genreFantasy' },
  { slug: 'isekai', key: 'studio.genreIsekai' },
  { slug: 'action', key: 'studio.genreAction' },
];
// The genre chips on the create form: the same labels the sidebar shows.
// Resolved at draw time so a language change re-labels them.
function formGenres() {
  return SIDEBAR_GENRES.map((g) => t(g.key));
}

// Module-level screen state, so a re-render (a language change) keeps the
// contributor's place.
let state = null;

export function unmount() {
  state = null;
}

function resetState() {
  state = { genre: 'popular', openDramaId: null, items: [], genreCounts: {}, groups: [] };
}

// ── Image drop zone ──────────────────────────────────────────────────────
// A labelled dashed zone that accepts a drag or a tap, uploads through the
// platform's storage when the bridge is there, and keeps only the URL.
function dropZone({ label, small, onUrl }) {
  const wrap = el(
    '<div>' +
      '<span class="section-label">' + label + '</span>' +
      '<div class="studio-drop' + (small ? ' small' : '') + '" role="button" tabindex="0" ' +
        'aria-label="' + label + '">' +
        '<span class="studio-drop-preview" hidden><img alt="" data-drop-img></span>' +
        '<span class="text-small text-muted" data-drop-hint>' + t('studio.dropHint') + '</span>' +
        '<button type="button" class="btn-secondary min-h-9 px-3 text-small" data-choose>' + t('studio.chooseFile') + '</button>' +
        '<span class="text-small text-muted">' + t('studio.imageHint') + '</span>' +
      '</div>' +
      '<input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" data-file>' +
    '</div>'
  );
  const zone = wrap.querySelector('.studio-drop');
  const fileInput = wrap.querySelector('[data-file]');
  const preview = wrap.querySelector('.studio-drop-preview');
  const img = wrap.querySelector('[data-drop-img]');
  const hint = wrap.querySelector('[data-drop-hint]');
  let url = null;

  function setUrl(next, silent) {
    url = next || null;
    if (url) {
      img.src = url;
      preview.hidden = false;
      hint.hidden = true;
      zone.classList.remove('is-over');
    } else {
      img.removeAttribute('src');
      preview.hidden = true;
      hint.hidden = false;
    }
    if (!silent && onUrl) onUrl(url);
  }

  async function upload(file) {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) { toast(t('studio.fileType')); return; }
    if (file.size > MAX_BYTES) { toast(t('studio.fileTooBig')); return; }
    if (!(window.usernode && window.usernode.uploadFile)) { toast(t('studio.uploadsNeedApp')); return; }
    toast(t('studio.uploading'));
    try {
      const stored = await window.usernode.uploadFile(file, { visibility: 'public' });
      setUrl(stored.url);
      toast(t('studio.uploaded'));
    } catch (e) {
      toast(t('studio.uploadFailed'));
    }
  }

  wrap.querySelector('[data-choose]').addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    upload(file);
  });
  // Drag and drop.
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  }));
  ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('is-over')));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    upload(file);
  });

  return { wrap, setUrl, getUrl: () => url };
}

// ── Top bar ──────────────────────────────────────────────────────────────
function topBar(onUploadVideo) {
  const bar = el(
    '<div class="studio-bar">' +
      '<span class="studio-mark">' + icon('film', 'h-4 w-4') + '</span>' +
      '<span class="studio-name">' + t('studio.title') + '</span>' +
      '<span class="studio-nav">' +
        '<a data-nav href="/studio" class="is-active" aria-current="page">' + t('studio.navMyStudio') + '</a>' +
        '<a data-nav href="/studio">' + t('studio.navActivity') + '</a>' +
        '<a data-nav href="/profile">' + t('studio.navProfile') + '</a>' +
      '</span>' +
      '<button type="button" class="studio-upload" data-upload-video>' + t('studio.uploadVideo') + '</button>' +
    '</div>'
  );
  bar.querySelector('[data-upload-video]').addEventListener('click', onUploadVideo);
  return bar;
}

// ── Sidebar ──────────────────────────────────────────────────────────────
function sidebar(onPick) {
  const tree = el('<nav class="studio-side" aria-label="' + t('studio.rootsLabel') + '"><ul class="studio-tree"></ul></nav>');
  const ul = tree.querySelector('ul');

  const row = (label, cls, opts) => {
    const o = opts || {};
    const li = el('<li class="' + cls + '"></li>');
    if (o.button) {
      const b = el('<button type="button" class="studio-genrebtn' + (o.on ? ' on' : '') + '"' +
        (o.current ? ' aria-current="true"' : '') + '>' +
        (o.icon ? icon(o.icon, 'h-4 w-4 shrink-0 text-muted') : '') +
        '<span class="truncate">' + label + '</span>' +
        (o.count == null ? '' : '<span class="studio-count">' + o.count + '</span>') +
        '</button>');
      b.addEventListener('click', () => onPick(o.slug));
      li.appendChild(b);
    } else {
      li.innerHTML = '<span class="flex items-center gap-2 truncate">' +
        (o.icon ? icon(o.icon, 'h-4 w-4 shrink-0 text-muted') : '') + label + '</span>';
    }
    return li;
  };

  ul.appendChild(row(t('studio.rootsLabel'), 'studio-root', { icon: 'folder' }));
  ul.appendChild(row(t('studio.mainCategories'), 'studio-sub lv2', {}));
  ul.appendChild(row(t('studio.newTitleCategories'), 'studio-sub lv2', {}));
  // The genre list, the current selection marked. Popular is the default and
  // shows every title.
  ul.appendChild(row(t('studio.genrePopular'), 'lv3', {
    button: true, slug: 'popular', on: state.genre === 'popular', current: state.genre === 'popular',
    count: state.genreCounts.popular == null ? 0 : state.genreCounts.popular,
  }));
  for (const g of SIDEBAR_GENRES) {
    ul.appendChild(row(t(g.key), 'lv3', {
      button: true, slug: g.slug, on: state.genre === g.slug,
      count: state.genreCounts[g.slug] == null ? 0 : state.genreCounts[g.slug],
    }));
  }

  const groupsLabel = el('<p class="studio-groups-label section-label mt-4">' + t('studio.seriesGroups') + '</p>');
  tree.appendChild(groupsLabel);
  const grupUl = el('<ul class="studio-tree studio-chips"></ul>');
  tree.appendChild(grupUl);
  if (!state.groups.length) {
    grupUl.appendChild(el('<li class="studio-empty text-small text-muted">' + t('studio.noGroups') + '</li>'));
  } else {
    for (const g of state.groups) {
      grupUl.appendChild(el('<li>' + icon('folder', 'h-4 w-4 shrink-0 text-muted') +
        '<span class="truncate">' + escapeHtml(g.name) + '</span>' +
        '<span class="studio-count">' + g.title_count + '</span></li>'));
    }
  }
  return tree;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Create a title form ──────────────────────────────────────────────────
function titleForm(onSaved) {
  const card = el(
    '<section class="card">' +
      '<h3 class="text-heading">' + t('studio.titleDetails') + '</h3>' +
      '<div class="mt-3 flex flex-col gap-3">' +
        '<label class="block"><span class="section-label">' + t('studio.dramaTitle') + '</span>' +
          '<input class="field" data-title maxlength="80" placeholder="' + t('studio.dramaTitlePh') + '"></label>' +
        '<label class="block"><span class="section-label">' + t('studio.synopsis') + '</span>' +
          '<textarea class="field" rows="3" data-synopsis maxlength="280" placeholder="' + t('studio.synopsisPh') + '"></textarea></label>' +
        '<div>' +
          '<span class="section-label">' + t('studio.genres') + '</span>' +
          '<div class="flex flex-wrap gap-2" data-genres role="group" aria-label="' + t('studio.genres') + '"></div>' +
        '</div>' +
        '<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">' +
          '<label class="block"><span class="section-label">' + t('studio.studio') + '</span>' +
            '<input class="field" data-studio maxlength="60" placeholder="' + t('studio.studioPh') + '"></label>' +
          '<label class="block"><span class="section-label">' + t('studio.series') + '</span>' +
            '<select class="field" data-series><option value="">' + t('studio.noSeries') + '</option></select></label>' +
        '</div>' +
      '</div>' +
    '</section>'
  );

  // Genres as add/remove chips, never a comma-separated text box.
  const chosen = new Set();
  const chipHost = card.querySelector('[data-genres]');
  function renderChips() {
    chipHost.innerHTML = '';
    for (const g of formGenres()) {
      const on = chosen.has(g);
      const b = el('<button type="button" class="chip' + (on ? ' is-active' : '') + '" ' +
        'aria-pressed="' + on + '">' + g + '</button>');
      b.addEventListener('click', () => {
        if (chosen.has(g)) chosen.delete(g);
        else if (chosen.size >= MAX_GENRES) { toast(t('studio.addGenre')); return; }
        else chosen.add(g);
        renderChips();
      });
      chipHost.appendChild(b);
    }
  }
  renderChips();

  // Series groups are read-only here (creating/renaming them is deferred).
  const seriesSel = card.querySelector('[data-series]');
  for (const g of state.groups) {
    const opt = el('<option></option>');
    opt.value = String(g.id);
    opt.textContent = g.name;
    seriesSel.appendChild(opt);
  }

  const err = el('<p class="mt-2 text-small text-danger" role="alert" hidden></p>');
  card.appendChild(err);
  const submit = el('<button type="button" class="btn-primary mt-3 w-full sm:w-auto" data-save>' + t('studio.saveTitle') + '</button>');
  card.appendChild(submit);

  submit.addEventListener('click', async () => {
    err.hidden = true;
    const title = card.querySelector('[data-title]').value.trim();
    if (!title || title.length > 80) {
      err.hidden = false; err.textContent = t('studio.titleRequired'); return;
    }
    submit.disabled = true;
    try {
      const r = await api('/api/tracker/dramas', {
        method: 'POST',
        action: 'create a drama title',
        body: {
          title,
          synopsis: card.querySelector('[data-synopsis]').value.trim(),
          genres: [...chosen].join(', '),
          studio: card.querySelector('[data-studio]').value.trim(),
          seriesId: seriesSel.value || null,
          poster_url: poster.getUrl() || '',
        },
      });
      toast(t('studio.saved'));
      card.querySelector('[data-title]').value = '';
      card.querySelector('[data-synopsis]').value = '';
      card.querySelector('[data-studio]').value = '';
      chosen.clear();
      renderChips();
      poster.setUrl(null, true);
      await onSaved(r.drama.id);
    } catch (e) {
      if (e.code !== 'account_required') {
        err.hidden = false;
        err.textContent = e.message || t('studio.errorBody');
      }
    } finally {
      submit.disabled = false;
    }
  });

  // The poster drop zone beside the card.
  const poster = dropZone({ label: t('studio.uploadTitlePoster') });
  const grid = el('<div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] md:items-start"></div>');
  grid.appendChild(card);
  grid.appendChild(poster.wrap);
  return grid;
}

// ── Episodic structure ───────────────────────────────────────────────────
// The Season 1 container: the finale tick, the Add new episode sub-form, the
// Upload season poster zone and the episode list panel. Bound to the drama
// the Studio has open (the title just saved, or one opened from the list).
function seasonMetaFor(id) {
  const item = state.items.find((x) => x.id === id);
  return item
    ? { poster_url: item.season1_poster_url || null, is_finale: !!item.season1_is_finale }
    : { poster_url: null, is_finale: false };
}

// The tracker's write routes leave staging seed rows out unless the request
// carries ?demo=1 (the same clause the tracker's own screen uses), so a write
// against a row the Studio is showing must carry it too. Empty outside the
// ?demo=1 preview.
function demoQuery() {
  return state && state.demo ? '?demo=1' : '';
}

function setSeasonMeta(id, patch) {
  const item = state.items.find((x) => x.id === id);
  if (!item) return;
  if (patch.poster_url !== undefined) item.season1_poster_url = patch.poster_url;
  if (patch.is_finale !== undefined) item.season1_is_finale = patch.is_finale;
}

function episodicPanel(getOpenId, onChange) {
  const section = el('<section data-episodic></section>');
  let renderToken = 0;

  async function load() {
    const id = getOpenId();
    const token = ++renderToken;
    if (!id) {
      section.innerHTML = '';
      section.appendChild(el(
        '<h3 class="text-heading mt-6">' + t('studio.episodic') + '</h3>' +
        '<div class="state-empty"><p class="text-body text-muted">' + t('studio.noTitlesBody') + '</p></div>'
      ));
      return;
    }
    section.innerHTML = '<h3 class="text-heading mt-6">' + t('studio.episodic') + '</h3>' +
      '<div class="skeleton h-40 w-full rounded-xl"></div>';
    const demoQ = state.demo ? '?demo=1' : '';
    let data;
    try {
      data = await api('/api/tracker/dramas/' + id + demoQ);
    } catch (e) {
      if (token !== renderToken) return;
      if (e.code === 'account_required') return;
      section.innerHTML = '<h3 class="text-heading mt-6">' + t('studio.episodic') + '</h3>';
      const box = el('<div class="state-error"><p class="text-heading">' + t('common.errorTitle') + '</p>' +
        '<p class="text-body text-muted">' + t('studio.errorBody') + '</p></div>');
      const retry = el('<button type="button" class="btn-secondary mt-2">' + t('common.retry') + '</button>');
      retry.addEventListener('click', () => load());
      box.appendChild(retry);
      section.appendChild(box);
      return;
    }
    if (token !== renderToken) return;
    draw(data);
  }

  function draw(data) {
    const drama = data.drama;
    const seasonNum = 1;
    const eps = (data.episodes || []).filter((e) => e.season === seasonNum);
    section.innerHTML = '';
    section.appendChild(el('<h3 class="text-heading mt-6">' + t('studio.episodic') + '</h3>'));

    const grid = el('<div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] md:items-start"></div>');
    const card = el('<section class="card"></section>');
    const seasonMeta = seasonMetaFor(drama.id);
    const finaleOn = !!seasonMeta.is_finale;

    const head = el(
      '<div class="flex flex-wrap items-center gap-3">' +
        '<span class="text-heading mr-auto">' + t('studio.season', { n: seasonNum }) +
          ' <span class="text-small text-muted">· ' + escapeHtml(drama.title) + '</span></span>' +
        '<label class="flex items-center gap-2 text-small text-muted">' +
          '<input type="checkbox" data-finale' + (finaleOn ? ' checked' : '') + '> ' +
          t('studio.addSeasonFinale') + '</label>' +
      '</div>'
    );
    head.querySelector('[data-finale]').addEventListener('change', async (e) => {
      const on = e.target.checked;
      try {
        await api('/api/tracker/dramas/' + drama.id + '/seasons/' + seasonNum + '/poster' + demoQuery(), {
          method: 'PUT',
          action: 'save the season finale',
          body: { poster_url: seasonMeta.poster_url || '', is_finale: on },
        });
        setSeasonMeta(drama.id, { is_finale: on });
        toast(t('studio.seasonSaved'));
      } catch (e2) {
        if (e2.code !== 'account_required') toast(t('studio.errorBody'));
        e.target.checked = !on;
      }
    });
    card.appendChild(head);

    // The Add new episode sub-form.
    card.appendChild(el('<h4 class="text-heading mt-4">' + t('studio.addNewEpisode') + '</h4>'));
    const nextNumber = eps.reduce((m, e) => Math.max(m, Number(e.number) || 0), 0) + 1;
    const sub = el(
      '<div class="mt-2 flex flex-col gap-3">' +
        '<div class="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">' +
          '<label class="block"><span class="section-label">' + t('studio.episodeNumber') + '</span>' +
            '<input class="field" data-ep-number type="number" min="1" max="999" inputmode="numeric" value="' + nextNumber + '"></label>' +
          '<label class="block"><span class="section-label">' + t('studio.episodeTitle') + '</span>' +
            '<input class="field" data-ep-title maxlength="80" placeholder="' + t('studio.episodeTitlePh') + '"></label>' +
        '</div>' +
        '<label class="block"><span class="section-label">' + t('studio.videoUrl') + '</span>' +
          '<input class="field" data-ep-video type="url" placeholder="' + t('studio.videoUrlPh') + '">' +
          '<span class="mt-1 block px-1 text-small text-muted">' + t('studio.videoHint') + '</span></label>' +
        '<label class="block"><span class="section-label">' + t('studio.shortDescription') + '</span>' +
          '<textarea class="field" rows="2" data-ep-desc maxlength="500"></textarea></label>' +
      '</div>'
    );
    card.appendChild(sub);
    const thumb = dropZone({ label: t('studio.uploadEpisodeThumb'), small: true });
    card.appendChild(thumb.wrap);
    const err = el('<p class="mt-2 text-small text-danger" role="alert" hidden></p>');
    card.appendChild(err);
    const addBtn = el('<button type="button" class="btn-primary mt-3 w-full sm:w-auto" data-add-ep>' + t('studio.addNewEpisode') + '</button>');
    card.appendChild(addBtn);

    addBtn.addEventListener('click', async () => {
      err.hidden = true;
      const number = parseInt(sub.querySelector('[data-ep-number]').value, 10);
      const title = sub.querySelector('[data-ep-title]').value.trim();
      if (!number || number < 1 || number > 999) {
        err.hidden = false; err.textContent = t('studio.episodeNumberRequired'); return;
      }
      if (!title || title.length > 80) {
        err.hidden = false; err.textContent = t('studio.episodeTitleRequired'); return;
      }
      addBtn.disabled = true;
      try {
        await api('/api/tracker/dramas/' + drama.id + '/episodes' + demoQuery(), {
          method: 'POST',
          action: 'add an episode',
          body: {
            season: seasonNum,
            number,
            title,
            media_url: sub.querySelector('[data-ep-video]').value.trim(),
            description: sub.querySelector('[data-ep-desc]').value.trim(),
            thumbnail_url: thumb.getUrl() || '',
            is_finale: finaleOn,
          },
        });
        toast(t('studio.episodeAdded'));
        thumb.setUrl(null, true);
        await load();
        if (onChange) onChange();
      } catch (e2) {
        if (e2.code === 'account_required') { addBtn.disabled = false; return; }
        err.hidden = false;
        err.textContent = e2.status === 409 ? t('studio.episodeExists') : (e2.message || t('studio.errorBody'));
        addBtn.disabled = false;
      }
    });

    // The episode list panel.
    const listPanel = el('<div></div>');
    const seasonPoster = dropZone({
      label: t('studio.uploadSeasonPoster'),
      small: true,
      onUrl: async (url) => {
        try {
          await api('/api/tracker/dramas/' + drama.id + '/seasons/' + seasonNum + '/poster' + demoQuery(), {
            method: 'PUT',
            action: 'save the season poster',
            body: { poster_url: url || '', is_finale: finaleOn },
          });
          setSeasonMeta(drama.id, { poster_url: url });
          toast(t('studio.seasonSaved'));
        } catch (e2) {
          if (e2.code !== 'account_required') toast(t('studio.errorBody'));
        }
      },
    });
    if (seasonMeta.poster_url) seasonPoster.setUrl(seasonMeta.poster_url, true);
    listPanel.appendChild(seasonPoster.wrap);
    listPanel.appendChild(el('<p class="section-label mt-4">' + t('studio.episodes') + '</p>'));
    if (!eps.length) {
      listPanel.appendChild(el('<div class="state-empty"><p class="text-body text-muted">' + t('studio.noEpisodes') + '</p></div>'));
    } else {
      const ul = el('<ul class="list" style="list-style:none;margin:0;padding:0"></ul>');
      for (const ep of eps) ul.appendChild(episodeRow(drama, ep, load));
      listPanel.appendChild(ul);
    }

    card.appendChild(el('<div class="mt-4"></div>'));
    grid.appendChild(card);
    grid.appendChild(listPanel);
    section.appendChild(grid);
  }

  return { section, reload: load };
}

// One episode row: a small still, "Ep. N: Title", and an Edit button that
// swaps the row for an inline editor.
function episodeRow(drama, ep, reload) {
  const li = el('<li></li>');
  const row = el(
    '<div class="list-row">' +
      '<span class="hc-still shrink-0">' +
        (ep.thumbnail_url
          ? '<img src="' + escapeHtml(ep.thumbnail_url) + '" alt="" loading="lazy" decoding="async">'
          : '<span class="flex h-full w-full items-center justify-center text-small text-muted">' + ep.number + '</span>') +
      '</span>' +
      '<span class="min-w-0 flex-1">' +
        '<span class="block truncate text-body text-fg">' +
          t('studio.episodeRow', { n: ep.number, title: escapeHtml(ep.title) }) + '</span>' +
        (ep.is_finale ? '<span class="chip chip-soft text-small">' + t('studio.addSeasonFinale') + '</span>' : '') +
      '</span>' +
      '<button type="button" class="btn-secondary min-h-9 shrink-0 px-3 text-small">' + t('studio.edit') + '</button>' +
    '</div>'
  );
  li.appendChild(row);

  row.querySelector('button').addEventListener('click', () => {
    const editor = el(
      '<div class="list-row flex-col items-stretch">' +
        '<div class="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">' +
          '<label class="block"><span class="section-label">' + t('studio.episodeNumber') + '</span>' +
            '<input class="field" data-e-number type="number" min="1" max="999" value="' + ep.number + '"></label>' +
          '<label class="block"><span class="section-label">' + t('studio.episodeTitle') + '</span>' +
            '<input class="field" data-e-title maxlength="80" value="' + escapeHtml(ep.title) + '"></label>' +
        '</div>' +
        '<label class="block"><span class="section-label">' + t('studio.videoUrl') + '</span>' +
          '<input class="field" data-e-video type="url" value="' + escapeHtml(ep.media_url || '') + '"></label>' +
        '<label class="block"><span class="section-label">' + t('studio.shortDescription') + '</span>' +
          '<textarea class="field" rows="2" data-e-desc maxlength="500">' + escapeHtml(ep.description || '') + '</textarea></label>' +
        '<div class="flex items-center gap-2">' +
          '<button type="button" class="btn-primary min-h-9 px-3 text-small" data-save>' + t('studio.saveEdit') + '</button>' +
          '<button type="button" class="btn-secondary min-h-9 px-3 text-small" data-cancel>' + t('studio.cancelEdit') + '</button>' +
        '</div>' +
      '</div>'
    );
    li.innerHTML = '';
    li.appendChild(editor);
    editor.querySelector('[data-cancel]').addEventListener('click', () => { li.innerHTML = ''; li.appendChild(row); });
    editor.querySelector('[data-save]').addEventListener('click', async () => {
      const saveBtn = editor.querySelector('[data-save]');
      const title = editor.querySelector('[data-e-title]').value.trim();
      const number = parseInt(editor.querySelector('[data-e-number]').value, 10);
      if (!title || title.length > 80) { toast(t('studio.episodeTitleRequired')); return; }
      if (!number || number < 1 || number > 999) { toast(t('studio.episodeNumberRequired')); return; }
      saveBtn.disabled = true;
      try {
        await api('/api/tracker/episodes/' + ep.id + demoQuery(), {
          method: 'PATCH',
          action: 'edit an episode',
          body: {
            title,
            number,
            media_url: editor.querySelector('[data-e-video]').value.trim(),
            description: editor.querySelector('[data-e-desc]').value.trim(),
          },
        });
        toast(t('studio.episodeSaved'));
        await reload();
      } catch (e2) {
        if (e2.code !== 'account_required') toast(e2.status === 409 ? t('studio.episodeExists') : t('studio.errorBody'));
        saveBtn.disabled = false;
      }
    });
  });
  return li;
}

// ── The titles list ──────────────────────────────────────────────────────
function titleList(onOpen) {
  const wrap = el('<section class="mt-6"></section>');
  wrap.appendChild(el('<h3 class="section-label">' + t('studio.titlesHeading') + '</h3>'));
  if (!state.items.length) {
    wrap.appendChild(el('<div class="state-empty"><p class="text-heading">' + t('studio.noTitles') + '</p>' +
      '<p class="text-body text-muted">' + t('studio.noTitlesBody') + '</p></div>'));
    return wrap;
  }
  const ul = el('<ul class="list" style="list-style:none;margin:0;padding:0"></ul>');
  for (const d of state.items) {
    const li = el(
      '<li><div class="list-row">' +
        '<span class="hc-still w-16 shrink-0">' +
          (d.poster_url
            ? '<img src="' + escapeHtml(d.poster_url) + '" alt="" loading="lazy" decoding="async">'
            : '<span class="flex h-full w-full items-center justify-center">' + icon('film', 'h-5 w-5 text-muted') + '</span>') +
        '</span>' +
        '<span class="min-w-0 flex-1">' +
          '<span class="block truncate text-body text-fg">' + escapeHtml(d.title) + '</span>' +
          '<span class="block truncate text-small text-muted">' +
            [d.studio ? escapeHtml(d.studio) : '', t('detail.epCount', { n: d.episode_count })].filter(Boolean).join(' · ') +
          '</span>' +
        '</span>' +
        '<button type="button" class="btn-secondary min-h-9 shrink-0 px-3 text-small">' + t('studio.edit') + '</button>' +
      '</div></li>'
    );
    li.querySelector('button').addEventListener('click', () => onOpen(d.id));
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

// ── render ───────────────────────────────────────────────────────────────
export async function render({ view, query }) {
  resetState();
  state.demo = query.get('demo') === '1';

  view.classList.add('studio-view');
  view.innerHTML = '';
  view.appendChild(el('<div class="studio-body px-4 pt-3"></div>'));

  // A fixed bar and a work column: the bar is drawn before the data loads so
  // it never flashes away.
  const body = view.querySelector('.studio-body');
  const shell = el('<div class="mx-auto w-full max-w-5xl"></div>');
  body.appendChild(shell);

  const me = store.me || { user: null, guest: false };
  const bar = topBar(() => {
    // "Upload video" is a link step (the platform stores images only): it
    // brings the Episodic structure's video field into view for the drama
    // being built.
    const panel = doc().querySelector('[data-episodic]');
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const videoInput = panel.querySelector('[data-ep-video]');
      if (videoInput) videoInput.focus();
    } else {
      toast(t('studio.videoHint'));
    }
  });
  view.insertBefore(bar, body);

  if (!me.user) {
    // Guests and signed-out visitors see the same make-an-account card the
    // Profile and Posters screens show; the server refuses the data too.
    const box = el('<div class="state-empty">' +
      '<p class="text-heading">' + t('studio.createHeading') + '</p>' +
      '<p class="text-body text-muted">' + t('studio.guestBody') + '</p></div>');
    const btn = el('<button type="button" class="btn-primary mt-2">' + t('profile.makeAccount') + '</button>');
    btn.addEventListener('click', () => { if (!askForAccount('build drama titles')) toast(t('studio.guestBody')); });
    box.appendChild(btn);
    shell.appendChild(box);
    return;
  }

  // Loading shape: the sidebar tree and the form's own rows.
  shell.appendChild(el('<div class="flex flex-col gap-3 md:flex-row md:gap-6">' +
    '<div class="md:w-64"><div class="skeleton h-64 w-full rounded-xl"></div></div>' +
    '<div class="min-w-0 flex-1"><div class="skeleton h-40 w-full rounded-xl"></div></div></div>'));

  const demoQ = state.demo ? '?demo=1' : '';
  async function loadList() {
    const q = state.genre && state.genre !== 'popular' ? '&genre=' + encodeURIComponent(state.genre) : '';
    return api('/api/studio/dramas' + demoQ + q);
  }

  let first;
  try {
    first = await loadList();
  } catch (e) {
    if (e.code === 'account_required') { shell.innerHTML = ''; shell.appendChild(el('<p class="text-body text-muted px-4">' + t('studio.guestBody') + '</p>')); return; }
    shell.innerHTML = '';
    const box = el('<div class="state-error"><p class="text-heading">' + t('common.errorTitle') + '</p>' +
      '<p class="text-body text-muted">' + t('studio.errorBody') + '</p></div>');
    const retry = el('<button type="button" class="btn-secondary mt-2">' + t('common.retry') + '</button>');
    retry.addEventListener('click', () => render({ view, query }));
    box.appendChild(retry);
    shell.appendChild(box);
    return;
  }
  state.items = first.items;
  state.genreCounts = first.genre_counts || {};
  state.groups = first.groups || [];
  // Open the newest title by default so a contributor lands on a real season
  // (and ?demo=1 lands on the seeded drama's episode list).
  if (!state.openDramaId && state.items.length) state.openDramaId = state.items[0].id;

  const panes = el('<div class="studio-panes"></div>');
  const sideHost = el('<div></div>');
  const main = el('<div class="studio-main"></div>');
  panes.appendChild(sideHost);
  panes.appendChild(main);
  shell.innerHTML = '';
  shell.appendChild(panes);

  main.appendChild(el('<p class="text-small text-muted">' + t('studio.createEyebrow') + '</p>'));
  main.appendChild(el('<h2 class="text-title mb-4">' + t('studio.createHeading') + '</h2>'));

  const episodic = episodicPanel(() => state.openDramaId, () => refreshList());

  const listHost = el('<div></div>');
  const form = titleForm(async (newId) => {
    state.openDramaId = newId;
    await refreshList();
    await episodic.reload();
  });
  main.appendChild(form);
  main.appendChild(episodic.section);
  main.appendChild(listHost);

  function drawList() {
    listHost.innerHTML = '';
    listHost.appendChild(titleList(async (id) => {
      state.openDramaId = id;
      drawSide();
      await episodic.reload();
    }));
  }
  function drawSide() {
    sideHost.innerHTML = '';
    sideHost.appendChild(sidebar(async (slug) => {
      state.genre = slug;
      await refreshList();
    }));
  }
  async function refreshList() {
    try {
      const data = await loadList();
      state.items = data.items;
      state.genreCounts = data.genre_counts || {};
      state.groups = data.groups || [];
    } catch (e) {
      if (e.code === 'account_required') return;
    }
    drawSide();
    drawList();
  }

  drawSide();
  drawList();
  episodic.reload();
}

// The view's own light-weight document lookup (kept explicit so it is clear
// the panel lives inside the screen we just drew).
function doc() {
  return document.getElementById('hc-view') || document;
}

// Poster studio: the curator workflow for verified drama artwork. Search
// the provider catalog by title, preview the record (poster and backdrop
// options, facts), confirm the title and release year, and import — the
// server re-verifies against a fresh provider fetch before saving, so the
// client's confirm values are a human check, not the gate. Records without
// a provider match can be added by hand; they save needs_review with no
// artwork (the neutral placeholder), never a stand-in poster.

import { api } from '../api.js';
import { el, icon, toast, esc } from '../ui.js';
import { t, countryLabel } from '../i18n.js';
import { store } from '../store.js';

let searchDebounce = null;
const SEARCH_DEBOUNCE_MS = 350;

export function unmount() {
  if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
}

function statusOf(d) {
  // An open review flag outranks the verified badge: the scan marks
  // verified records for review too, and they belong in the review queue.
  return d.needs_review ? 'needs_review' : d.verified ? 'verified' : 'sample';
}

function statusChip(d) {
  const s = statusOf(d);
  const label = s === 'verified' ? t('posters.verified')
    : s === 'needs_review' ? t('posters.review') : t('posters.sample');
  return '<span class="chip shrink-0 text-small ' +
    (s === 'verified' ? 'chip-vip' : 'chip-soft') + '">' + label + '</span>';
}

// A small 2:3 poster thumb; the delegated art listener falls a broken
// image back to the neutral placeholder.
function thumb(url, cls) {
  const img = url
    ? '<img data-art data-fallback="/img/placeholder-poster.svg" src="' + esc(url) +
      '" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover">'
    : '<img data-art src="/img/placeholder-poster.svg" alt="" loading="lazy" class="h-full w-full object-cover">';
  return '<span class="' + cls + ' block overflow-hidden rounded-md border border-line bg-raised" style="aspect-ratio:2/3">' +
    img + '</span>';
}

// The 16:9 counterpart for a record's backdrop.
function thumbBg(url, cls) {
  const img = url
    ? '<img data-art data-fallback="/img/placeholder-backdrop.svg" src="' + esc(url) +
      '" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover">'
    : '<img data-art src="/img/placeholder-backdrop.svg" alt="" loading="lazy" class="h-full w-full object-cover">';
  return '<span class="' + cls + ' block overflow-hidden rounded-md border border-line bg-raised" style="aspect-ratio:16/9">' +
    img + '</span>';
}

// Why a record sits in review, as one short line under its title.
function reasonLine(d) {
  if (!d.needs_review) return '';
  const key = d.review_reason === 'broken_link' ? 'posters.reasonBroken'
    : d.review_reason === 'missing_poster' ? 'posters.reasonMissing'
    : 'posters.reasonManual';
  return '<span class="block truncate text-small text-fg">' + t(key) + '</span>';
}

function factRow(label, value) {
  return '<p class="text-small text-muted">' + label + ' · ' + value + '</p>';
}

// ── Verify panel: the provider record to confirm and import ───────────────
// mode 'import' is the full confirm-and-import flow (search, or Fix on a
// flagged record); mode 'replace' is the reduced artwork-only panel for an
// already-verified record. State lives here so list re-renders keep the
// panel open.
let preview = null; // { mode, record, confirmTitle, confirmYear, contentType, posterPath, backdropPath, dramaId }

function renderPreview(root, onChange) {
  const old = root.querySelector('[data-preview]');
  if (old) old.remove();
  if (!preview) return;
  const r = preview.record;
  const replaceMode = preview.mode === 'replace';

  const pickRow = (kind, list, chosen) =>
    '<div class="hc-row">' +
      (list.length ? list.map((p) =>
        '<button type="button" class="shrink-0" data-pick="' + kind + ':' + esc(p.path) + '"' +
          ' aria-pressed="' + (chosen === p.path) + '" aria-label="' + t('posters.poster') + '">' +
          thumb(p.thumb, 'w-16') +
        '</button>').join('')
      : '<p class="text-small text-muted">' + t('posters.none') + '</p>') +
    '</div>';

  const panel = el(
    '<section class="card mt-4" data-preview>' +
      '<div class="flex items-start justify-between gap-2">' +
        '<div class="min-w-0">' +
          '<h3 class="text-heading">' + esc(r.title) + '</h3>' +
          factRow(t('detail.originalTitle'), esc(r.originalTitle)) +
          factRow(t('discover.year'), esc(r.year)) +
          factRow(t('discover.country'), r.originCountry ? countryLabel(r.originCountry) : '') +
          (r.director ? factRow(t('detail.director'), esc(r.director)) : '') +
          (r.totalEpisodes ? factRow(t('detail.episodes'), r.totalEpisodes) : '') +
          (r.cast && r.cast.length ? factRow(t('detail.cast'), esc(r.cast.join(', '))) : '') +
        '</div>' +
        '<button type="button" class="btn-secondary min-h-9 px-3 text-small" data-close>' + t('common.cancel') + '</button>' +
      '</div>' +
      '<p class="mt-3 text-body text-fg">' + esc(r.overview) + '</p>' +
      '<h4 class="section-label mt-4">' + t('posters.poster') + '</h4>' +
      pickRow('poster', r.posters || [], preview.posterPath) +
      '<h4 class="section-label mt-4">' + t('posters.backdrop') + '</h4>' +
      pickRow('backdrop', r.backdrops || [], preview.backdropPath) +
      (replaceMode ? '' :
        '<div class="mt-4 grid grid-cols-2 gap-3">' +
          '<label class="block"><span class="section-label">' + t('posters.confirmTitle') + '</span>' +
            '<input class="field" type="text" data-confirm-title value="' + esc(preview.confirmTitle) + '"></label>' +
          '<label class="block"><span class="section-label">' + t('posters.confirmYear') + '</span>' +
            '<input class="field" type="number" inputmode="numeric" data-confirm-year value="' + esc(preview.confirmYear) + '"></label>' +
        '</div>' +
        '<div class="mt-3" data-content-type></div>') +
      '<button type="button" class="btn-primary mt-4 w-full" data-import>' +
        t(replaceMode ? 'posters.save' : 'posters.import') + '</button>' +
      '<p class="mt-2 px-1 text-small text-muted" data-verify-note>' +
        t(replaceMode ? 'posters.replaceNote' : 'posters.verifyNote') + '</p>' +
    '</section>'
  );

  panel.querySelector('[data-close]').addEventListener('click', () => {
    preview = null;
    onChange();
  });

  panel.querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      const idx = b.getAttribute('data-pick').indexOf(':');
      const kind = b.getAttribute('data-pick').slice(0, idx);
      const path = b.getAttribute('data-pick').slice(idx + 1);
      const field = kind === 'poster' ? 'posterPath' : 'backdropPath';
      preview[field] = preview[field] === path ? null : path;
      renderPreview(root, onChange);
    });
  });

  const titleIn = panel.querySelector('[data-confirm-title]');
  const yearIn = panel.querySelector('[data-confirm-year]');
  if (titleIn) titleIn.addEventListener('input', () => { preview.confirmTitle = titleIn.value; });
  if (yearIn) yearIn.addEventListener('input', () => { preview.confirmYear = yearIn.value; });

  // Content type: Series (default) / Short drama.
  const ctSeg = el(
    '<div class="hc-segment w-full" role="group" aria-label="' + t('posters.contentType') + '">' +
      '<button type="button" data-v="series" aria-pressed="' + (preview.contentType === 'series') + '">' + t('posters.series') + '</button>' +
      '<button type="button" data-v="short" aria-pressed="' + (preview.contentType === 'short') + '">' + t('posters.short') + '</button>' +
    '</div>'
  );
  ctSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      preview.contentType = b.dataset.v;
      ctSeg.querySelectorAll('button').forEach((x) =>
        x.setAttribute('aria-pressed', String(x.dataset.v === preview.contentType)));
    });
  });
  const ctHost = panel.querySelector('[data-content-type]');
  if (ctHost) ctHost.appendChild(ctSeg);

  panel.querySelector('[data-import]').addEventListener('click', async () => {
    const btn = panel.querySelector('[data-import]');
    const note = panel.querySelector('[data-verify-note]');
    const replacing = preview.mode === 'replace';
    btn.disabled = true;
    try {
      const out = await api('/api/admin/dramas/import', {
        method: 'POST',
        action: 'import verified dramas',
        body: replacing ? {
          tmdbId: preview.record.tmdbId,
          dramaId: preview.dramaId,
          posterPath: preview.posterPath || undefined,
          backdropPath: preview.backdropPath || undefined,
        } : {
          tmdbId: preview.record.tmdbId,
          confirmTitle: preview.confirmTitle,
          confirmYear: parseInt(preview.confirmYear, 10),
          posterPath: preview.posterPath || undefined,
          backdropPath: preview.backdropPath || undefined,
          contentType: preview.contentType,
          dramaId: preview.dramaId || undefined,
        },
      });
      if (replacing && preview.dramaId) {
        // A replace only counts when the fresh links re-check clean: the
        // server flagged nothing again, so the old review flag is gone.
        try {
          const check = await api('/api/admin/dramas/' + preview.dramaId + '/check-art',
            { method: 'POST', action: 'check drama artwork' });
          toast(check.markedForReview ? t('posters.artBroken') : t('posters.artCleared'));
        } catch {
          toast(t('posters.artCleared'));
        }
      } else {
        toast(t('posters.imported'));
      }
      preview = null;
      if (onChange.reload) await onChange.reload();
      onChange();
      if (!replacing && onChange.afterImport) onChange.afterImport(out.id);
    } catch (e) {
      // account_required is already surfaced by api.js as the sign-in sheet.
      if (e.code === 'verify_failed') {
        note.textContent = t('posters.verifyFailed');
      } else if (e.code === 'tmdb_duplicate') {
        note.textContent = t('posters.duplicate', { n: e.existingId || '' });
      } else if (e.code === 'unknown_artwork') {
        note.textContent = t('posters.unknownArt');
      } else if (e.code !== 'account_required') {
        note.textContent = t('common.errorBody');
      }
    } finally {
      const b2 = root.querySelector('[data-import]');
      if (b2) b2.disabled = false;
    }
  });

  const anchor = root.querySelector('[data-search-section]');
  if (anchor) anchor.after(panel); else root.appendChild(panel);
  panel.scrollIntoView({ block: 'nearest' });
}

// Open the verify panel for a provider record (from search, or from "Fix"
// on a needs-review record that carries a provider ID).
function openPreview(root, onChange, record, dramaId) {
  preview = {
    mode: 'import',
    record,
    confirmTitle: record.title,
    confirmYear: record.year,
    contentType: 'series',
    posterPath: null,
    backdropPath: null,
    dramaId: dramaId || null,
  };
  renderPreview(root, onChange);
}

// Open the reduced replace panel for an existing record: fetch the
// provider's current artwork lists by the record's own provider ID and
// offer them — no metadata fields, a replace never touches the facts.
async function openReplace(root, onChange, drama, tmdbOff) {
  try {
    const r = await api('/api/admin/tmdb/tv/' + drama.tmdb_id, { action: 'verify drama metadata' });
    preview = {
      mode: 'replace',
      record: r.record,
      posterPath: null,
      backdropPath: null,
      dramaId: drama.id,
    };
    renderPreview(root, onChange);
  } catch (e) {
    if (e.code === 'tmdb_not_configured' && tmdbOff) tmdbOff.classList.remove('hidden');
    else if (e.code !== 'account_required') toast(t('common.errorBody'));
  }
}

export async function render({ view, query }) {
  const demoQ = query.get('demo') === '1' ? '?demo=1' : '';

  view.innerHTML = '';
  view.appendChild(el('<div class="skeleton h-24 w-full rounded-xl"></div>'));

  // The studio is curator work, so it needs an account; a guest gets the
  // same make-an-account card the Profile screen shows.
  const me = store.me || { user: null, guest: false };
  if (!me.user) {
    view.innerHTML = '';
    view.appendChild(el(
      '<div class="mb-4 flex items-center gap-2">' +
        '<a class="hc-iconbtn" data-nav href="/profile" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</a>' +
        '<h1 class="text-title">' + t('posters.title') + '</h1>' +
      '</div>'
    ));
    const box = el('<div class="state-empty"><p class="text-heading">' + t('posters.title') + '</p>' +
      '<p class="text-body text-muted">' + t('profile.guestBody') + '</p></div>');
    const btn = el('<button type="button" class="btn-primary mt-2">' + t('profile.makeAccount') + '</button>');
    btn.addEventListener('click', () => toast(t('profile.guestBody')));
    box.appendChild(btn);
    view.appendChild(box);
    return;
  }

  let records;
  try {
    records = (await api('/api/admin/dramas' + demoQ)).items;
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(el(
      '<div class="mb-4 flex items-center gap-2">' +
        '<a class="hc-iconbtn" data-nav href="/profile" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</a>' +
        '<h1 class="text-title">' + t('posters.title') + '</h1>' +
      '</div>'
    ));
    view.appendChild(el(
      '<div class="state-error"><p class="text-heading">' + t('common.errorTitle') + '</p>' +
        '<p class="text-body text-muted">' + t('common.errorBody') + '</p></div>'
    ));
    return;
  }

  view.innerHTML = '';
  view.appendChild(el(
    '<div class="mb-4 flex items-center gap-2">' +
      '<a class="hc-iconbtn" data-nav href="/profile" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</a>' +
      '<h1 class="text-title">' + t('posters.title') + '</h1>' +
    '</div>'
  ));
  const root = el('<div></div>');
  view.appendChild(root);

  // Re-renders (an import done, artwork checked) redraw the record lists
  // and the verify panel without reloading the whole view.
  let recordList = records;
  const onChange = () => { renderLists(); renderPreview(root, onChange); };
  // The verify panel re-loads the records itself before redrawing (an
  // import or replace just changed them).
  onChange.reload = reloadRecords;
  async function reloadRecords() {
    try { recordList = (await api('/api/admin/dramas' + demoQ)).items; } catch {}
  }

  // ── Poster search ──────────────────────────────────────────────────────
  const searchSection = el(
    '<section data-search-section class="mb-5">' +
      '<h2 class="section-label">' + t('posters.search') + '</h2>' +
      '<input class="field" type="search" name="q" autocomplete="off" ' +
        'placeholder="' + t('posters.searchPh') + '" aria-label="' + t('posters.search') + '">' +
      '<p class="mt-1 px-1 text-small text-muted">' + t('posters.searchHint') + '</p>' +
      '<p class="mt-2 hidden px-1 text-small text-fg" data-tmdb-off role="alert">' + t('posters.tmdbOff') + '</p>' +
      '<div class="mt-2" data-results></div>' +
    '</section>'
  );
  root.appendChild(searchSection);
  const searchInput = searchSection.querySelector('input');
  const results = searchSection.querySelector('[data-results]');
  const tmdbOff = searchSection.querySelector('[data-tmdb-off]');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (searchDebounce) clearTimeout(searchDebounce);
    if (q.length < 2) {
      results.innerHTML = '';
      tmdbOff.classList.add('hidden');
      return;
    }
    searchDebounce = setTimeout(async () => {
      if (searchInput.value.trim() !== q) return; // kept typing
      results.innerHTML = '<p class="px-1 py-2 text-small text-muted">' + t('common.loading') + '</p>';
      try {
        const r = await api('/api/admin/tmdb/search?q=' + encodeURIComponent(q));
        tmdbOff.classList.add('hidden');
        results.innerHTML = '';
        if (!r.items.length) {
          results.appendChild(el('<p class="px-1 py-2 text-small text-muted">' + t('posters.noResults') + '</p>'));
          return;
        }
        const list = el('<div class="list"></div>');
        for (const c of r.items) {
          const row = el(
            '<div class="list-row">' +
              thumb(c.posterUrl, 'w-12 shrink-0') +
              '<span class="min-w-0 flex-1">' +
                '<span class="block truncate text-body font-medium text-fg">' + esc(c.title) + '</span>' +
                '<span class="block truncate text-small text-muted">' +
                  (c.originalTitle && c.originalTitle !== c.title ? esc(c.originalTitle) + ' · ' : '') +
                  esc(c.year) + (c.originCountry ? ' · ' + countryLabel(c.originCountry) : '') +
                '</span>' +
              '</span>' +
              '<button type="button" class="btn-secondary min-h-9 shrink-0 px-3 text-small">' + t('posters.verify') + '</button>' +
            '</div>'
          );
          row.querySelector('button').addEventListener('click', async () => {
            const btn = row.querySelector('button');
            btn.disabled = true;
            try {
              const d = await api('/api/admin/tmdb/tv/' + c.tmdbId);
              openPreview(root, onChange, d.record);
            } catch (e) {
              if (e.code === 'tmdb_not_configured') tmdbOff.classList.remove('hidden');
              else if (e.code !== 'account_required') toast(t('common.errorBody'));
            } finally {
              btn.disabled = false;
            }
          });
          list.appendChild(row);
        }
        results.appendChild(list);
      } catch (e) {
        results.innerHTML = '';
        if (e.code === 'tmdb_not_configured') {
          tmdbOff.classList.remove('hidden');
        } else if (e.code !== 'account_required') {
          results.appendChild(el('<p class="px-1 py-2 text-small text-muted">' + t('common.errorBody') + '</p>'));
        }
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  // ── Add without a provider match ───────────────────────────────────────
  const manual = el(
    '<section class="mb-5">' +
      '<h2 class="section-label">' + t('posters.manual') + '</h2>' +
      '<div class="card p-4">' +
        '<p class="text-small text-muted">' + t('posters.manualHint') + '</p>' +
        '<div class="mt-3 flex flex-col gap-3">' +
          '<label class="block"><span class="section-label">' + t('add.name') + '</span>' +
            '<input class="field" type="text" data-m-title maxlength="120"></label>' +
          '<div class="grid grid-cols-2 gap-3">' +
            '<label class="block"><span class="section-label">' + t('add.year') + '</span>' +
              '<input class="field" type="number" inputmode="numeric" data-m-year placeholder="' + t('add.yearPh') + '"></label>' +
            '<label class="block"><span class="section-label">' + t('add.country') + '</span>' +
              '<input class="field" type="text" data-m-country maxlength="2" placeholder="' + t('posters.countryPh') + '"></label>' +
          '</div>' +
          '<label class="block"><span class="section-label">' + t('add.synopsis') + '</span>' +
            '<textarea class="field" rows="3" data-m-synopsis></textarea></label>' +
          '<div class="hc-segment w-full" role="group" aria-label="' + t('posters.contentType') + '">' +
            '<button type="button" data-v="series" aria-pressed="true">' + t('posters.series') + '</button>' +
            '<button type="button" data-v="short" aria-pressed="false">' + t('posters.short') + '</button>' +
          '</div>' +
          '<button type="button" class="btn-secondary" data-m-add>' + t('add.submit') + '</button>' +
        '</div>' +
      '</div>' +
    '</section>'
  );
  root.appendChild(manual);
  let manualType = 'series';
  manual.querySelectorAll('.hc-segment button').forEach((b) => {
    b.addEventListener('click', () => {
      manualType = b.dataset.v;
      manual.querySelectorAll('.hc-segment button').forEach((x) =>
        x.setAttribute('aria-pressed', String(x.dataset.v === manualType)));
    });
  });
  manual.querySelector('[data-m-add]').addEventListener('click', async () => {
    const btn = manual.querySelector('[data-m-add]');
    btn.disabled = true;
    try {
      await api('/api/admin/dramas/import', {
        method: 'POST',
        action: 'add dramas to the catalog',
        body: {
          title: manual.querySelector('[data-m-title]').value.trim(),
          year: parseInt(manual.querySelector('[data-m-year]').value, 10),
          country: manual.querySelector('[data-m-country]').value.trim().toLowerCase(),
          synopsis: manual.querySelector('[data-m-synopsis]').value.trim(),
          contentType: manualType,
        },
      });
      toast(t('posters.imported'));
      await reloadRecords();
      onChange();
    } catch (e) {
      if (e.code === 'bad_request') toast(t('posters.manualInvalid'));
      else if (e.code !== 'account_required') toast(t('common.errorBody'));
    } finally {
      btn.disabled = false;
    }
  });

  // ── Awaiting review + No artwork yet + All dramas ─────────────────────
  function recordRow(d) {
    const s = statusOf(d);
    const actions = el('<span class="flex shrink-0 items-center gap-2">' + statusChip(d) + '</span>');
    // Check artwork: the server HEADs the stored URLs and flags broken ones.
    if (d.poster_url || d.backdrop_url) {
      const check = el('<button type="button" class="btn-secondary min-h-9 px-3 text-small">' + t('posters.checkArt') + '</button>');
      check.addEventListener('click', async () => {
        check.disabled = true;
        try {
          const out = await api('/api/admin/dramas/' + d.id + '/check-art', { method: 'POST', action: 'check drama artwork' });
          toast(out.markedForReview ? t('posters.artBroken') : t('posters.artOk'));
          await reloadRecords();
          onChange();
        } catch (e) {
          if (e.code !== 'account_required') toast(t('common.errorBody'));
        } finally { check.disabled = false; }
      });
      actions.appendChild(check);
    }
    // Replace: swap the artwork on a provider-linked record through the
    // reduced panel — the verified metadata is never touched. A record
    // with no artwork at all gets the same panel under its "Verify" name.
    if (d.tmdb_id && s !== 'sample') {
      const noArtRow = !d.poster_url && !d.backdrop_url;
      const rep = el('<button type="button" class="btn-secondary min-h-9 px-3 text-small">' +
        t(noArtRow ? 'posters.verify' : 'posters.replace') + '</button>');
      rep.addEventListener('click', async () => {
        rep.disabled = true;
        await openReplace(root, onChange, d, tmdbOff);
        rep.disabled = false;
      });
      actions.appendChild(rep);
    }
    // Fix: a needs-review record with a provider ID reopens the verify panel.
    if (s === 'needs_review' && d.tmdb_id) {
      const fix = el('<button type="button" class="btn-secondary min-h-9 px-3 text-small">' + t('posters.fix') + '</button>');
      fix.addEventListener('click', async () => {
        fix.disabled = true;
        try {
          const r = await api('/api/admin/tmdb/tv/' + d.tmdb_id, { action: 'verify drama metadata' });
          openPreview(root, onChange, r.record, d.id);
        } catch (e) {
          if (e.code === 'tmdb_not_configured') tmdbOff.classList.remove('hidden');
          else if (e.code !== 'account_required') toast(t('common.errorBody'));
        } finally { fix.disabled = false; }
      });
      actions.appendChild(fix);
    }
    // A link the server reports as unresolvable (poster_ok/backdrop_ok
    // false) renders the placeholder straight away: the browser never
    // requests a URL the record is already flagged over, so a broken stored
    // link shows up as review state instead of a failed image load.
    const row = el(
      '<li><div class="list-row flex-wrap">' +
        thumb(d.poster_ok === false ? null : d.poster_url, 'w-12 shrink-0') +
        thumbBg(d.backdrop_ok === false ? null : d.backdrop_url, 'w-16 shrink-0') +
        '<span class="min-w-0 flex-1">' +
          '<span class="block truncate text-body font-medium text-fg">' + esc(d.title) + '</span>' +
          '<span class="block truncate text-small text-muted">' +
            esc(d.year) + (d.total_episodes ? ' · ' + t('detail.epCount', { n: d.total_episodes }) : '') +
          '</span>' +
          reasonLine(d) +
        '</span>' +
      '</div></li>'
    );
    row.querySelector('.list-row').appendChild(actions);
    return row;
  }

  function renderLists() {
    root.querySelectorAll('[data-lists]').forEach((n) => n.remove());
    const needs = recordList.filter((d) => statusOf(d) === 'needs_review');
    // Records with no artwork and no open flag: verified without art, or a
    // provider import that came back without any. The scan cannot flag the
    // unverified ones (they are already the placeholder), so they live here.
    const noArt = recordList.filter((d) =>
      !d.poster_url && !d.backdrop_url && !d.needs_review && (d.verified || d.tmdb_id));
    const wrap = el('<div data-lists></div>');

    const reviewSection = el(
      '<section class="mb-5">' +
        '<div class="flex items-center justify-between gap-2">' +
          '<h2 class="section-label mb-0">' + t('posters.review') + '</h2>' +
          '<button type="button" class="btn-secondary min-h-9 shrink-0 px-3 text-small" data-scan>' +
            t('posters.checkAll') + '</button>' +
        '</div>' +
        (needs.length
          ? '<ul class="list mt-2"></ul>'
          : '<p class="mt-2 px-1 text-small text-muted">' + t('posters.none') + '</p>') +
      '</section>'
    );
    const scanBtn = reviewSection.querySelector('[data-scan]');
    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      try {
        const out = await api('/api/admin/dramas/check-art', { method: 'POST', action: 'check drama artwork' });
        toast(out.flagged
          ? t('posters.scanDone', { checked: out.checked, n: out.flagged })
          : t('posters.scanClean'));
        await reloadRecords();
        onChange();
      } catch (e) {
        if (e.code !== 'account_required') toast(t('common.errorBody'));
      } finally { scanBtn.disabled = false; }
    });
    if (needs.length) {
      const ul = reviewSection.querySelector('ul');
      needs.forEach((d) => ul.appendChild(recordRow(d)));
    }
    wrap.appendChild(reviewSection);

    const noArtSection = el(
      '<section class="mb-5"><h2 class="section-label">' + t('posters.noArt') + '</h2>' +
        (noArt.length
          ? '<ul class="list"></ul>'
          : '<p class="px-1 text-small text-muted">' + t('posters.none') + '</p>') +
      '</section>'
    );
    if (noArt.length) {
      const ul = noArtSection.querySelector('ul');
      noArt.forEach((d) => ul.appendChild(recordRow(d)));
    }
    wrap.appendChild(noArtSection);

    const allSection = el(
      '<section class="mb-5"><h2 class="section-label">' + t('posters.all') + '</h2><ul class="list"></ul></section>'
    );
    const ul = allSection.querySelector('ul');
    recordList.forEach((d) => ul.appendChild(recordRow(d)));
    wrap.appendChild(allSection);

    root.appendChild(wrap);
  }

  renderLists();
}

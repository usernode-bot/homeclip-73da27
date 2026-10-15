// HomeClip shared UI helpers: DOM builder, icons, memoized drama cards,
// rows, skeletons, states, bottom sheet and toast. All styling goes through
// the kit's tokens/components in styles/tailwind-input.css.

import { t, genreLabel, countryLabel } from './i18n.js';
import { artImg } from './art.js';

// Small DOM builder: el(`<p class="x">hi</p>`) → Element.
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function timeFmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0');
}

// ── Icons (24-unit grid, 2px round strokes, currentColor) ────────────────
const ICON_PATHS = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>',
  discover: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  bookmark: '<path d="M7 4h10a1 1 0 011 1v15l-6-4-6 4V5a1 1 0 011-1z"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
  next: '<path d="M6 5.5l9 6.5-9 6.5z"/><path d="M18 5v14"/>',
  list: '<path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><circle cx="4" cy="6" r="0.5"/><circle cx="4" cy="12" r="0.5"/><circle cx="4" cy="18" r="0.5"/>',
  speed: '<circle cx="12" cy="13" r="8"/><path d="M12 13l3.5-3.5"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12h4"/><path d="M13 12h4"/><path d="M7 15.5h2"/><path d="M11 15.5h6"/>',
  fullscreen: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/>',
  chevronLeft: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  check: '<path d="M5 13l4.5 4.5L19 7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 010 18a15 15 0 010-18z"/>',
};

export function icon(name, cls) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" class="' + (cls || 'h-5 w-5') +
    '" aria-hidden="true">' + ICON_PATHS[name] + '</svg>';
}

// ── Drama cards (memoized) ───────────────────────────────────────────────
// Rendering 30+ poster cards per screen happens repeatedly (every Home /
// Discover re-render), so each rendered card is cached per (drama, variant)
// and re-used by cloning instead of rebuilding markup.
const cardCache = new Map();

function buildCard(d, opts) {
  const opts2 = opts || {};
  const meta = d.year + ' · ' + d.genres.map(genreLabel).join(', ');
  const progress = opts2.progress;
  let pct = 0;
  if (progress && progress.duration > 0) pct = Math.min(100, Math.round((progress.seconds / progress.duration) * 100));
  const html =
    '<a class="hc-card block shrink-0 ' + (opts2.grid ? 'w-full' : 'w-28') + '" ' +
      'href="' + (opts2.href || '/drama/' + d.id) + '" data-nav>' +
      '<span class="poster relative">' +
        artImg(d.id, { alt: d.title.replace(/"/g, '&quot;') }) +
        (opts2.rank ? '<span class="hc-rank">' + opts2.rank + '</span>' : '') +
      '</span>' +
      '<p class="mt-1.5 truncate text-small font-medium text-fg">' + d.title + '</p>' +
      '<p class="truncate text-small text-muted">' + meta + '</p>' +
      (progress
        ? '<span class="hc-progress" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' +
          '<p class="mt-0.5 truncate text-small text-muted">' +
            t('history.epShort', { n: progress.ep }) +
            (pct > 0 ? ' · ' + timeFmt(progress.seconds) : '') +
          '</p>'
        : '') +
    '</a>';
  return el(html);
}

export function dramaCard(d, opts) {
  const o = opts || {};
  const key = d.id + ':' + (o.rank || '') + ':' + (o.grid ? 'g' : 'r') + ':' +
    (o.href ? 'w' : 'd') + ':' +
    (o.progress ? o.progress.ep + ':' + Math.round((o.progress.seconds || 0) / 1000) : '');
  let node = cardCache.get(key);
  if (!node) {
    node = buildCard(d, o);
    cardCache.set(key, node);
  }
  const clone = node.cloneNode(true);
  return clone;
}

// A titled horizontal row of cards.
export function hRow(title, cards) {
  const row = el(
    '<section class="hc-row-section mb-5">' +
      '<h2 class="section-label">' + title + '</h2>' +
      '<div class="hc-row" role="list"></div>' +
    '</section>'
  );
  const listEl = row.querySelector('.hc-row');
  for (const c of cards) {
    c.setAttribute('role', 'listitem');
    listEl.appendChild(c);
  }
  return row;
}

// ── Skeletons (the content's own shape) ──────────────────────────────────
export function skeletonHome() {
  const bannerBars = Array.from({ length: 3 }, () =>
    '<div class="skeleton h-4 w-40"></div>').join('');
  let html = '<div class="hc-banner mb-6"><div class="w-full h-full skeleton rounded-none"></div></div>';
  html += '<div class="skeleton mb-6 h-11 w-full"></div>';
  for (let r = 0; r < 3; r++) {
    html += '<section class="mb-5"><div class="skeleton mb-2 h-4 w-32"></div>' +
      '<div class="flex gap-3">' +
      Array.from({ length: 4 }, () => '<div class="w-28 shrink-0"><div class="poster skeleton rounded-xl border-0"></div><div class="skeleton mt-1.5 h-3.5 w-24"></div><div class="skeleton mt-1 h-3 w-16"></div></div>').join('') +
      '</div></section>';
  }
  return el('<div>' + html + '</div>');
}

export function skeletonGrid(count) {
  const n = count || 6;
  let cells = '';
  for (let i = 0; i < n; i++) {
    cells += '<div><div class="poster skeleton rounded-xl border-0"></div><div class="skeleton mt-1.5 h-3.5 w-24"></div></div>';
  }
  return el('<div class="grid grid-cols-3 gap-3 sm:grid-cols-4">' + cells + '</div>');
}

export function skeletonDetail() {
  return el(
    '<div class="hc-detail">' +
      '<div class="flex gap-4"><div class="poster w-32 shrink-0 skeleton rounded-xl border-0"></div>' +
      '<div class="flex flex-1 flex-col gap-2 py-1">' +
      '<div class="skeleton h-6 w-40"></div><div class="skeleton h-4 w-28"></div><div class="skeleton h-4 w-20"></div>' +
      '<div class="mt-2 flex gap-2"><div class="skeleton h-11 w-28 rounded-lg"></div><div class="skeleton h-11 w-28 rounded-lg"></div></div>' +
      '</div></div>' +
      '<div class="mt-5 flex flex-col gap-2"><div class="skeleton h-4 w-full"></div><div class="skeleton h-4 w-4/5"></div><div class="skeleton h-4 w-3/5"></div></div>' +
      '<div class="mt-5 flex flex-col gap-2">' +
      Array.from({ length: 5 }, () => '<div class="skeleton h-12 w-full rounded-lg"></div>').join('') +
      '</div>' +
    '</div>'
  );
}

// ── States ───────────────────────────────────────────────────────────────
export function errorState(retry) {
  const box = el(
    '<div class="state-error" role="alert">' +
      '<p class="text-heading">' + t('common.errorTitle') + '</p>' +
      '<p class="text-body text-muted">' + t('common.errorBody') + '</p>' +
    '</div>'
  );
  const btn = el('<button class="btn-secondary mt-2"></button>');
  btn.textContent = t('common.retry');
  btn.addEventListener('click', retry);
  box.appendChild(btn);
  return box;
}

export function emptyState(title, body, action) {
  const box = el('<div class="state-empty"><p class="text-heading">' + title + '</p>' +
    (body ? '<p class="text-body text-muted">' + body + '</p>' : '') + '</div>');
  if (action) {
    const a = el('<a class="btn-primary mt-2" data-nav></a>');
    a.setAttribute('href', action.href);
    a.textContent = action.label;
    box.appendChild(a);
  }
  return box;
}

// ── Bottom sheet (player menus, episode switcher) ────────────────────────
export function openSheet(contentEl, opts) {
  const backdrop = el('<div class="hc-sheet-backdrop"></div>');
  const panel = el('<div class="hc-sheet" role="dialog" aria-modal="true" aria-label="' +
    ((opts && opts.label) || '') + '"></div>');
  panel.appendChild(contentEl);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    panel.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  return { close, panel };
}

// ── Toast ────────────────────────────────────────────────────────────────
let toastTimer = null;
export function toast(message) {
  try {
    if (window.unNative && window.unNative.toast) {
      window.unNative.toast(message);
      return;
    }
  } catch {}
  let tEl = document.getElementById('hc-toast');
  if (!tEl) {
    tEl = el('<div id="hc-toast" class="fixed inset-x-0 bottom-20 z-50 mx-auto w-max max-w-sm rounded-full bg-fg px-4 py-2 text-small text-ground" role="status"></div>');
    document.body.appendChild(tEl);
  }
  tEl.textContent = message;
  tEl.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { tEl.style.opacity = '0'; }, 2200);
}

// HomeClip router: path-based screens, lazily imported per navigation so a
// screen only loads when it is opened. The bottom tab bar lives here.

import { t } from './i18n.js';
import { icon, errorState } from './ui.js';
import { store, applyTheme } from './store.js';
import { getToken } from './api.js';

const viewEl = () => document.getElementById('hc-view');
const tabEl = () => document.getElementById('hc-tabbar');

const ROUTES = [
  { re: /^\/$/, view: () => import('./views/home.js'), tab: 'home' },
  { re: /^\/discover$/, view: () => import('./views/discover.js'), tab: 'discover' },
  { re: /^\/my-list$/, view: () => import('./views/mylist.js'), tab: 'mylist' },
  { re: /^\/profile$/, view: () => import('./views/profile.js'), tab: 'profile' },
  { re: /^\/search$/, view: () => import('./views/search.js'), tab: null },
  { re: /^\/add$/, view: () => import('./views/add.js'), tab: null },
  { re: /^\/posters$/, view: () => import('./views/posters.js'), tab: null },
  { re: /^\/profiles$/, view: () => import('./views/profiles.js'), tab: null },
  { re: /^\/drama\/(\d+)$/, view: () => import('./views/drama.js'), tab: null },
  { re: /^\/watch\/(\d+)\/(\d+)$/, view: () => import('./views/player.js'), tab: null, player: true },
  // Catch-all: everything unmatched is the not-found screen, last so the
  // real routes above always win.
  { re: /.*/, view: () => import('./views/notfound.js'), tab: null },
];

const TABS = [
  { key: 'home', path: '/', icon: 'home' },
  { key: 'discover', path: '/discover', icon: 'discover' },
  { key: 'mylist', path: '/my-list', icon: 'bookmark' },
  { key: 'profile', path: '/profile', icon: 'profile' },
];

let cleanup = null;
// Which render is the latest: a screen that throws after the viewer has
// already moved on must not overwrite the newer screen.
let renderSeq = 0;

// Per-tab scroll memory, for the session only: the offset a tab route was
// left at, keyed by its path (query excluded, so Discover's filter rewrites
// stay in one slot). A fresh page load starts every tab at the top.
const scrollMem = new Map();
let lastPath = null;
let lastWasTab = false;

function matchRoute(path) {
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { route: r, params: m.slice(1) };
  }
  return null;
}

function renderTabbar(activeKey, hideBar) {
  const tabbar = tabEl();
  if (!tabbar) return;
  // Real links, handled by the delegated a[data-nav] click handler below:
  // a tab navigates like any link (pushState, no reload) and the browser
  // treats it as one (middle-click, new tab). The active tab follows the
  // route, not the tap.
  tabbar.innerHTML = TABS.map((tb) =>
    '<a href="' + tb.path + '" data-nav class="' + (tb.key === activeKey ? 'is-active' : '') + '" ' +
    (tb.key === activeKey ? 'aria-current="page" ' : '') +
    'aria-label="' + t('tab.' + tb.key) + '">' +
    icon(tb.icon) +
    '<span>' + t('tab.' + tb.key) + '</span>' +
    '</a>'
  ).join('');
  tabbar.hidden = !!hideBar;
}

// Re-label the tab bar (language changed) and re-mark the active tab.
export function refreshTabbar() {
  const m = matchRoute(location.pathname);
  renderTabbar(m && m.route.tab ? m.route.tab : null, m && m.route.player);
}

export async function render() {
  const seq = ++renderSeq;
  let path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '') path = '/';
  // Leaving a tab route: remember where the viewer had scrolled, so
  // coming back lands where they left.
  if (lastWasTab && lastPath && lastPath !== path) {
    scrollMem.set(lastPath, window.scrollY);
  }
  if (cleanup) {
    try { cleanup(); } catch {}
    cleanup = null;
  }
  // The catch-all route means m is always found; unknown paths render the
  // not-found screen and keep their URL.
  const { route, params } = matchRoute(path);
  const container = viewEl();
  renderTabbar(route.tab, route.player);
  container.hidden = false;
  window.scrollTo(0, 0);
  try {
    const mod = await route.view();
    if (mod.unmount) cleanup = mod.unmount;
    await mod.render({ view: container, params, query: new URLSearchParams(location.search) });
    // Coming back to a tab: restore its scroll spot once the content is
    // drawn. Non-tab routes (drama, player, search, not-found, ...) always
    // open at the top.
    if (route.tab && scrollMem.has(path)) {
      window.scrollTo(0, scrollMem.get(path));
    }
  } catch (err) {
    console.error('render failed', err);
    // A screen that breaks while being drawn (or fails to import) gets the
    // error box in place of its content, never a blank page or a skeleton
    // that never finishes. Only the latest render may draw it.
    if (seq === renderSeq && container) {
      container.innerHTML = '';
      container.appendChild(errorState(() => render(), { screen: route.tab, error: err }));
    }
  } finally {
    lastPath = path;
    lastWasTab = !!route.tab;
  }
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

export function initRouter() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // The tracker is its own page (tracker.html); cross over with a real
    // navigation so its own router takes over. Carry the identity token in
    // the URL — that page reads it the same way this one was loaded (the
    // platform's edge also adds the header on the app's own address, so
    // inside Homeroom the ?token= is redundant but harmless).
    if (a.getAttribute('href').startsWith('/tracker')) {
      const token = getToken();
      const href = a.getAttribute('href');
      if (token && !href.includes('token=')) {
        const sep = href.includes('?') ? '&' : '?';
        a.setAttribute('href', href + sep + 'token=' + token);
      }
      return;
    }
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', render);
  return render();
}

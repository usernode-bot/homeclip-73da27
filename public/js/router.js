// HomeClip router: path-based screens, lazily imported per navigation so a
// screen only loads when it is opened. The bottom tab bar lives here.

import { t } from './i18n.js';
import { icon } from './ui.js';
import { store, applyTheme } from './store.js';

const viewEl = () => document.getElementById('hc-view');
const tabEl = () => document.getElementById('hc-tabbar');

const ROUTES = [
  { re: /^\/$/, view: () => import('./views/home.js'), tab: 'home' },
  { re: /^\/discover$/, view: () => import('./views/discover.js'), tab: 'discover' },
  { re: /^\/my-list$/, view: () => import('./views/mylist.js'), tab: 'mylist' },
  { re: /^\/profile$/, view: () => import('./views/profile.js'), tab: 'profile' },
  { re: /^\/search$/, view: () => import('./views/search.js'), tab: null },
  { re: /^\/drama\/(\d+)$/, view: () => import('./views/drama.js'), tab: null },
  { re: /^\/watch\/(\d+)\/(\d+)$/, view: () => import('./views/player.js'), tab: null, player: true },
];

const TABS = [
  { key: 'home', path: '/', icon: 'home' },
  { key: 'discover', path: '/discover', icon: 'discover' },
  { key: 'mylist', path: '/my-list', icon: 'bookmark' },
  { key: 'profile', path: '/profile', icon: 'profile' },
];

let cleanup = null;

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
  tabbar.innerHTML = TABS.map((tb) =>
    '<button type="button" data-tab="' + tb.key + '" data-path="' + tb.path + '" ' +
    'class="' + (tb.key === activeKey ? 'is-active' : '') + '" ' +
    'aria-label="' + t('tab.' + tb.key) + '">' +
    icon(tb.icon) +
    '<span>' + t('tab.' + tb.key) + '</span>' +
    '</button>'
  ).join('');
  tabbar.hidden = !!hideBar;
}

// Re-label the tab bar (language changed) and re-mark the active tab.
export function refreshTabbar() {
  const m = matchRoute(location.pathname);
  renderTabbar(m && m.route.tab ? m.route.tab : null, m && m.route.player);
}

export async function render() {
  if (cleanup) {
    try { cleanup(); } catch {}
    cleanup = null;
  }
  let path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '') path = '/';
  const m = matchRoute(path);
  const container = viewEl();
  if (!m) {
    // Unknown path: fall back to Home in place.
    history.replaceState({}, '', '/');
    return render();
  }
  const { route, params } = m;
  renderTabbar(route.tab, route.player);
  container.hidden = false;
  window.scrollTo(0, 0);
  try {
    const mod = await route.view();
    if (mod.unmount) cleanup = mod.unmount;
    await mod.render({ view: container, params, query: new URLSearchParams(location.search) });
  } catch (err) {
    console.error('render failed', err);
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
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', render);
  return render();
}

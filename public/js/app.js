// HomeClip app bootstrap: load the viewer's identity + settings, apply
// theme and language, then start the router. Screens are lazy-loaded per
// route (one ES module each) so opening the app only pays for Home.

import { initRouter, refreshTabbar, render } from './router.js';
import { store, applyTheme, applyLang, loadCachedSettings, fetchMe } from './store.js';
import { t } from './i18n.js';

loadCachedSettings();
applyTheme();

// Bootstrap is best-effort: if /api/me fails (offline), the app still opens
// with defaults, and reads that don't need an identity keep working.
try {
  await fetchMe();
} catch (e) {
  console.warn('me failed', e && e.message);
  store.me = { user: null, guest: false, settings: store.settings, platformLocale: null };
}

applyLang();
refreshTabbar();

// The viewer changes the platform theme while the app is open: follow it
// whenever the in-app setting is "system".
window.addEventListener('usernode:theme-changed', () => {
  applyTheme();
  // Views draw both looks from tokens; nothing else to do.
});

// Language changed: re-render whatever screen is open so its strings and
// the tab bar follow.
document.addEventListener('hc:lang', () => {
  document.title = 'HomeClip';
  refreshTabbar();
  render();
});

await initRouter();

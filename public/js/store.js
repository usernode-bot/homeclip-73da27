// HomeClip app state: the signed-in user, their settings, and the two
// settings that change how the whole app looks — theme and language.

import { api, askForAccount } from './api.js';
import { initLang, setLang, getLang } from './i18n.js';

export const store = {
  me: null,        // { user, guest, settings, platformLocale } from /api/me
  settings: { language: 'system', theme: 'system', notifications: true },
};

const THEME_MEDIA = window.matchMedia('(prefers-color-scheme: dark)');

// Apply the viewer's theme setting. "system" follows the platform theme
// (the bridge reports it); light/dark are the viewer's own in-app override,
// which wins per the platform conventions.
export function applyTheme() {
  const setting = (store.settings && store.settings.theme) || 'system';
  let theme;
  if (setting === 'light' || setting === 'dark') theme = setting;
  else theme = (window.usernode && window.usernode.theme) || (THEME_MEDIA.matches ? 'dark' : 'light');
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

// Resolve the display language from the stored setting.
export function resolveLang() {
  const platformLocale = store.me && store.me.platformLocale;
  let device = 'en';
  try { device = navigator.language || 'en'; } catch {}
  return initLang((store.settings && store.settings.language) || 'system', platformLocale, device);
}

export function applyLang() {
  resolveLang();
  document.documentElement.lang = getLang() === 'id' ? 'id' : 'en';
  document.dispatchEvent(new CustomEvent('hc:lang'));
}

// A signed-in user's settings live on the server; a signed-out visitor's
// (guests cannot write) live in localStorage so the app still responds.
export function loadCachedSettings() {
  try {
    const raw = localStorage.getItem('hc:settings');
    if (raw) store.settings = { ...store.settings, ...JSON.parse(raw) };
  } catch {}
}

function persistLocal() {
  try { localStorage.setItem('hc:settings', JSON.stringify(store.settings)); } catch {}
}

export async function fetchMe() {
  const me = await api('/api/me');
  store.me = me;
  if (me.user && me.settings) {
    store.settings = me.settings;
    persistLocal();
  }
  applyTheme();
  return me;
}

export async function saveSettings(patch) {
  const next = { ...store.settings, ...patch };
  store.settings = next;
  persistLocal();
  if (patch.theme !== undefined) applyTheme();
  if (patch.language !== undefined) applyLang();
  if (store.me && store.me.user) {
    try {
      const r = await api('/api/settings', { method: 'PUT', body: next });
      store.settings = r.settings;
      persistLocal();
    } catch (e) {
      if (e.code === 'account_required') askForAccount('save your settings');
    }
  }
  return next;
}

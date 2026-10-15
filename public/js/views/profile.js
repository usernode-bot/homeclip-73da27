// Profile: who is watching, and the app's settings — language, theme and
// notifications. Language/theme apply immediately; they persist per user
// (per device for signed-out visitors).

import { askForAccount } from '../api.js';
import { el, icon, toast } from '../ui.js';
import { t } from '../i18n.js';
import { store, saveSettings } from '../store.js';

export async function render({ view }) {
  view.innerHTML = '';
  view.appendChild(el('<div class="skeleton h-24 w-full rounded-xl"></div>'));

  const me = store.me || { user: null, guest: false };
  const user = me.user;
  const settings = store.settings;

  view.innerHTML = '';

  // Identity card: an initial avatar (no photo upload in Phase 1).
  const avatar = user
    ? '<div class="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-heading text-on-accent">' +
        (user.username ? user.username.charAt(0).toUpperCase() : '?') + '</div>'
    : '<div class="flex h-14 w-14 items-center justify-center rounded-full bg-raised text-muted">' + icon('profile', 'h-6 w-6') + '</div>';
  view.appendChild(el(
    '<div class="hc-profile card flex items-center gap-3">' +
      avatar +
      '<div class="min-w-0">' +
        '<p class="text-heading">' + (user ? '@' + user.username : t('profile.guest')) + '</p>' +
        '<p class="text-small text-muted">' + (user ? t('profile.member') : '') + '</p>' +
      '</div>' +
    '</div>'
  ));

  if (!user) {
    const guestCard = el(
      '<div class="mt-4 rounded-xl border border-line bg-surface p-4">' +
        '<p class="text-body text-muted">' + t('profile.guestBody') + '</p>' +
      '</div>'
    );
    const btn = el('<button type="button" class="btn-primary mt-3">' + t('profile.makeAccount') + '</button>');
    btn.addEventListener('click', () => {
      if (!askForAccount()) toast(t('profile.guestBody'));
    });
    guestCard.appendChild(btn);
    view.appendChild(guestCard);
  }

  // Settings
  const settingsEl = el('<div class="hc-settings mt-5"></div>');
  settingsEl.appendChild(el('<h2 class="section-label">' + t('profile.settings') + '</h2>'));

  // Language: Auto / English / Bahasa Indonesia
  const langSeg = el(
    '<div class="hc-segment w-full">' +
      '<button type="button" data-v="system" aria-pressed="' + (settings.language === 'system') + '">' + t('profile.langAuto') + '</button>' +
      '<button type="button" data-v="en" aria-pressed="' + (settings.language === 'en') + '">English</button>' +
      '<button type="button" data-v="id" aria-pressed="' + (settings.language === 'id') + '">Bahasa Indonesia</button>' +
    '</div>'
  );
  const langRow = el(
    '<div class="list"><div class="list-row">' +
      '<span class="flex-1">' +
        '<span class="block text-body text-fg">' + t('profile.language') + '</span>' +
        '<span class="block text-small text-muted">' + t('profile.langAuto') + ' / English / Bahasa Indonesia</span>' +
      '</span>' +
    '</div>' +
    '<div class="px-4 pb-4">' +
    '</div></div>'
  );
  langRow.querySelector('.px-4.pb-4').appendChild(langSeg);
  settingsEl.appendChild(langRow);

  // Theme: Auto / Light / Dark
  const themeSeg = el(
    '<div class="hc-segment w-full">' +
      '<button type="button" data-v="system" aria-pressed="' + (settings.theme === 'system') + '">' + t('profile.themeAuto') + '</button>' +
      '<button type="button" data-v="light" aria-pressed="' + (settings.theme === 'light') + '">' + t('profile.theme.light') + '</button>' +
      '<button type="button" data-v="dark" aria-pressed="' + (settings.theme === 'dark') + '">' + t('profile.theme.dark') + '</button>' +
    '</div>'
  );
  settingsEl.appendChild(el(
    '<div class="list mt-3"><div class="list-row">' +
      '<span class="flex-1 text-body text-fg">' + t('profile.theme') + '</span>' +
    '</div>' +
    '<div class="px-4 pb-4" data-theme></div></div>'
  ));
  settingsEl.querySelector('[data-theme]').appendChild(themeSeg);

  // Notifications (a stored demo setting in Phase 1; no push yet)
  settingsEl.appendChild(el(
    '<div class="list mt-3"><div class="list-row">' +
      '<span class="flex-1">' +
        '<span class="block text-body text-fg">' + t('profile.notifications') + '</span>' +
        '<span class="block text-small text-muted">' + t('profile.notificationsDesc') + '</span>' +
      '</span>' +
      '<button type="button" class="hc-switch" role="switch" aria-checked="' + !!settings.notifications + '" aria-label="' + t('profile.notifications') + '"></button>' +
    '</div></div>'
  ));
  view.appendChild(settingsEl);

  // About
  view.appendChild(el(
    '<div class="mt-5"><h2 class="section-label">' + t('profile.about') + '</h2>' +
      '<p class="px-1 text-small text-muted">' + t('profile.aboutBody') + '</p>' +
    '</div>'
  ));

  function press(seg, value) {
    seg.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.v === value)));
  }

  langSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async () => {
      press(langSeg, b.dataset.v);
      await saveSettings({ language: b.dataset.v });
      toast(t('common.saved'));
    });
  });
  themeSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async () => {
      press(themeSeg, b.dataset.v);
      await saveSettings({ theme: b.dataset.v });
      toast(t('common.saved'));
    });
  });
  const sw = settingsEl.querySelector('.hc-switch');
  sw.addEventListener('click', async () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(next));
    await saveSettings({ notifications: next });
    toast(t('common.saved'));
  });
}

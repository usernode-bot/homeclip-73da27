// Profiles: who is watching. The signed-in account's viewing profiles,
// each with its own language. Tapping a profile picks it (kept on this
// device); Add and Edit open bottom sheets, like the rest of the app.

import { api, askForAccount } from '../api.js';
import { el, icon, openSheet, toast, errorState } from '../ui.js';
import { t, setLang } from '../i18n.js';
import { store } from '../store.js';

const SELECTED_KEY = 'hc:profile';

function readSelected() {
  try { return JSON.parse(localStorage.getItem(SELECTED_KEY) || 'null'); } catch { return null; }
}

function writeSelected(p) {
  try {
    if (p) localStorage.setItem(SELECTED_KEY, JSON.stringify({ id: p.id, name: p.name, language: p.language }));
    else localStorage.removeItem(SELECTED_KEY);
  } catch {}
}

// A profile tile: the initial-letter avatar the Profile screen already
// uses, plus the name. `editing` turns the tap into the edit sheet.
function profileTile(p, onOpen) {
  const current = readSelected();
  const isCurrent = current && Number(current.id) === Number(p.id);
  const ring = isCurrent ? ' ring-2 ring-focus' : '';
  const tile = el(
    '<button type="button" class="flex min-h-11 w-20 flex-col items-center gap-1.5" data-profile-id="' + p.id + '">' +
      '<span class="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-heading text-on-accent' + ring + '">' +
        p.name.charAt(0).toUpperCase() + '</span>' +
      '<span class="max-w-20 truncate text-small text-fg">' + p.name + '</span>' +
      (isCurrent ? '<span class="text-small text-muted">' + t('profiles.current') + '</span>' : '') +
    '</button>'
  );
  tile.addEventListener('click', () => onOpen(p));
  return tile;
}

// The add/edit form in a bottom sheet. While editing, a quiet Delete row
// sits under the form; it refuses to remove the last profile (the server
// answers profile_last, the client shows the same words).
function profileForm(p, onChange) {
  const editing = !!p;
  let lang = (p && p.language) || 'system';
  const langSeg = el(
    '<div class="hc-segment w-full">' +
      '<button type="button" data-v="system" aria-pressed="' + (lang === 'system') + '">' + t('profile.langAuto') + '</button>' +
      '<button type="button" data-v="en" aria-pressed="' + (lang === 'en') + '">English</button>' +
      '<button type="button" data-v="id" aria-pressed="' + (lang === 'id') + '">Bahasa Indonesia</button>' +
    '</div>'
  );
  const err = el('<p class="text-small text-muted" hidden></p>');
  const sheetContent = el('<div class="flex flex-col gap-3 p-4"></div>');
  sheetContent.appendChild(el(
    '<div class="flex items-center justify-between">' +
      '<h2 class="text-heading">' + (editing ? t('profiles.edit') : t('profiles.add')) + '</h2>' +
      '<button type="button" class="hc-iconbtn" data-cancel aria-label="' + t('profiles.cancel') + '">' + icon('chevronLeft') + '</button>' +
    '</div>'
  ));
  sheetContent.appendChild(el(
    '<label class="block"><span class="mb-1 block text-small text-muted">' + t('profiles.name') + '</span>' +
      '<input class="field" data-name maxlength="40" placeholder="' + t('profiles.namePh') + '" value="' +
      (editing ? p.name.replace(/"/g, '&quot;') : '') + '"></label>'
  ));
  sheetContent.appendChild(el('<span class="text-small text-muted">' + t('profiles.language') + '</span>'));
  sheetContent.appendChild(langSeg);
  sheetContent.appendChild(err);
  const save = el('<button type="button" class="btn-primary">' + t('profiles.save') + '</button>');
  sheetContent.appendChild(save);

  const sheet = openSheet(sheetContent, { label: editing ? t('profiles.edit') : t('profiles.add') });
  sheetContent.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  langSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      lang = b.dataset.v;
      langSeg.querySelectorAll('button').forEach((x) =>
        x.setAttribute('aria-pressed', String(x === b)));
    });
  });

  const saveIt = async () => {
    const name = (sheetContent.querySelector('[data-name]').value || '').trim();
    if (!name || name.length > 40) {
      err.hidden = false;
      err.textContent = t('profiles.nameRequired');
      return;
    }
    err.hidden = true;
    save.disabled = true;
    try {
      const r = editing
        ? await api('/api/profiles/' + p.id, { method: 'PATCH', body: { name, language: lang } })
        : await api('/api/profiles', { method: 'POST', body: { name, language: lang } });
      sheet.close();
      onChange(r.profile);
    } catch (e) {
      err.hidden = false;
      err.textContent = e.code === 'profile_taken' ? t('profiles.nameTaken') : t('common.errorBody');
      save.disabled = false;
    }
  };
  save.addEventListener('click', saveIt);

  if (editing) {
    const del = el('<button type="button" class="btn-secondary mt-1">' + t('profiles.delete') + '</button>');
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {
        await api('/api/profiles/' + p.id, { method: 'DELETE' });
        if (readSelected() && Number(readSelected().id) === Number(p.id)) writeSelected(null);
        sheet.close();
        onChange(null);
      } catch (e) {
        del.disabled = false;
        toast(e.code === 'profile_last' ? t('profiles.deleteLast') : t('common.errorBody'));
      }
    });
    sheetContent.appendChild(del);
  }
}

export async function render({ view, query }) {
  view.innerHTML = '';
  view.appendChild(el(
    '<div class="mb-4 flex items-center gap-2">' +
      '<a class="hc-iconbtn" data-nav href="/profile" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</a>' +
      '<h1 class="text-title">' + t('profiles.title') + '</h1>' +
    '</div>'
  ));

  const me = store.me || { user: null, guest: false };
  if (!me.user) {
    // Guests cannot have profiles: the same sign-in card the Profile
    // screen shows.
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
    return;
  }

  const demoParam = query.get('demo') === '1' ? '?demo=1' : '';
  const body = el('<div></div>');
  view.appendChild(body);

  let profiles;
  try {
    profiles = (await api('/api/profiles' + demoParam)).profiles;
  } catch (e) {
    body.appendChild(errorState(() => render({ view, query })));
    return;
  }
  body.innerHTML = '';

  if (demoParam) {
    body.appendChild(el(
      '<p class="mb-3 rounded-lg border border-line bg-raised px-3 py-2 text-center text-small text-muted" data-usernode-demo-note>' +
        t('demo.note') + '</p>'
    ));
  }

  if (!profiles.length) {
    body.appendChild(el(
      '<div class="state-empty"><p class="text-heading">' + t('profiles.empty') + '</p>' +
        '<p class="text-body text-muted">' + t('profiles.emptyBody') + '</p>' +
        '<p class="text-small text-muted">' + t('profiles.cap') + '</p>' +
      '</div>'
    ));
    const addBtn = el('<button type="button" class="btn-primary mt-2">' + t('profiles.add') + '</button>');
    addBtn.addEventListener('click', () => profileForm(null, () => render({ view, query })));
    body.appendChild(addBtn);
    return;
  }

  const reload = () => render({ view, query });

  const openProfile = (p) => {
    if (manage) {
      profileForm(p, reload);
      return;
    }
    writeSelected(p);
    if (p.language && p.language !== 'system') setLang(p.language);
    toast(t('profiles.selected', { name: p.name }));
  };

  const grid = el('<div class="flex flex-wrap gap-3"></div>');
  for (const p of profiles) grid.appendChild(profileTile(p, openProfile));
  body.appendChild(el('<p class="section-label">' + t('profiles.who') + '</p>'));
  body.appendChild(grid);

  // Add: a quiet tile beside the profiles while there is room for one.
  if (profiles.length < 5) {
    const addTile = el(
      '<button type="button" class="flex min-h-11 w-20 flex-col items-center gap-1.5" data-add-profile>' +
        '<span class="flex h-14 w-14 items-center justify-center rounded-full border border-line bg-raised text-muted">' +
          icon('plus', 'h-6 w-6') + '</span>' +
        '<span class="text-small text-muted">' + t('profiles.add') + '</span>' +
      '</button>'
    );
    addTile.addEventListener('click', () => profileForm(null, reload));
    grid.appendChild(addTile);
  }

  // Manage: while it is on, tapping a profile opens its form (with Delete
  // inside) instead of selecting it.
  let manage = false;
  const manageBtn = el('<button type="button" class="btn-secondary mt-4" aria-pressed="false">' + t('profiles.edit') + '</button>');
  manageBtn.addEventListener('click', () => {
    manage = !manage;
    manageBtn.setAttribute('aria-pressed', String(manage));
  });
  body.appendChild(manageBtn);
}

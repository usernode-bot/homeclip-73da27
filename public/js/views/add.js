// Add a drama: a form that adds a drama to the shared drama tracker
// (POST /api/tracker/dramas, the same rules the tracker's own Add drama
// sheet enforces). Reached from the Profile screen; the tracker feed
// lives on its own screen at /tracker.

import { api, askForAccount } from '../api.js';
import { el, icon, toast } from '../ui.js';
import { t } from '../i18n.js';
import { store } from '../store.js';

export async function render({ view }) {
  view.innerHTML = '';
  view.appendChild(el(
    '<div class="mb-4 flex items-center gap-2">' +
      '<a class="hc-iconbtn" data-nav href="/profile" aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</a>' +
      '<h1 class="text-title">' + t('add.title') + '</h1>' +
    '</div>'
  ));

  const me = store.me || { user: null, guest: false };

  view.appendChild(el(
    '<p class="mb-4 text-body text-muted">' + t('add.body') + '</p>'
  ));

  if (!me.user) {
    // Guests cannot add; the same sign-in card the Profile screen shows.
    const guestCard = el(
      '<div class="rounded-xl border border-line bg-surface p-4">' +
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

  const form = el('<form class="flex flex-col gap-3" novalidate></form>');
  form.appendChild(el(
    '<label class="block"><span class="mb-1 block text-small text-muted">' + t('add.name') + '</span>' +
      '<input class="field" data-title maxlength="80" placeholder="' + t('add.namePh') + '"></label>'
  ));
  form.appendChild(el(
    '<label class="block"><span class="mb-1 block text-small text-muted">' + t('add.synopsis') + '</span>' +
      '<textarea class="field" data-synopsis rows="3" maxlength="280" placeholder="' + t('add.synopsisPh') + '"></textarea></label>'
  ));
  const row1 = el('<div class="grid grid-cols-2 gap-3"></div>');
  row1.appendChild(el(
    '<label class="block"><span class="mb-1 block text-small text-muted">' + t('add.year') + '</span>' +
      '<input class="field" data-year inputmode="numeric" placeholder="' + t('add.yearPh') + '"></label>'
  ));
  row1.appendChild(el(
    '<label class="block"><span class="mb-1 block text-small text-muted">' + t('add.country') + '</span>' +
      '<input class="field" data-country maxlength="60" placeholder="' + t('add.countryPh') + '"></label>'
  ));
  form.appendChild(row1);
  form.appendChild(el(
    '<label class="block"><span class="mb-1 block text-small text-muted">' + t('add.genres') + '</span>' +
      '<input class="field" data-genres placeholder="' + t('add.genresPh') + '"></label>'
  ));
  form.appendChild(el(
    '<label class="block"><span class="mb-1 block text-small text-muted">' + t('add.poster') + '</span>' +
      '<input class="field" data-poster type="url" placeholder="' + t('add.posterPh') + '"></label>'
  ));
  const err = el('<p class="text-small text-muted" hidden></p>');
  form.appendChild(err);
  const submit = el('<button type="submit" class="btn-primary">' + t('add.submit') + '</button>');
  form.appendChild(submit);
  view.appendChild(form);

  // Success: a quiet confirmation with the way into the tracker, where
  // the drama now lives. The form resets for the next one.
  const done = el('<div class="mt-4" hidden></div>');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const title = form.querySelector('[data-title]').value.trim();
    if (!title || title.length > 80) {
      err.hidden = false;
      err.textContent = t('add.titleRequired');
      return;
    }
    const yearRaw = form.querySelector('[data-year]').value.trim();
    const year = yearRaw === '' ? null : parseInt(yearRaw, 10);
    if (year !== null && (isNaN(year) || year < 1900 || year > 2100)) {
      err.hidden = false;
      err.textContent = t('add.year') + ': 1900 - 2100';
      return;
    }
    submit.disabled = true;
    try {
      const r = await api('/api/tracker/dramas', {
        method: 'POST',
        body: {
          title,
          synopsis: form.querySelector('[data-synopsis]').value.trim(),
          year,
          country: form.querySelector('[data-country]').value.trim(),
          genres: form.querySelector('[data-genres]').value,
          poster_url: form.querySelector('[data-poster]').value.trim(),
        },
      });
      form.reset();
      submit.disabled = false;
      toast(t('add.added'));
      done.innerHTML = '';
      // A full-page link: /tracker is the tracker page with its own
      // hash router, not a catalog route.
      const link = el('<a class="btn-secondary" href="/tracker#/drama/' + r.drama.id + '">' +
        t('add.viewInTracker') + '</a>');
      done.appendChild(link);
      done.hidden = false;
      view.appendChild(done);
    } catch (e2) {
      if (e2.code === 'account_required') return; // the bridge sheet is up
      err.hidden = false;
      err.textContent = e2.message || t('common.errorBody');
      submit.disabled = false;
    }
  });
}

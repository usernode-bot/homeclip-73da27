// Page not found: the catch-all view for paths no route matches. Renders no
// data, so there is no loading state — just the way back.

import { el } from '../ui.js';
import { t } from '../i18n.js';

export async function render({ view }) {
  view.innerHTML = '';
  view.appendChild(el(
    '<div class="state-empty"><p class="text-heading">' + t('notfound.title') + '</p>' +
      '<p class="text-body text-muted">' + t('notfound.body') + '</p>' +
      '<a class="btn-primary mt-2" data-nav href="/">' + t('notfound.home') + '</a></div>'
  ));
}

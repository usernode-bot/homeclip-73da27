// HomeClip client. Path-routed views over the JSON API in server.js.
// The client never decides VIP access itself: every payload it renders is
// already gated by the server (locked VIP episodes arrive without a watch
// URL; ad episodes arrive with requiresAd, which VIP users never get).
(function () {
  'use strict';

  const view = document.getElementById('view');
  const vipButton = document.getElementById('vip-button');

  // The shell injects the platform token as ?token= on load; after that it
  // rides in a header so internal navigation can drop it from the URL.
  const TOKEN = new URLSearchParams(location.search).get('token')
    || (window.usernode && window.usernode.token) || '';

  let timer = null;
  let renderSeq = 0;

  /* ── Small helpers ────────────────────────────────────────────────────── */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  // Whole rupiah with dot separators, e.g. Rp 59.000. Done by hand so the
  // format is the same whatever Intl data the browser carries.
  const idr = (n) => 'Rp ' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  async function api(path, opts) {
    opts = opts || {};
    const headers = {};
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    if (window.usernode && window.usernode.previewNow) {
      headers['x-usernode-now'] = window.usernode.now().toISOString();
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const err = new Error(data.message || data.error || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const svg = (inner, cls) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${cls || 'h-5 w-5'}" aria-hidden="true">${inner}</svg>`;
  const LOCK = svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 'h-3.5 w-3.5');
  const TICK = svg('<path d="M5 12l4 4L19 6"/>', 'h-4 w-4');
  const PLAY = svg('<path d="M7 5l12 7-12 7z"/>', 'h-4 w-4');
  const PLUS = svg('<path d="M12 5v14M5 12h14"/>', 'h-4 w-4');
  const CHECKED = svg('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>', 'h-6 w-6');
  const UNCHECKED = svg('<circle cx="12" cy="12" r="9"/>', 'h-6 w-6');

  const POSTER = {
    accent: 'background:rgb(var(--accent))',
    fg: 'background:rgb(var(--fg))',
    muted: 'background:rgb(var(--muted))',
    raised: 'background:rgb(var(--raised))',
  };
  const posterStyle = (token) => POSTER[token] || POSTER.accent;

  function accessChip(access) {
    if (access === 'vip') return `<span class="chip chip-vip">${LOCK}VIP</span>`;
    if (access === 'ads') return '<span class="chip chip-soft">Free with ads</span>';
    return '<span class="chip chip-soft">Free</span>';
  }

  function statusChip(status) {
    if (status === 'active') return '<span class="chip chip-vip">Active</span>';
    return `<span class="chip chip-soft">${status === 'canceled' ? 'Canceled' : 'Expired'}</span>`;
  }

  function paymentStatusChip(status) {
    const label = { paid: 'Paid', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' }[status] || status;
    if (status === 'paid') return `<span class="chip chip-vip">${label}</span>`;
    return `<span class="chip chip-soft">${esc(label)}</span>`;
  }

  function skeletonList() {
    return `<ul class="list" aria-hidden="true">
      ${[0, 1, 2, 3].map(() => `<li class="list-row"><div class="h-12 w-12 flex-none rounded-md skeleton"></div><div class="flex min-w-0 grow flex-col gap-2"><div class="h-4 w-1/2 rounded skeleton"></div><div class="h-3 w-1/3 rounded skeleton"></div></div></li>`).join('')}
    </ul>`;
  }

  function errorState(message, detail) {
    return `<section class="state-error">
      <p class="text-body font-medium">${esc(message)}</p>
      <p class="text-small text-muted">${esc(detail || 'You can retry — nothing else in the app is affected.')}</p>
      <button id="retry" class="btn-secondary">Retry</button>
    </section>`;
  }

  function emptyState(title, detail, linkHtml) {
    return `<section class="state-empty">
      <p class="text-body font-medium">${esc(title)}</p>
      <p class="text-small text-muted">${esc(detail)}</p>
      ${linkHtml || ''}
    </section>`;
  }

  function renderError(err, what) {
    const accountNeeded = err.status === 401 && err.data && err.data.error === 'account_required';
    view.innerHTML = errorState(
      accountNeeded ? 'Make an account to continue' : (what || 'Something went wrong'),
      accountNeeded
        ? 'Browsing works without one; this action needs a Homeroom account.'
        : 'The load failed. You can retry — nothing else in the app is affected.'
    );
    const r = document.getElementById('retry');
    if (r) r.addEventListener('click', () => render());
  }

  /* ── Navigation ───────────────────────────────────────────────────────── */

  function navigate(path) {
    history.pushState({}, '', path);
    render();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });

  window.addEventListener('popstate', () => render());

  function updateHeader(sub) {
    vipButton.textContent = sub.vip ? 'Manage' : 'VIP';
    vipButton.setAttribute('href', sub.vip ? '/vip/manage' : '/vip');
  }

  /* ── Home ─────────────────────────────────────────────────────────────── */

  async function viewHome(sub) {
    let data;
    try { data = await api('/api/feed'); } catch (err) { return renderError(err, 'The drama feed could not load'); }

    const parts = [];
    parts.push(`<div class="flex items-center justify-between gap-2">
      <button id="add-drama-toggle" class="btn-secondary">${PLUS} Add drama</button>
      ${sub.vip ? `<a data-link href="/vip" class="chip chip-vip no-underline">${LOCK}VIP</a>` : ''}
    </div>
    <section id="add-drama-form" class="card flex flex-col gap-3" hidden>
      <h2 class="text-heading">Add a drama</h2>
      <label class="flex flex-col gap-1 text-small text-muted">Title
        <input id="drama-title" class="field" placeholder="e.g. Harbour Lights">
      </label>
      <label class="flex flex-col gap-1 text-small text-muted">Short description (optional)
        <input id="drama-desc" class="field" placeholder="e.g. A ferry town keeps its secrets">
      </label>
      <p id="drama-error" class="text-small text-muted" hidden></p>
      <button id="drama-save" class="btn-primary self-start">Add drama</button>
    </section>`);

    if (data.hero) {
      const he = data.hero.episode;
      const pct = data.hero.seasonTotal ? Math.round(data.hero.watchedInSeason * 100 / data.hero.seasonTotal) : 0;
      parts.push(`<div>
        <h2 class="section-label">Next to watch</h2>
        <section class="card p-3">
          <div class="flex flex-col justify-end gap-2 rounded-xl border-4 border-fg bg-accent p-4 text-on-accent" style="min-height:9.5rem">
            <div class="flex items-center justify-between gap-2">
              <span class="text-small font-medium">${esc(data.hero.dramaTitle)}, Season ${data.hero.seasonNumber}</span>
              ${he.access === 'vip' ? `<span class="chip chip-vip">${LOCK}VIP</span>` : ''}
            </div>
            <div class="text-heading">Episode ${he.number}: ${esc(he.title)}</div>
            <div class="h-1 w-full rounded bg-on-accent/30"><div class="h-1 rounded bg-on-accent" style="width:${pct}%"></div></div>
          </div>
          <div class="mt-3 flex items-center justify-between gap-2">
            <span class="text-small text-muted">${data.hero.watchedInSeason} of ${data.hero.seasonTotal} watched this season${he.durationMin ? ' · ' + he.durationMin + ' min' : ''}</span>
            <a data-link href="/drama/${data.hero.dramaId}/episode/${he.id}" class="btn-primary">${PLAY} Watch</a>
          </div>
        </section>
      </div>`);
      if (data.hero.upNext.length) {
        parts.push(`<div>
          <h2 class="section-label">Continue this season</h2>
          <div class="flex gap-3 overflow-x-auto pb-1">
            ${data.hero.upNext.map((e) => `<a data-link href="/drama/${data.hero.dramaId}/episode/${e.id}" class="flex w-32 flex-none flex-col gap-1 no-underline text-fg">
              <span class="flex h-20 items-end rounded-lg border-4 border-fg bg-raised p-2 text-small font-semibold">${e.locked ? `<span class="text-accent">${LOCK}</span>` : 'Ep ' + e.number}</span>
              <span class="text-small">${esc(e.title)}</span>
            </a>`).join('')}
          </div>
        </div>`);
      }
    }

    parts.push('<div>');
    parts.push('<h2 class="section-label">Drama feed</h2>');
    if (!data.dramas.length) {
      parts.push(emptyState('No dramas yet', 'Add the first drama the homeroom will watch together.'));
    } else {
      parts.push(`<ul class="list">
        ${data.dramas.map((d) => `<li class="list-row">
          <a data-link href="/drama/${d.id}" class="flex min-w-0 grow items-center gap-3 no-underline text-fg">
            <span class="h-12 w-12 flex-none rounded-md" style="${posterStyle(d.posterToken)}"></span>
            <span class="flex min-w-0 grow flex-col gap-1">
              <span class="font-semibold">${esc(d.title)}</span>
              <span class="text-small text-muted">${d.seasonsCount} season${d.seasonsCount === 1 ? '' : 's'}, ${d.episodesCount} episode${d.episodesCount === 1 ? '' : 's'}${d.watchedCount ? ' · ' + d.watchedCount + ' watched' : ''}</span>
              <span>${accessChip(d.accessLabel === 'VIP' ? 'vip' : (d.accessLabel === 'Free with ads' ? 'ads' : 'free'))}</span>
            </span>
          </a>
          <button data-follow="${d.id}" data-following="${d.following ? '1' : ''}" class="btn-secondary ${d.following ? 'border-accent text-accent' : ''}">${d.following ? 'Following' : 'Follow'}</button>
        </li>`).join('')}
      </ul>`);
    }
    parts.push('</div>');

    view.innerHTML = parts.join('');
    bindAddDrama();
    bindFollowButtons();
  }

  function bindAddDrama() {
    const toggle = document.getElementById('add-drama-toggle');
    const form = document.getElementById('add-drama-form');
    if (!toggle || !form) return;
    toggle.addEventListener('click', () => { form.hidden = !form.hidden; });
    const save = document.getElementById('drama-save');
    save.addEventListener('click', async () => {
      const msg = document.getElementById('drama-error');
      msg.hidden = true;
      try {
        const out = await api('/api/dramas', { method: 'POST', body: {
          title: document.getElementById('drama-title').value,
          description: document.getElementById('drama-desc').value,
        } });
        navigate('/drama/' + out.id);
      } catch (err) {
        msg.textContent = err.status === 401
          ? 'Make an account to add a drama.'
          : 'The drama could not be added. Check the title and try again.';
        msg.hidden = false;
      }
    });
  }

  function bindFollowButtons() {
    view.querySelectorAll('[data-follow]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-follow'));
        const following = Boolean(btn.getAttribute('data-following'));
        try {
          await api('/api/follow', { method: 'POST', body: { dramaId: id, follow: !following } });
          btn.setAttribute('data-following', following ? '' : '1');
          btn.textContent = following ? 'Follow' : 'Following';
          btn.classList.toggle('border-accent', !following);
          btn.classList.toggle('text-accent', !following);
        } catch (err) {
          if (err.status === 401) { msg401(); return; }
          console.warn('follow failed', err);
        }
      });
    });
  }

  function msg401() {
    const p = document.createElement('p');
    p.className = 'text-small text-muted';
    p.textContent = 'Make an account to continue.';
    view.appendChild(p);
  }

  /* ── Drama detail ─────────────────────────────────────────────────────── */

  async function viewDrama(sub, _seq, dramaId) {
    let data;
    try { data = await api('/api/dramas/' + dramaId); } catch (err) {
      return renderError(err, err.status === 404 ? 'Drama not found' : 'The drama could not load');
    }

    const d = data.drama;
    const parts = [];
    parts.push(`<a data-link href="/" class="btn-secondary self-start">Back</a>
    <section class="card flex gap-4">
      <span class="h-20 w-20 flex-none rounded-lg" style="${posterStyle(d.posterToken)}"></span>
      <div class="flex min-w-0 grow flex-col gap-1">
        <h1 class="text-title">${esc(d.title)}</h1>
        <p class="text-small text-muted">${esc(d.description || '')}${d.addedBy ? ' Added by ' + esc(d.addedBy) + '.' : ''}</p>
        <button id="follow-btn" class="self-start ${data.following ? 'border-accent text-accent ' : ''}btn-secondary">${data.following ? 'Following' : 'Follow'}</button>
      </div>
    </section>
    <h2 class="section-label">Episodes</h2>`);

    if (!data.seasons.some((s) => s.episodes.length)) {
      parts.push(emptyState('No episodes yet', 'Add the first episode with the button below.'));
    } else {
      data.seasons.forEach((s) => {
        if (!s.episodes.length) return;
        parts.push(`<div>
          <h3 class="section-label">Season ${s.number}</h3>
          <ul class="list">
            ${s.episodes.map((e) => `<li class="list-row">
              <a data-link href="/drama/${dramaId}/episode/${e.id}" class="flex min-w-0 grow items-center gap-3 no-underline text-fg">
                <span class="flex h-10 w-14 flex-none items-center justify-center rounded-md border-2 bg-raised text-small font-semibold ${e.locked ? 'border-accent text-accent' : 'border-fg'}">${e.locked ? LOCK : 'Ep ' + e.number}</span>
                <span class="flex min-w-0 grow flex-col">
                  <span class="font-semibold">${esc(e.title)}</span>
                  <span class="text-small text-muted">${e.durationMin ? e.durationMin + ' min' : ''}${e.watched ? ', watched' : ''}</span>
                </span>
              </a>
              ${accessChip(e.access)}
              ${e.locked ? '' : `<button data-toggle-watch="${e.id}" data-watched="${e.watched ? '1' : ''}" aria-label="${e.watched ? 'Mark unwatched' : 'Mark watched'}" class="flex h-11 w-11 flex-none items-center justify-center rounded-lg ${e.watched ? 'text-accent' : 'text-muted'}">${e.watched ? CHECKED : UNCHECKED}</button>`}
            </li>`).join('')}
          </ul>
        </div>`);
      });
    }

    parts.push(`<section id="add-episode-form" class="card flex flex-col gap-3" hidden>
      <h2 class="text-heading">Add an episode</h2>
      <label class="flex flex-col gap-1 text-small text-muted">Title
        <input id="ep-title" class="field" placeholder="e.g. The Tide Table">
      </label>
      <label class="flex flex-col gap-1 text-small text-muted">Length in minutes
        <input id="ep-duration" class="field" inputmode="numeric" placeholder="e.g. 52">
      </label>
      <label class="flex flex-col gap-1 text-small text-muted">Where to watch (optional link)
        <input id="ep-url" class="field" placeholder="https:// (opens in a new tab)">
      </label>
      <label class="flex flex-col gap-1 text-small text-muted">Who can watch it
        <select id="ep-access" class="field">
          <option value="free">Free</option>
          <option value="vip">VIP</option>
          <option value="ads">Free with ads</option>
        </select>
      </label>
      <p id="ep-error" class="text-small text-muted" hidden></p>
      <button id="ep-save" class="btn-primary self-start">Add episode</button>
    </section>
    <button id="add-episode-toggle" class="btn-secondary self-start">${PLUS} Add episode</button>`);

    view.innerHTML = parts.join('');

    const followBtn = document.getElementById('follow-btn');
    followBtn.addEventListener('click', async () => {
      const following = !data.following;
      try {
        await api('/api/follow', { method: 'POST', body: { dramaId, follow: following } });
        data.following = following;
        followBtn.textContent = following ? 'Following' : 'Follow';
        followBtn.classList.toggle('border-accent', following);
        followBtn.classList.toggle('text-accent', following);
      } catch (err) {
        if (err.status === 401) { msg401(); return; }
        console.warn('follow failed', err);
      }
    });

    view.querySelectorAll('[data-toggle-watch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-toggle-watch'));
        const watched = Boolean(btn.getAttribute('data-watched'));
        try {
          if (watched) await api('/api/watch', { method: 'DELETE', body: { episodeId: id } });
          else await api('/api/watch', { method: 'POST', body: { episodeId: id } });
          render();
        } catch (err) {
          if (err.status === 401) { msg401(); return; }
          if (err.status === 403) { render(); return; } // VIP lapsed server-side
          console.warn('watch failed', err);
        }
      });
    });

    const epToggle = document.getElementById('add-episode-toggle');
    const epForm = document.getElementById('add-episode-form');
    epToggle.addEventListener('click', () => { epForm.hidden = !epForm.hidden; });
    document.getElementById('ep-save').addEventListener('click', async () => {
      const msg = document.getElementById('ep-error');
      msg.hidden = true;
      try {
        await api('/api/episodes', { method: 'POST', body: {
          dramaId,
          title: document.getElementById('ep-title').value,
          durationMin: Number(document.getElementById('ep-duration').value) || null,
          watchUrl: document.getElementById('ep-url').value,
          access: document.getElementById('ep-access').value,
        } });
        render();
      } catch (err) {
        msg.textContent = err.status === 401
          ? 'Make an account to add an episode.'
          : 'The episode could not be added. Check the fields and try again.';
        msg.hidden = false;
      }
    });
  }

  /* ── Episode view: paywall, pre-roll ad, or watch card ─────────────────── */

  const PERKS = ['No ads', 'Early access', 'HD and 4K', 'Offline download'];
  const perkItem = (label) => `<li class="flex items-center gap-2 text-body"><span class="text-accent">${TICK}</span>${esc(label)}</li>`;

  async function viewEpisode(sub, _seq, dramaId, episodeId) {
    let data;
    try { data = await api('/api/dramas/' + dramaId); } catch (err) {
      return renderError(err, err.status === 404 ? 'Drama not found' : 'The episode could not load');
    }
    let ep = null;
    data.seasons.forEach((s) => {
      const found = s.episodes.find((e) => e.id === episodeId);
      if (found) ep = found;
    });
    if (!ep) { view.innerHTML = errorState('Episode not found'); bindRetry(); return; }

    if (ep.locked) {
      // Server-side paywall: this payload has no watch URL and the server
      // refuses the watch write for it.
      view.innerHTML = `<a data-link href="/drama/${dramaId}" class="btn-secondary self-start">Back</a>
      <section class="card flex flex-col items-start gap-3">
        <span class="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent">${svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 'h-6 w-6')}</span>
        <h1 class="text-heading">This episode is for VIP members</h1>
        <p class="text-body text-muted">${esc(data.drama.title)} · Season ${ep.seasonNumber}, Episode ${ep.number}: ${esc(ep.title)}${ep.durationMin ? ' · ' + ep.durationMin + ' min' : ''}. Subscribe to watch it, or keep going with the free episodes.</p>
        <ul class="flex flex-col gap-2">${PERKS.map(perkItem).join('')}</ul>
        <a data-link href="/vip" class="btn-primary w-full">See VIP plans</a>
        <p class="text-small text-muted">From Rp 59.000, cancel any time.</p>
        <a data-link href="/drama/${dramaId}" class="btn-secondary w-full">Not now</a>
      </section>`;
      return;
    }

    const adSlot = ep.requiresAd
      ? `<section id="ad-slot" class="card flex flex-col gap-3">
          <span class="chip chip-soft self-start">Sponsored</span>
          <div class="flex h-40 items-center justify-center rounded-lg bg-raised text-center text-small text-muted">An ad would play here. Your video starts in <span id="ad-count" class="mx-1 font-semibold">5</span>s</div>
          <a data-link href="/vip" class="text-small font-medium text-accent underline">Go VIP to skip ads</a>
        </section>`
      : '';
    const watchedLine = ep.watched ? '<span class="chip chip-vip">Watched</span>' : '';

    view.innerHTML = `<a data-link href="/drama/${dramaId}" class="btn-secondary self-start">Back</a>
    ${adSlot}
    <section id="watch-slot" class="card flex flex-col gap-3" ${ep.requiresAd ? 'hidden' : ''}>
      <h1 class="text-heading">Episode ${ep.number}: ${esc(ep.title)}</h1>
      <p class="text-body text-muted">${esc(data.drama.title)} · Season ${ep.seasonNumber}${ep.durationMin ? ' · ' + ep.durationMin + ' min' : ''}</p>
      ${watchedLine}
      <button id="watch-btn" class="btn-primary self-start">${PLAY} ${ep.watched ? 'Watched — watch again' : 'Watch'}</button>
      <p class="text-small text-muted">${ep.watchUrl ? 'Watch marks it watched and opens the episode page in a new tab.' : 'Watch marks it watched.'}</p>
    </section>`;

    if (ep.requiresAd) {
      let left = 5;
      const countEl = document.getElementById('ad-count');
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(timer);
          timer = null;
          const ad = document.getElementById('ad-slot');
          const slot = document.getElementById('watch-slot');
          if (ad) ad.remove();
          if (slot) slot.hidden = false;
        } else if (countEl) {
          countEl.textContent = String(left);
        }
      }, 1000);
    }

    const btn = document.getElementById('watch-btn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const out = await api('/api/watch', { method: 'POST', body: { episodeId } });
        if (out.episode && out.episode.watchUrl) window.open(out.episode.watchUrl, '_blank', 'noopener');
        render();
      } catch (err) {
        btn.disabled = false;
        if (err.status === 403) { render(); return; } // paywall (subscription lapsed)
        if (err.status === 401) { msg401(); return; }
        console.warn('watch failed', err);
      }
    });
  }

  function bindRetry() {
    const r = document.getElementById('retry');
    if (r) r.addEventListener('click', () => render());
  }

  /* ── VIP page ─────────────────────────────────────────────────────────── */

  const round100 = (n) => Math.round(n / 100) * 100;

  async function viewVip(sub) {
    let plansData;
    try { plansData = await api('/api/plans'); } catch (err) { return renderError(err, 'The plans could not load'); }

    const parts = [];
    parts.push(`<section class="card flex flex-col gap-2">
      <h1 class="text-title">HomeClip VIP</h1>
      <p class="text-body text-muted">Watch everything, ad-free.</p>
      <ul class="flex flex-col gap-2">${PERKS.map((p) => perkItem(p === 'Early access' ? 'Early access to new episodes' : (p === 'No ads' ? 'No ads on any episode' : p))).join('')}</ul>
    </section>`);

    if (sub.vip) {
      parts.push(`<section class="card flex flex-col gap-2">
        <div class="flex items-center gap-2"><span class="chip chip-vip">${LOCK}VIP</span><span class="font-semibold">You're a VIP member</span></div>
        <p class="text-small text-muted">${esc(sub.plan ? sub.plan.name : '')} · ${sub.status === 'canceled' ? 'VIP until ' : 'Renews on '}${sub.renewalDate ? fmtDate(sub.renewalDate) : ''}</p>
        <a data-link href="/vip/manage" class="btn-secondary self-start">Manage subscription</a>
      </section>`);
      view.innerHTML = parts.join('');
      return;
    }

    let selected = 'monthly';
    let coupon = null; // { code, discountIdr, amountIdr } after a successful Apply

    const planById = (id) => plansData.plans.find((x) => x.id === id) || { priceIdr: 0 };
    const subscribeLabel = () => 'Subscribe · ' + idr(coupon ? coupon.amountIdr : planById(selected).priceIdr);

    parts.push('<div>');
    parts.push('<h2 class="section-label">Plans</h2>');
    parts.push(`<div id="plans" class="flex flex-col gap-2">
      ${plansData.plans.map((p) => {
        const subtitle = p.id === 'monthly'
          ? 'Billed every month'
          : `${idr(round100(p.perMonthIdr))} per month${p.save ? ' · save ' + p.save + '%' : ''}`;
        return `<button data-plan="${p.id}" class="flex items-center gap-3 rounded-xl border bg-surface p-4 text-left ${p.id === selected ? 'border-accent ring-2 ring-accent' : 'border-line'}">
          <span class="h-5 w-5 flex-none rounded-full border-2 ${p.id === selected ? 'border-accent bg-accent' : 'border-line'}"></span>
          <span class="flex min-w-0 grow flex-col">
            <span class="font-semibold">${esc(p.name)}</span>
            <span class="text-small text-muted">${esc(subtitle)}</span>
          </span>
          <span class="font-bold">${idr(p.priceIdr)}</span>
        </button>`;
      }).join('')}
    </div>
    <h2 class="section-label mt-4">Coupon</h2>
    <div class="flex gap-2">
      <input id="coupon" class="field" placeholder="e.g. STAGE10" aria-label="Coupon code">
      <button id="coupon-apply" class="btn-secondary">Apply</button>
    </div>
    <p id="coupon-msg" class="text-small text-muted" hidden></p>
    </div>
    <div class="flex flex-col gap-2">
      <button id="subscribe" class="btn-primary">${subscribeLabel()}</button>
      ${plansData.paymentConfigured
        ? `<p class="text-small text-muted">You'll finish payment on ${esc(providerName(plansData.provider))}'s secure page. No card details ever reach HomeClip.</p>`
        : `<p class="text-small text-muted">Payment isn't set up in this environment yet, so subscribing is off for now. Plans and prices show as they will be.</p>`}
    </div>`);

    view.innerHTML = parts.join('');
    if (!plansData.paymentConfigured) return;

    view.querySelectorAll('[data-plan]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected = btn.getAttribute('data-plan');
        coupon = null;
        const msg = document.getElementById('coupon-msg');
        msg.hidden = true;
        view.querySelectorAll('[data-plan]').forEach((b) => {
          const on = b.getAttribute('data-plan') === selected;
          b.classList.toggle('border-accent', on);
          b.classList.toggle('ring-2', on);
          b.classList.toggle('ring-accent', on);
          b.classList.toggle('border-line', !on);
          const dot = b.querySelector('span');
          dot.className = on
            ? 'h-5 w-5 flex-none rounded-full border-2 border-accent bg-accent'
            : 'h-5 w-5 flex-none rounded-full border-2 border-line';
        });
        document.getElementById('subscribe').textContent = subscribeLabel();
      });
    });

    document.getElementById('coupon-apply').addEventListener('click', async () => {
      const msg = document.getElementById('coupon-msg');
      msg.hidden = true;
      try {
        const out = await api('/api/coupon/validate', { method: 'POST', body: {
          planId: selected, couponCode: document.getElementById('coupon').value,
        } });
        coupon = out;
        msg.textContent = 'Coupon ' + out.code + ' applied — you pay ' + idr(out.amountIdr) + '.';
        msg.hidden = false;
      } catch (err) {
        const words = {
          coupon_invalid: "That code doesn't work.",
          coupon_expired: 'That code has expired.',
          coupon_used_up: "That code has no uses left.",
        };
        coupon = null;
        msg.textContent = words[err.data && err.data.error] || "That code doesn't work.";
        msg.hidden = false;
      }
      document.getElementById('subscribe').textContent = subscribeLabel();
    });

    document.getElementById('subscribe').addEventListener('click', async () => {
      const btn = document.getElementById('subscribe');
      btn.disabled = true;
      try {
        const out = await api('/api/checkout', { method: 'POST', body: {
          planId: selected, couponCode: coupon ? coupon.code : '',
        } });
        window.location.href = out.url;
      } catch (err) {
        btn.disabled = false;
        const msg = document.getElementById('coupon-msg');
        msg.hidden = false;
        if (err.status === 401 && err.data && err.data.error === 'account_required') {
          msg.textContent = 'Make an account to subscribe.';
        } else if (err.status === 503) {
          msg.textContent = "Payment isn't set up in this environment yet.";
        } else if (err.data && err.data.error === 'already_vip') {
          render();
          return;
        } else {
          msg.textContent = "The checkout could not start. Try again in a moment.";
        }
      }
    });
  }

  function providerName(id) {
    return id === 'stripe' ? 'Stripe' : (id === 'midtrans' ? 'Midtrans' : (id === 'xendit' ? 'Xendit' : id));
  }

  /* ── Manage subscription ──────────────────────────────────────────────── */

  async function viewManage(sub) {
    const parts = [];
    parts.push(`<a data-link href="/vip" class="btn-secondary self-start">Back</a>
    <h1 class="text-title">Manage subscription</h1>`);

    if (!sub.row && !sub.plan) {
      parts.push(emptyState('No subscription yet', 'HomeClip VIP unlocks every episode and removes ads.',
        '<a data-link href="/vip" class="btn-primary">See VIP plans</a>'));
      view.innerHTML = parts.join('');
      return;
    }

    const kv = (label, value) => `<div class="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <span class="text-small text-muted">${esc(label)}</span><span class="text-body">${value}</span></div>`;

    parts.push(`<section class="card flex flex-col">
      ${kv('Status', statusChip(sub.status))}
      ${kv('Plan', sub.plan ? `${esc(sub.plan.name)} · ${idr(sub.plan.priceIdr)}` : '—')}
      ${sub.renewalDate ? kv(sub.status === 'canceled' ? 'VIP until' : 'Renews on', fmtDate(sub.renewalDate)) : ''}
      ${sub.startedAt ? kv('Member since', fmtDate(sub.startedAt)) : ''}
    </section>`);

    if (sub.canCancel) {
      parts.push(`<button id="cancel" class="btn-secondary">Cancel subscription</button>
      <p class="text-small text-muted">Cancel any time. You keep VIP until ${sub.renewalDate ? fmtDate(sub.renewalDate) : 'the renewal date'}.</p>`);
    }
    if (sub.canResume) {
      parts.push(`<button id="resume" class="btn-primary">Resume</button>
      <p class="text-small text-muted">Resuming keeps your plan renewing on ${sub.renewalDate ? fmtDate(sub.renewalDate) : ''}.</p>`);
    }
    if (sub.status === 'expired') {
      parts.push(`<a data-link href="/vip" class="btn-primary self-start">Subscribe again</a>`);
    }

    parts.push(`<a data-link href="/vip/payments" class="text-small font-medium text-accent underline">Payment history</a>`);

    view.innerHTML = parts.join('');

    const cancelBtn = document.getElementById('cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        try { await api('/api/subscription/cancel', { method: 'POST', body: {} }); render(); }
        catch (err) { cancelBtn.disabled = false; console.warn('cancel failed', err); }
      });
    }
    const resumeBtn = document.getElementById('resume');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', async () => {
        resumeBtn.disabled = true;
        try { await api('/api/subscription/resume', { method: 'POST', body: {} }); render(); }
        catch (err) { resumeBtn.disabled = false; console.warn('resume failed', err); }
      });
    }
  }

  /* ── Payment history ──────────────────────────────────────────────────── */

  const METHOD_LABEL = { card: 'Card', ewallet: 'E-wallet', bank_transfer: 'Bank transfer', qr: 'QR' };

  async function viewPayments() {
    let data;
    try { data = await api('/api/payments'); } catch (err) { return renderError(err, 'The payment history could not load'); }

    const parts = [];
    parts.push(`<a data-link href="/vip/manage" class="btn-secondary self-start">Back</a>
    <h1 class="text-title">Payment history</h1>`);
    if (!data.payments.length) {
      parts.push(emptyState('No payments yet', 'Charges for HomeClip VIP appear here once you subscribe.',
        '<a data-link href="/vip" class="btn-primary">See VIP plans</a>'));
    } else {
      parts.push(`<ul class="list">
        ${data.payments.map((p) => `<li class="list-row">
          <div class="flex min-w-0 grow flex-col">
            <span class="font-semibold">${fmtDate(p.createdAt)} · ${esc((PLANS_NAME[p.planId]) || p.planId)}</span>
            <span class="text-small text-muted">${esc(METHOD_LABEL[p.method] || p.method)} · ${esc(providerName(p.provider))}${p.couponCode ? ' · coupon ' + esc(p.couponCode) : ''}</span>
          </div>
          <span class="font-semibold">${idr(p.amountIdr)}</span>
          ${paymentStatusChip(p.status)}
        </li>`).join('')}
      </ul>
      <p class="text-small text-muted">Charges are handled by ${esc(providerName(data.providerLabel || 'stripe'))}. HomeClip never sees or stores card numbers.</p>`);
    }
    view.innerHTML = parts.join('');
  }

  const PLANS_NAME = { monthly: 'Monthly', quarterly: '3 Months', yearly: 'Yearly' };

  /* ── Return from checkout ─────────────────────────────────────────────── */

  async function viewReturn() {
    const sessionId = new URLSearchParams(location.search).get('session_id');
    view.innerHTML = `<p class="text-small text-muted">Finishing your payment…</p>`;
    if (!sessionId) {
      view.innerHTML = errorState('We could not find the payment session', 'Check payment history in a moment, or go back to the VIP page.');
      view.innerHTML += '<a data-link href="/vip" class="btn-secondary self-start">Back to VIP</a>';
      return;
    }
    let sub;
    try {
      sub = await api('/api/checkout/confirm?session_id=' + encodeURIComponent(sessionId));
    } catch (err) {
      view.innerHTML = errorState('The payment could not be confirmed yet', 'If you completed payment, check Payment history in a moment — the confirmation can take a minute.') +
        '<a data-link href="/vip/manage" class="btn-secondary self-start">Manage subscription</a>';
      return;
    }
    if (sub.vip) {
      view.innerHTML = `<section class="card flex flex-col items-start gap-3">
        <span class="chip chip-vip">${LOCK}VIP</span>
        <h1 class="text-heading">You're a VIP member</h1>
        <p class="text-body text-muted">${esc(sub.plan ? sub.plan.name : '')} · ${sub.status === 'canceled' ? 'VIP until ' : 'Renews on '}${sub.renewalDate ? fmtDate(sub.renewalDate) : ''}. Every episode is unlocked and ads are gone.</p>
        <a data-link href="/" class="btn-primary self-start">Start watching</a>
        <a data-link href="/vip/manage" class="btn-secondary self-start">Manage subscription</a>
      </section>`;
    } else {
      view.innerHTML = errorState('Your payment is still processing', 'Once it completes, your subscription activates and VIP unlocks automatically.') +
        '<a data-link href="/vip/payments" class="btn-secondary self-start">Payment history</a>';
    }
  }

  /* ── Router ───────────────────────────────────────────────────────────── */

  async function render() {
    renderSeq += 1;
    const seq = renderSeq;
    if (timer) { clearInterval(timer); timer = null; }
    view.innerHTML = skeletonList();
    window.scrollTo(0, 0);

    const path = location.pathname;
    let sub;
    try { sub = await api('/api/me/subscription'); } catch { sub = { vip: false, status: 'expired', plan: null, renewalDate: null, startedAt: null, canCancel: false, canResume: false }; }
    if (seq !== renderSeq) return;
    updateHeader(sub);

    let m;
    try {
      if (path === '/') await viewHome(sub);
      else if ((m = path.match(/^\/drama\/(\d+)$/))) await viewDrama(sub, seq, Number(m[1]));
      else if ((m = path.match(/^\/drama\/(\d+)\/episode\/(\d+)$/))) await viewEpisode(sub, seq, Number(m[1]), Number(m[2]));
      else if (path === '/vip') await viewVip(sub);
      else if (path === '/vip/manage') await viewManage(sub);
      else if (path === '/vip/payments') await viewPayments();
      else if (path === '/vip/return') await viewReturn();
      else {
        view.innerHTML = emptyState('Page not found', 'That address does not exist in HomeClip.',
          '<a data-link href="/" class="btn-primary">Back home</a>');
      }
    } catch (err) {
      if (seq !== renderSeq) return;
      console.warn('view failed', err);
      renderError(err);
    }
  }

  render();
})();

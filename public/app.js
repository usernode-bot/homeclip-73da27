/* HomeClip client: the drama feed (screen 1) and a drama's page (screen 2),
 * with hash routes #/ and #/drama/:id, sheets for Add drama, Add episode,
 * episode details and Report. The markup and classes are the ones the spec's
 * screens drew; this script only fills them from data and wires the actions.
 *
 * Phase 5 adds: path routes (/drama/:id, /watch/:id, /downloads), the watch
 * and downloads views (run by their own lazily loaded scripts), offline
 * caching with a durable write queue, first-party analytics and error
 * capture, the language sheet, sheet focus management, and per-view titles.
 */
(function () {
  'use strict';

  // The iframe's token, forwarded on every request, and ?demo=1 passed on
  // when the page has it.
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || '';
  var DEMO = params.get('demo') === '1';

  function api(path, opts) {
    opts = opts || {};
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    var url = '/api/' + path + (DEMO ? sep + 'demo=1' : '');
    var headers = Object.assign(
      { 'Content-Type': 'application/json' },
      TOKEN ? { 'x-usernode-token': TOKEN } : {}
    );
    // A staging preview may be shown as of a chosen moment.
    if (window.usernode && window.usernode.previewNow) {
      headers['x-usernode-now'] = window.usernode.now().toISOString();
    }
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong');
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // ── Offline: cached reads and a durable write queue ─────────────────────
  // Per-user namespaces, keyed by the account id remembered from the last
  // authenticated load ("hc-me"). An offline launch has no ?token=, so the
  // namespace is never wiped when the token is absent — that would delete
  // the real user's saved data on the first offline boot.
  function meCacheKey() { return 'hc-me'; }
  function cacheKey(suffix) {
    return 'hc-cache:' + (HC.viewerId() || 'anon') + (suffix ? ':' + suffix : '');
  }
  function queueKey() { return 'hc-queue:' + (HC.viewerId() || 'anon'); }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function offlineBanner(show, text) {
    var b = $('offline-banner');
    if (!b) return;
    b.hidden = !show;
    if (show) b.textContent = text || i18n.t('offline_banner');
  }

  // A mutation the queue covers: on a network failure it is stored and
  // replayed on reconnect; other failures (a conflict, an account wall)
  // surface as today.
  function queuedApi(path, opts) {
    return api(path, opts).catch(function (err) {
      var network = err.status === undefined || err.status === 0;
      if (network && 'onLine' in navigator && !navigator.onLine) {
        var q = readJSON(queueKey(), []);
        q.push({ path: path, method: opts.method, body: opts.body });
        writeJSON(queueKey(), q);
        offlineBanner(true, i18n.t('offline_queued'));
        return { queued: true };
      }
      throw err;
    });
  }

  function replayQueue() {
    var q = readJSON(queueKey(), []);
    if (!q.length) return;
    var next = q[0];
    api(next.path, { method: next.method, body: next.body }).then(function () {
      q.shift();
      writeJSON(queueKey(), q);
      if (q.length) replayQueue();
      else { offlineBanner(false); route(); }
    }).catch(function (err) {
      if (err.status === undefined) return; // still offline; keep waiting
      q.shift(); // a real refusal (gone, conflict) is not replayed forever
      writeJSON(queueKey(), q);
      if (q.length) replayQueue(); else route();
    });
  }
  window.addEventListener('online', function () { replayQueue(); });

  // ── Analytics and error capture (first-party; guests are skipped) ───────
  var eventBuf = [];
  function track(name, props) {
    if (isGuest || !viewerId) return;
    eventBuf.push({ name: name, props: props || null, path: location.pathname + location.hash, ts: Date.now() });
    if (eventBuf.length >= 10) flushEvents();
  }
  function flushEvents() {
    if (!eventBuf.length) return;
    var batch = eventBuf.splice(0);
    api('events', { method: 'POST', body: { events: batch } }).catch(function (err) {
      if (err.status === undefined) eventBuf = batch.concat(eventBuf); // offline: keep for later
    });
  }
  window.addEventListener('pagehide', function () {
    flushEvents();
    var watch = window.HCWatch; // only present once the watch view has loaded
    if (watch && watch.active() && viewerId) {
      // keepalive so the position survives the page going away
      var pos = watch.currentPosition();
      if (pos !== null) {
        api('episodes/' + watch.active() + '/progress', { method: 'PUT', body: { position_s: pos, duration_s: watch.currentDuration() } }).catch(function () {});
      }
    }
  });
  setInterval(flushEvents, 30_000);

  var errTimes = [];
  function reportError(message, stack) {
    if (isGuest || !viewerId) return;
    var now = Date.now();
    errTimes = errTimes.filter(function (t) { return now - t < 60_000; });
    if (errTimes.length >= 5) return;
    errTimes.push(now);
    fetch('/api/client-errors' + (DEMO ? '?demo=1' : ''), {
      method: 'POST', keepalive: true,
      headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { 'x-usernode-token': TOKEN } : {}),
      body: JSON.stringify({ message: String(message).slice(0, 500), stack: stack ? String(stack).slice(0, 2000) : null, path: location.pathname + location.hash }),
    }).catch(function () {});
  }
  window.addEventListener('error', function (e) {
    reportError(e.message || 'Error', e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    reportError(r && (r.message || String(r)), r && r.stack);
  });

  // ── Shared helpers and the bridge other scripts use ─────────────────────
  // Posters are flat colour tiles; each drama gets one of four colours in
  // turn: teal, amber, ink, slate. Keyed off the id so both screens agree.
  var POSTER_COLORS = [
    'rgb(var(--accent))',
    'rgb(var(--action))',
    'rgb(var(--fg))',
    'rgb(var(--muted))',
  ];
  function posterColor(id) {
    return POSTER_COLORS[((Number(id) % 4) + 4) % 4];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Names for "watched by …": the viewer is "you", always first.
  function watchedBy(names, viewerName) {
    if (!names || !names.length) return '';
    var me = names.indexOf(viewerName) !== -1;
    var parts = names.filter(function (n) { return n !== viewerName; });
    if (me) parts.unshift('you');
    return parts.join(', ');
  }

  function svg(path) {
    return '<svg viewBox="0 0 24 24"><path d="' + path + '"/></svg>';
  }

  var STAR_PATH = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z';
  var HEART_PATH = 'M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zM7 10l4-7a2 2 0 0 1 2 2v4h6a1 1 0 0 1 1 1l-1.5 8a2 2 0 0 1-2 1.7H7';

  // How long ago, in the app's plain words.
  function timeAgo(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!(s >= 0)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 172800) return 'yesterday';
    return Math.floor(s / 86400) + ' days ago';
  }

  // A quiet confirmation, e.g. "Link copied".
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    $('toast-text').textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2000);
  }

  // Shared links carry no token and no demo flag: they start with the app's
  // own path only, so whoever opens them gets their own sign-in.
  function dramaUrl(dramaId) {
    return location.origin + location.pathname + '#/drama/' + dramaId;
  }
  function episodeUrl(dramaId, episodeId) {
    return location.origin + location.pathname + '#/drama/' + dramaId + '?ep=' + episodeId;
  }

  // Share: native share where the browser offers it (it may be absent or
  // refuse inside the cross-origin frame, so it is guarded), else the
  // clipboard, which every app frame may write. Both run inside the tap.
  function shareLink(url, title) {
    if (navigator.share) {
      return navigator.share({ title: title, url: url }).catch(function () {
        copyLink(url);
      });
    }
    copyLink(url);
  }
  function copyLink(url) {
    var done = function () { toast('Link copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () {
        fallbackCopy(url); done();
      });
      return;
    }
    fallbackCopy(url); done();
  }
  function fallbackCopy(url) {
    var ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  // The wording for the server's filter and rate-limit answers.
  function filterMessage(err) {
    if (err.message === 'profanity') return 'Please reword your comment';
    if (err.message === 'spam') return 'This looks like spam';
    if (err.message === 'rate_limited') return 'Easy there, try again in a moment';
    return err.message;
  }

  var $ = function (id) { return document.getElementById(id); };
  var viewerName = null;
  var viewerId = null;
  var isGuest = false;
  var viewerVip = false;
  var signedIn = false;

  // watch.js and downloads.js, and the language sheet, talk to this page
  // through HC instead of reaching into its closures.
  window.HC = {
    api: api,
    queuedApi: queuedApi,
    esc: esc,
    svg: svg,
    t: function (k, v) { return i18n.t(k, v); },
    track: track,
    posterColor: posterColor,
    viewer: function () { return { id: viewerId, name: viewerName, guest: isGuest, vip: viewerVip }; },
    viewerId: function () { return viewerId; },
    showSheet: showSheet,
    hideSheet: hideSheet,
  };

  // ── Sheets, with Escape, focus trap and focus restore ───────────────────

  var openSheet = null;
  var sheetOpener = null;
  function focusablesIn(el) {
    return Array.prototype.filter.call(
      el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; }
    );
  }
  function showSheet(id) {
    if (!openSheet) sheetOpener = document.activeElement;
    hideSheet();
    openSheet = $(id);
    openSheet.classList.remove('hidden');
    $('sheet-backdrop').classList.remove('hidden');
    var f = focusablesIn(openSheet);
    if (f.length) f[0].focus();
  }
  function hideSheet() {
    if (openSheet) openSheet.classList.add('hidden');
    openSheet = null;
    clearInterval(adTimer);
    $('sheet-backdrop').classList.add('hidden');
    if (sheetOpener && sheetOpener.focus) { sheetOpener.focus(); sheetOpener = null; }
  }
  $('sheet-backdrop').addEventListener('click', hideSheet);
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
    b.addEventListener('click', hideSheet);
  });
  document.addEventListener('keydown', function (e) {
    if (!openSheet) return;
    if (e.key === 'Escape') { e.preventDefault(); hideSheet(); return; }
    if (e.key !== 'Tab') return;
    var f = focusablesIn(openSheet);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ── Home: the drama feed ────────────────────────────────────────────────

  var homeLoad = 0;

  function renderHomeSkeleton() {
    $('next-section').hidden = true;
    $('rows-section').hidden = true;
    $('rows-section').innerHTML = '';
    // Loading shows the same shape as the populated screen: the hero
    // skeleton above, the "Drama feed" label, then the feed rows as bars.
    $('feed-label').hidden = false;
    var state = $('home-state');
    state.hidden = false;
    var bar = function (w) { return '<div class="skeleton" style="height:12px;width:' + w + '"></div>'; };
    var row = function () {
      return '<li class="list-row"><div class="skeleton" style="width:48px;height:68px;border-radius:6px;flex:none"></div>' +
        '<div class="grow" style="display:flex;flex-direction:column;gap:6px">' + bar('60%') + bar('40%') + '</div></li>';
    };
    state.innerHTML =
      '<div class="hero" style="margin-bottom:4px"><div class="skeleton" style="height:150px;border-radius:12px"></div>' +
      '<div style="display:flex;gap:12px;margin-top:12px">' +
      '<div class="grow" style="display:flex;flex-direction:column;gap:6px">' + bar('70%') + bar('35%') + '</div>' +
      '<div class="skeleton" style="width:110px;height:44px;border-radius:8px;flex:none"></div></div></div>';
    var list = $('feed-list');
    list.hidden = false;
    list.innerHTML = row() + row() + row() + row();
  }

  function renderHomeError(cached) {
    $('next-section').hidden = true;
    $('rows-section').hidden = true;
    $('rows-section').innerHTML = '';
    $('feed-label').hidden = true;
    var list = $('feed-list');
    list.hidden = true;
    list.innerHTML = '';
    var state = $('home-state');
    state.hidden = false;
    state.innerHTML =
      '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('feed_error_title')) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('state_error_body')) + '</p>' +
      '<button id="retry-btn" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div>';
    $('retry-btn').addEventListener('click', loadHome);
    offlineBanner(!!cached);
  }

  function heroHtml(next) {
    var pct = next.progress ? Math.round((next.progress.watched / next.progress.total) * 100) : 0;
    $('hero-season').textContent = i18n.t('hero_label', { drama: next.dramaTitle, s: next.season });
    $('hero-title').textContent = i18n.t('episode_n_colon', { n: next.hero.number, title: next.hero.title });
    $('hero-bar').style.width = pct + '%';
    $('hero-note').innerHTML =
      (next.progress ? esc(i18n.t('watched_progress', { watched: next.progress.watched, total: next.progress.total })) + '<br>' : '') +
      esc(next.hero.minutes ? i18n.t('n_min', { n: next.hero.minutes }) : '') +
      (next.hero.access !== 'free' ? ' ' + accessChip(next.hero.access) : '');
    $('hero-watch').onclick = function () {
      watchEpisode(Object.assign({ season: next.season }, next.hero), loadHome);
    };
  }

  function upcomingHtml(next) {
    var row = $('upcoming-row');
    row.innerHTML = next.upcoming.map(function (e) {
      return '<div class="ep" data-drama="' + next.dramaId + '">' +
        '<div class="scr">' + esc(i18n.t('ep_n', { n: e.number })) + '</div><div class="foot"></div>' +
        '<div class="sm">' + esc(e.title) + '</div>' + accessChip(e.access) + '</div>';
    }).join('');
    Array.prototype.forEach.call(row.children, function (el) {
      el.addEventListener('click', function () {
        location.hash = '#/drama/' + el.getAttribute('data-drama');
      });
    });
  }

  // The feed's one note per drama, composed here from the numbers and
  // names the server sends (server.js carries no words).
  function noteText(d) {
    var n = d.note;
    if (!n || n.kind === 'none') return '';
    if (n.kind === 'no_episodes') return i18n.t('no_episodes_yet');
    if (n.kind === 'progress') return i18n.t('watched_progress', { watched: n.watched, total: n.total });
    if (n.kind === 'new') return i18n.t('new_episode');
    if (n.kind === 'finished') return i18n.t('you_finished');
    if (n.kind === 'others') {
      if (n.names.length === 1) return i18n.t('watched_by', { names: n.names[0] });
      if (n.more === 0) return i18n.t('watched_by_two', { a: n.names[0], b: n.names[1] });
      return i18n.t('watched_by_more', { a: n.names[0], b: n.names[1], n: n.more });
    }
    return '';
  }

  // ── Home: the browse rows ────────────────────────────────────────────────

  // One poster card in a browse row: the poster tile (a lazy-loaded image
  // when the drama carries a poster link, else the flat colour tile), the
  // title and its rating out of 10, or its access label when unrated.
  function dcardHtml(d) {
    var poster = d.poster_url
      ? '<div class="dposter"><img src="' + esc(d.poster_url) + '" alt="" loading="lazy"></div>'
      : '<div class="dposter" style="background:' + posterColor(d.id) + '"></div>';
    var meta = d.rating != null
      ? '<span class="sm muted" style="display:inline-flex;align-items:center;gap:3px">' +
        '<svg class="star f" viewBox="0 0 24 24" style="width:12px;height:12px"><path d="' + STAR_PATH + '"/></svg>' +
        Number(d.rating).toFixed(1) + '</span>'
      : '<span class="sm muted">' + esc(d.access_label) + '</span>';
    return '<a class="dcard" href="#/drama/' + d.id + '" style="text-decoration:none;color:inherit">' + poster +
      '<div class="sm" style="font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(d.title) + '</div>' +
      meta + '</a>';
  }

  function rowsSectionHtml(label, items) {
    if (!items || !items.length) return '';
    return '<div class="section-label">' + esc(label) + '</div>' +
      '<div class="row" style="overflow-x:auto;padding-bottom:4px">' +
      items.map(dcardHtml).join('') + '</div>';
  }

  function renderRows(rows) {
    var el = $('rows-section');
    rows = rows || {};
    var html = rowsSectionHtml('Trending Now', rows.trending) +
      rowsSectionHtml('New Episodes', rows.new_episodes) +
      rowsSectionHtml('Top 10', rows.top) +
      (rows.genres || []).map(function (g) {
        return rowsSectionHtml(g.genre, g.dramas);
      }).join('');
    el.innerHTML = html;
    el.hidden = !html;
  }

  function feedRowHtml(d, viewerName) {
    var note;
    var text = noteText(d);
    if (d.note && d.note.kind === 'progress') {
      var pct = Math.round(d.note.pct * 100);
      note = '<div class="bar" style="margin-top:6px" aria-label="' + esc(text) + '"><i style="width:' + pct + '%"></i></div>';
    } else if (d.note && d.note.kind === 'new') {
      note = '<span class="chip">' + esc(text) + '</span>';
    } else if (d.note && (d.note.kind === 'others' || d.note.kind === 'finished')) {
      note = '<div class="sm tag">' + esc(text) + '</div>';
    } else if (text) {
      note = '<div class="sm muted">' + esc(text) + '</div>';
    } else {
      note = '';
    }
    var follow = d.following
      ? '<button class="fol" data-follow="' + d.id + '" data-on="1" aria-pressed="true">' + esc(i18n.t('following')) + '</button>'
      : '<button class="btn-secondary" data-follow="' + d.id + '" aria-pressed="false">' + esc(i18n.t('follow')) + '</button>';
    var seasons = i18n.t(d.seasons === 1 ? 'seasons_1' : 'seasons_n', { n: d.seasons });
    var episodes = i18n.t(d.episodes === 1 ? 'episodes_1' : 'episodes_n', { n: d.episodes });
    var openLabel = i18n.t('open_drama', { title: d.title });
    var poster = d.poster_url
      ? '<a href="#/drama/' + d.id + '" class="poster" style="display:block;overflow:hidden" aria-label="' + esc(openLabel) + '">' +
        '<img src="' + esc(d.poster_url) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block"></a>'
      : '<a href="#/drama/' + d.id + '" class="poster" style="background:' + posterColor(d.id) + ';display:block" aria-label="' + esc(openLabel) + '"></a>';
    return '<li class="list-row">' + poster +
      '<a class="grow" href="#/drama/' + d.id + '" style="text-decoration:none;color:inherit">' +
      '<div style="font-weight:600">' + esc(d.title) + '</div>' +
      '<div class="sm muted">' + esc(seasons + ', ' + episodes) + ' ' + labelChip(d.access_label) + '</div>' +
      note + '</a>' + follow + '</li>';
  }

  function renderHome(data) {
    var state = $('home-state');
    state.hidden = true;
    state.innerHTML = '';
    var list = $('feed-list');

    if (data.next) {
      $('next-section').hidden = false;
      heroHtml(data.next);
      upcomingHtml(data.next);
    } else {
      $('next-section').hidden = true;
    }

    var label = i18n.t('drama_feed') + (DEMO ? ' <span data-usernode-demo-note>(Staging demo)</span>' : '');
    var labelEl = $('feed-label');
    labelEl.innerHTML = label;
    list.hidden = false;

    if (!data.dramas.length) {
      // The empty state stands alone: no feed label or empty bordered list
      // around it, and the header's Add drama is hidden so the centred
      // amber one is the only Add drama on the screen.
      $('rows-section').hidden = true;
      $('rows-section').innerHTML = '';
      labelEl.hidden = true;
      list.hidden = true;
      list.innerHTML = '';
      $('add-drama-btn').hidden = true;
      state.hidden = false;
      state.innerHTML =
        '<div class="state-empty"><div class="text-heading">' + esc(i18n.t('no_dramas_title')) + '</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('no_dramas_body')) + '</p>' +
        '<button id="empty-add-drama" class="btn-primary">' + esc(i18n.t('add_drama')) + '</button></div>';
      $('empty-add-drama').addEventListener('click', function () { openAddDrama(); });
      return;
    }
    labelEl.hidden = false;
    $('add-drama-btn').hidden = false;
    renderRows(data.rows);
    list.innerHTML = data.dramas.map(function (d) { return feedRowHtml(d, viewerName); }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-follow]'), function (b) {
      b.addEventListener('click', function () {
        var on = b.getAttribute('data-on') === '1';
        queuedApi('dramas/' + b.getAttribute('data-follow') + '/follow', { method: on ? 'DELETE' : 'PUT' })
          .then(function (r) { if (!r.queued) loadHome(); })
          .catch(function () { loadHome(); });
      });
    });
  }

  function loadHome() {
    var token = ++homeLoad;
    renderHomeSkeleton();
    // The feed fetch and /api/me run in parallel; both settle before the
    // rows render (the rows name the viewer in "watched by you").
    var feedP = api('feed');
    Promise.all([mePromise, feedP]).then(function (results) {
      var data = results[1];
      if (token !== homeLoad) return;
      writeJSON(cacheKey('feed'), data);
      offlineBanner(false);
      renderHome(data);
    }).catch(function (err) {
      if (token !== homeLoad) return;
      var cached = readJSON(cacheKey('feed'), null);
      if (cached) { renderHome(cached); offlineBanner(true); return; }
      renderHomeError();
    });
  }

  // Watch routes by what the episode has: in-app video opens the player,
  // an external link opens it synchronously in the click handler (an
  // awaited window.open is what browsers pop-up-block), neither just marks
  // the episode watched.
  function watchEpisode(ep, done) {
    if (ep.locked) { showPaywall(ep); return; }
    var go = function () {
      if (ep.media_url) { location.hash = '#/watch/' + ep.id; return; }
      api('episodes/' + ep.id + '/watched', { method: 'PUT' }).then(function () {
        if (ep.watch_url) window.open(ep.watch_url, '_blank', 'noopener');
        done();
      }).catch(function (err) {
        // The server refused a VIP episode (a lapsed subscription).
        if (err.data && err.data.error === 'vip_required') { loadHome(); return; }
        // A guest is asked for an account by the bridge; nothing to do here.
        done();
      });
    };
    if (ep.requiresAd) showAd(go); else go();
  }

  // ── A drama's page ──────────────────────────────────────────────────────

  var dramaLoad = 0;
  var currentDrama = null;   // the loaded /api/dramas/:id answer
  var currentSeason = null;  // the season shown

  function renderDramaSkeleton() {
    $('drama-body').hidden = true;
    var state = $('drama-state');
    state.hidden = false;
    var bar = function (w) { return '<div class="skeleton" style="height:12px;width:' + w + '"></div>'; };
    var row = function () {
      return '<li class="list-row"><div class="skeleton" style="width:56px;height:38px;border-radius:6px;flex:none"></div>' +
        '<div class="grow" style="display:flex;flex-direction:column;gap:6px">' + bar('55%') + bar('35%') + '</div></li>';
    };
    state.innerHTML =
      '<div style="display:flex;gap:16px;margin-bottom:8px"><div class="skeleton" style="width:72px;height:102px;border-radius:8px;flex:none"></div>' +
      '<div class="grow" style="display:flex;flex-direction:column;gap:8px">' + bar('45%') + bar('80%') + '</div></div>' +
      '<div class="skeleton" style="height:50px;border-radius:10px;margin-bottom:12px"></div>' +
      '<ul class="list">' + row() + row() + row() + '</ul>';
  }

  function renderDramaError() {
    $('drama-body').hidden = true;
    var state = $('drama-state');
    state.hidden = false;
    state.innerHTML =
      '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('drama_error_title')) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('state_error_body')) + '</p>' +
      '<button id="retry-drama" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div>';
    $('retry-drama').addEventListener('click', loadDramaAgain);
  }

  function seasonProgressHtml(eps) {
    var total = eps.length;
    var watched = eps.filter(function (e) { return e.viewer_watched; }).length;
    var pct = total ? Math.round((watched / total) * 100) : 0;
    $('season-bar').style.width = pct + '%';
    $('season-progress').textContent = total
      ? i18n.t('watched_progress', { watched: watched, total: total })
      : '';
    return watched < total ? eps.filter(function (e) { return !e.viewer_watched; })[0] : null;
  }

  function epMeta(e) {
    var parts = [];
    if (e.minutes) parts.push(i18n.t('n_min', { n: e.minutes }));
    var by = watchedBy(e.watched_by, viewerName);
    if (by) parts.push(i18n.t('watched_by_short', { names: by }));
    return parts.join(', ');
  }

  function epRowHtml(e, nextEp) {
    var isNext = nextEp && nextEp.id === e.id;
    var scr = '<div class="scr' + (isNext ? ' next' : '') + '">' + e.number + '</div>';
    var action;
    if (isNext) {
      action = '<button class="btn-primary" data-watch="' + e.id + '">' + svg('M7 5l12 7-12 7z') + esc(i18n.t('watch')) + '</button>';
    } else if (e.viewer_watched) {
      action = '<button class="check" data-watch="' + e.id + '" data-on="1" aria-pressed="true" aria-label="' + esc(i18n.t('watched')) + '">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg></button>';
    } else {
      action = '<button class="check off" data-watch="' + e.id + '" aria-pressed="false" aria-label="' + esc(i18n.t('mark_watched')) + '">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg></button>';
    }
    var meta = epMeta(e);
    var chip = accessChip(e.access);
    return '<li class="list-row"><button class="icon-btn" style="width:auto;height:auto;padding:0;border:0;background:none" data-open-episode="' + e.id + '" aria-label="' + esc(i18n.t('episode_details')) + '">' + scr + '</button>' +
      '<button class="grow" style="text-align:left;border:0;background:none;font:inherit;color:inherit;padding:0;min-height:44px" data-open-episode="' + e.id + '">' +
      '<div style="font-weight:' + (isNext ? '600' : '500') + '">' + esc(e.title) + '</div>' +
      (meta || chip ? '<div class="sm muted">' + esc(meta) + (meta && chip ? ' ' : '') + chip + '</div>' : '') +
      '</button>' + action + '</li>';
  }

  function renderDrama(data) {
    currentDrama = data;
    myReview = data.my_review || null;
    reviewCursor = data.reviews_cursor || null;
    $('drama-state').hidden = true;
    $('drama-state').innerHTML = '';
    $('drama-body').hidden = false;

    var dp = $('drama-poster');
    dp.style.background = posterColor(data.drama.id);
    dp.innerHTML = data.drama.poster_url
      ? '<img src="' + esc(data.drama.poster_url) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit">'
      : '';
    $('drama-title').textContent = data.drama.title;
    document.title = i18n.t('title_drama', { title: data.drama.title });
    var desc = (data.drama.synopsis ? data.drama.synopsis + ' ' : '') +
      i18n.t('added_by', { name: data.drama.added_by_username });
    $('drama-desc').textContent = desc;
    // The line under the title: genres, country, year and the editorial
    // rating out of 10, whatever the drama carries.
    var meta = [];
    if (data.drama.genres) meta.push(data.drama.genres);
    if (data.drama.country) meta.push(data.drama.country);
    if (data.drama.year) meta.push(String(data.drama.year));
    if (data.drama.rating != null) meta.push(Number(data.drama.rating).toFixed(1) + ' out of 10');
    var metaEl = $('drama-meta');
    metaEl.textContent = meta.join(' · ');
    metaEl.hidden = !meta.length;
    var castEl = $('drama-cast');
    castEl.textContent = data.drama.cast_list ? 'Cast: ' + data.drama.cast_list : '';
    castEl.hidden = !data.drama.cast_list;
    var folBtn = $('drama-follow');
    folBtn.textContent = data.following ? i18n.t('following') : i18n.t('follow');
    folBtn.setAttribute('aria-pressed', data.following ? 'true' : 'false');
    folBtn.className = data.following ? 'fol' : 'btn-secondary';
    $('remove-drama-btn').hidden = !data.drama.mine;

    drawRatingCounts(data.drama);
    drawReviews(data.reviews || []);
    $('share-drama-btn').onclick = function () {
      shareLink(dramaUrl(currentDrama.drama.id), currentDrama.drama.title);
    };
    $('rate-btn').onclick = function () { openReviewSheet(); };

    // The season control starts at the season of the viewer's next episode,
    // else season 1.
    if (currentSeason === null || data.seasons.indexOf(currentSeason) === -1) {
      var nextEp = data.episodes.filter(function (e) { return !e.viewer_watched; })[0];
      currentSeason = nextEp ? nextEp.season : (data.seasons[0] || 1);
    }
    drawSeasons(data);
    drawEpisodes(data);

    $('drama-follow').onclick = function () {
      var on = currentDrama.following;
      queuedApi('dramas/' + currentDrama.drama.id + '/follow', { method: on ? 'DELETE' : 'PUT' })
        .then(function (r) {
          if (r.queued) { folBtn.setAttribute('aria-pressed', on ? 'false' : 'true'); return; }
          currentDrama.following = r.following;
          folBtn.textContent = r.following ? i18n.t('following') : i18n.t('follow');
          folBtn.setAttribute('aria-pressed', r.following ? 'true' : 'false');
          folBtn.className = r.following ? 'fol' : 'btn-secondary';
        })
        .catch(function (err) {
          if (err.status !== 401) loadDramaAgain();
        });
    };
    $('report-drama-btn').onclick = function () {
      openReport({ drama_id: currentDrama.drama.id, name: currentDrama.drama.title });
    };
    $('remove-drama-btn').onclick = function () {
      if (!window.confirm(i18n.t('remove_drama_confirm', { title: currentDrama.drama.title }))) return;
      api('dramas/' + currentDrama.drama.id, { method: 'DELETE' }).then(function () {
        location.hash = '#/';
      }).catch(function () {});
    };
    $('add-episode-btn').onclick = function () { openAddEpisode(); };

    // A shared episode link (#/drama/123?ep=456) opens that episode's sheet.
    if (pendingEpisodeId) {
      // ids arrive as strings (Postgres bigint), so compare as strings.
      var target = data.episodes.filter(function (e) {
        return String(e.id) === String(pendingEpisodeId);
      })[0];
      pendingEpisodeId = null;
      if (target) openEpisodeDetails(target);
    }
  }

  function drawSeasons(data) {
    var seg = $('season-seg');
    seg.innerHTML = data.seasons.length
      ? data.seasons.map(function (s) {
          return '<button data-season="' + s + '"' + (s === currentSeason ? ' class="on" aria-current="true"' : '') + '>' + esc(i18n.t('season_n', { n: s })) + '</button>';
        }).join('')
      : '';
    Array.prototype.forEach.call(seg.querySelectorAll('[data-season]'), function (b) {
      b.addEventListener('click', function () {
        currentSeason = parseInt(b.getAttribute('data-season'), 10);
        drawSeasons(currentDrama);
        drawEpisodes(currentDrama);
      });
    });
  }

  function drawEpisodes(data) {
    var list = $('ep-list');
    var eps = data.episodes.filter(function (e) { return e.season === currentSeason; });
    if (!eps.length) {
      list.innerHTML = '<li class="state-empty" style="list-style:none"><div class="text-body font-semibold">' + esc(i18n.t('no_episodes_yet')) + '</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('no_episodes_body')) + '</p></li>';
      $('add-episode-btn').classList.remove('btn-secondary');
      $('add-episode-btn').classList.add('btn-primary');
      $('season-bar').style.width = '0%';
      $('season-progress').textContent = '';
      return;
    }
    $('add-episode-btn').classList.add('btn-secondary');
    $('add-episode-btn').classList.remove('btn-primary');
    var nextEp = seasonProgressHtml(eps);
    // A very long season is rendered in chunks rather than all at once; a
    // virtualization library is not worth it at this app's scale (the
    // schema caps a season at 999 episodes).
    var slice = eps.length > 200 ? eps.slice(0, 200) : eps;
    list.innerHTML = slice.map(function (e) { return epRowHtml(e, nextEp); }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-watch]'), function (b) {
      b.addEventListener('click', function () {
        var ep = eps.filter(function (e) { return String(e.id) === b.getAttribute('data-watch'); })[0];
        var on = b.getAttribute('data-on') === '1';
        if (ep.media_url) { location.hash = '#/watch/' + ep.id; return; }
        if (!on && ep.locked) { showPaywall(ep); return; }
        var go = function () {
          queuedApi('episodes/' + ep.id + '/watched', { method: on ? 'DELETE' : 'PUT' })
            .then(function (r) { if (!r.queued) loadDramaAgain(); })
            .catch(function (err) {
              if (err.status !== 401) loadDramaAgain();
            });
        };
        if (!on && ep.requiresAd) showAd(go); else go();
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-open-episode]'), function (b) {
      b.addEventListener('click', function () {
        var ep = eps.filter(function (e) { return String(e.id) === b.getAttribute('data-open-episode'); })[0];
        openEpisodeDetails(ep);
      });
    });
  }

  function loadDramaAgain() {
    // Whatever route opened the drama re-opens it: by slug or by id.
    if (currentDramaSlug) loadSlugDrama(currentDramaSlug);
    else loadDrama(currentDramaId);
  }

  var currentDramaId = null;
  var currentDramaSlug = null; // set when the drama was opened by slug
  function loadDrama(id) {
    currentDramaId = id;
    currentDramaSlug = null;
    var token = ++dramaLoad;
    currentSeason = null;
    renderDramaSkeleton();
    var dramaP = api('dramas/' + id);
    Promise.all([mePromise, dramaP]).then(function (results) {
      var data = results[1];
      if (token !== dramaLoad) return;
      writeJSON(cacheKey('drama:' + id), data);
      offlineBanner(false);
      renderDrama(data);
    }).catch(function (err) {
      if (token !== dramaLoad) return;
      var cached = readJSON(cacheKey('drama:' + id), null);
      if (cached) { renderDrama(cached); offlineBanner(true); return; }
      renderDramaError();
    });
  }

  // The Phase-2 slug route (/dramas/:slug, the share form) answers the
  // Phase-2 shape. Adapt it into the shape renderDrama draws, so one screen
  // serves both routes. The slug payload has no reviews and no media_url
  // (a slug-drama episode's watch_url opens in a new tab); legacy dramas
  // reached by slug keep their editorial fields when the row carries them.
  function slugDramaData(raw) {
    var d = (raw.drama || {});
    var seasonNo = {};
    (raw.seasons || []).forEach(function (s) { seasonNo[s.id] = s.number; });
    var watches = (raw.viewer && raw.viewer.watches) || {};
    var whoElse = raw.whoElse || {};
    var episodes = (raw.episodes || []).map(function (e) {
      var w = watches[e.id];
      return {
        id: e.id,
        season: seasonNo[e.season_id] || 1,
        number: e.number,
        title: e.title,
        minutes: e.duration_seconds ? Math.round(e.duration_seconds / 60) : 0,
        watch_url: e.watch_url || '',
        media_url: '',
        subtitle_url: '',
        access: 'free',
        watched_by: whoElse[e.id] || [],
        viewer_watched: Boolean(w && w.completed),
      };
    });
    return {
      drama: {
        id: d.id,
        title: d.title,
        synopsis: d.synopsis || d.summary || '',
        added_by_username: d.added_by_username || d.addedBy || '',
        poster_url: d.poster_url || '',
        genres: d.genres || (raw.genres || []).join(', '),
        country: d.country || '',
        year: d.year || null,
        rating: d.rating != null ? d.rating : null,
        cast_list: d.cast_list || (raw.cast || []).map(function (c) { return c.name; }).join(', '),
        mine: false,
      },
      seasons: (raw.seasons || []).map(function (s) { return s.number; }),
      episodes: episodes,
      following: Boolean(raw.viewer && raw.viewer.following),
      reviews: [],
      reviews_cursor: null,
      my_review: null,
    };
  }

  function loadSlugDrama(slug) {
    currentDramaSlug = slug;
    currentDramaId = null;
    var token = ++dramaLoad;
    currentSeason = null;
    renderDramaSkeleton();
    var dramaP = api('dramas/' + slug);
    Promise.all([mePromise, dramaP]).then(function (results) {
      var data = slugDramaData(results[1]);
      if (token !== dramaLoad) return;
      writeJSON(cacheKey('drama-slug:' + slug), data);
      offlineBanner(false);
      renderDrama(data);
    }).catch(function (err) {
      if (token !== dramaLoad) return;
      var cached = readJSON(cacheKey('drama-slug:' + slug), null);
      if (cached) { renderDrama(cached); offlineBanner(true); return; }
      renderDramaError();
    });
  }

  // ── Reviews and the rating line ─────────────────────────────────────────

  var myReview = null;      // the viewer's own review, or null
  var reviewCursor = null;  // the next page of reviews, when there is one
  var pendingEpisodeId = null; // a shared episode link waiting for its drama
  var starPick = 0;         // the stars picked in the Rate sheet

  function starsHtml(n, cls) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<svg class="star ' + (i <= n ? 'f' : 'e') + '" viewBox="0 0 24 24"><path d="' + STAR_PATH + '"/></svg>';
    }
    return '<span class="' + cls + '">' + out + '</span>';
  }

  // The line under the title: the average to one decimal and how many
  // reviews, or "No reviews yet" when nobody has rated it.
  function drawRatingCounts(summary) {
    var line = $('drama-rating');
    line.hidden = false;
    if (!summary.rating_count) {
      $('rating-avg').textContent = '';
      $('rating-count').textContent = 'No reviews yet';
    } else {
      $('rating-avg').textContent = Number(summary.rating_avg).toFixed(1);
      $('rating-count').textContent =
        summary.rating_count === 1 ? '1 review' : summary.rating_count + ' reviews';
    }
    drawRateButton();
  }

  function drawRateButton() {
    $('rate-btn').innerHTML =
      '<svg class="star f" viewBox="0 0 24 24"><path d="' + STAR_PATH + '"/></svg>' +
      (myReview ? 'Your review' : 'Rate');
  }

  function reviewRowHtml(r) {
    return '<li class="list-row"><div class="review-row"><div class="review-top">' +
      '<span class="review-name">' + esc(r.username) + '</span>' +
      starsHtml(r.rating, 'review-stars') + '</div>' +
      (r.note ? '<div class="sm">' + esc(r.note) + '</div>' : '') +
      '</div></li>';
  }

  function drawReviews(reviews) {
    $('review-list').innerHTML = reviews.map(reviewRowHtml).join('');
    $('review-more-row').hidden = !reviewCursor;
  }

  function refreshReviews() {
    if (!currentDrama) return;
    api('dramas/' + currentDrama.drama.id + '/reviews').then(function (r) {
      reviewCursor = r.next_cursor || null;
      drawRatingCounts(r);
      drawReviews(r.reviews);
    }).catch(function () {});
  }

  $('review-more').addEventListener('click', function () {
    if (!reviewCursor || !currentDrama) return;
    api('dramas/' + currentDrama.drama.id + '/reviews?cursor=' + encodeURIComponent(reviewCursor))
      .then(function (r) {
        reviewCursor = r.next_cursor || null;
        var list = $('review-list');
        list.insertAdjacentHTML('beforeend', r.reviews.map(reviewRowHtml).join(''));
        $('review-more-row').hidden = !reviewCursor;
      }).catch(function () {});
  });

  function drawStarPicker() {
    var el = $('review-stars');
    el.innerHTML = [1, 2, 3, 4, 5].map(function (n) {
      return '<button class="star-btn" data-star="' + n + '" aria-label="' + n + ' star' + (n > 1 ? 's' : '') + '">' +
        '<svg class="star ' + (n <= starPick ? 'f' : 'e') + '" viewBox="0 0 24 24"><path d="' + STAR_PATH + '"/></svg></button>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-star]'), function (b) {
      b.addEventListener('click', function () {
        starPick = parseInt(b.getAttribute('data-star'), 10);
        drawStarPicker();
      });
    });
  }

  function openReviewSheet() {
    if (!currentDrama) return;
    $('review-heading').textContent = myReview ? 'Your review' : 'Rate';
    $('review-context').textContent = 'Rate ' + currentDrama.drama.title + ' out of 5 stars';
    starPick = myReview ? myReview.rating : 0;
    $('review-note-input').value = myReview ? (myReview.note || '') : '';
    $('review-error').hidden = true;
    $('remove-review').hidden = !myReview;
    drawStarPicker();
    showSheet('sheet-review');
  }

  $('save-review').addEventListener('click', function () {
    if (!currentDrama) return;
    var p = $('review-error');
    if (!starPick) {
      p.textContent = 'Pick 1 to 5 stars';
      p.hidden = false;
      return;
    }
    api('dramas/' + currentDrama.drama.id + '/review', { method: 'PUT', body: {
      rating: starPick, note: $('review-note-input').value,
    }}).then(function (r) {
      hideSheet();
      myReview = r.review;
      drawRatingCounts(r);
      refreshReviews();
    }).catch(function (err) {
      if (err.status === 401) { hideSheet(); return; }
      p.textContent = filterMessage(err);
      p.hidden = false;
    });
  });

  $('remove-review').addEventListener('click', function () {
    if (!currentDrama) return;
    if (!window.confirm('Remove your review of ' + currentDrama.drama.title + '?')) return;
    api('dramas/' + currentDrama.drama.id + '/review', { method: 'DELETE' })
      .then(function (r) {
        hideSheet();
        myReview = null;
        drawRatingCounts(r);
        refreshReviews();
      }).catch(function (err) {
        if (err.status !== 401) {
          var p = $('review-error');
          p.textContent = err.message;
          p.hidden = false;
        }
      });
  });

  // ── Comments on an episode ──────────────────────────────────────────────

  var cmts = null; // { episodeId, top: [comment], cursor, replyTo } — the
                   // thread shown in the episode sheet

  function findComment(id) {
    for (var i = 0; i < cmts.top.length; i++) {
      var c = cmts.top[i];
      if (String(c.id) === String(id)) return { c: c, parent: null };
      for (var j = 0; j < (c.replies || []).length; j++) {
        if (String(c.replies[j].id) === String(id)) return { c: c.replies[j], parent: c };
      }
    }
    return null;
  }

  function likeHtml(c) {
    return '<button class="like' + (c.viewer_liked ? ' on' : '') + '" data-like="' + c.id + '" aria-label="Like">' +
      '<svg viewBox="0 0 24 24"><path d="' + HEART_PATH + '"/></svg>' + c.like_count + '</button>';
  }

  // Optimistic like: the heart flips straight away; the server's answer
  // confirms it, and a failure reloads the thread so it tells the truth.
  // Takes the { c, parent } entry findComment returns, not the comment itself.
  function toggleLike(entry) {
    var c = entry && entry.c;
    if (!c || !signedIn) return;
    var liked = !c.viewer_liked;
    c.viewer_liked = liked;
    c.like_count += liked ? 1 : -1;
    renderComments();
    api('comments/' + c.id + '/like', { method: liked ? 'POST' : 'DELETE' })
      .then(function (r) {
        c.like_count = r.likes;
        c.viewer_liked = r.liked;
        renderComments();
      })
      .catch(function (err) {
        if (err.status !== 401) reloadComments();
      });
  }

  function actsHtml(c) {
    return '<div class="acts">' + likeHtml(c) +
      '<button class="act" data-reply="' + c.id + '">Reply</button>' +
      '<button class="act" data-report="' + c.id + '">Report</button>' +
      (c.mine ? '<button class="act danger" data-del="' + c.id + '">Delete</button>' : '') +
      '</div>';
  }

  function commentInnerHtml(c) {
    var head = '<div class="cmt-top"><span class="who">' + esc(c.mine ? 'You' : c.username) + '</span>' +
      '<span class="sm muted">' + esc(timeAgo(c.created_at)) + '</span></div>';
    var body = '<div class="cmt-body">' +
      (c.reply_to_username ? '<span class="ind">@' + esc(c.reply_to_username) + '</span> ' : '') +
      esc(c.body) + '</div>';
    return head + body + actsHtml(c);
  }

  function commentHtml(c) {
    var replies = c.replies && c.replies.length
      ? '<div class="replies">' + c.replies.map(function (r) {
          return '<div class="cmt">' + commentInnerHtml(r) + '</div>';
        }).join('') + '</div>'
      : '';
    return '<li class="cmt" data-cmt="' + esc(c.id) + '">' + commentInnerHtml(c) + replies + '</li>';
  }

  function renderComments() {
    var list = $('comment-list');
    if (!cmts.top.length) {
      list.innerHTML = '<li class="state-empty" style="list-style:none"><div class="text-body font-semibold">No comments yet</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">Say what you thought of this episode.</p></li>';
      $('comment-more-row').hidden = true;
      return;
    }
    list.innerHTML = cmts.top.map(commentHtml).join('');
    $('comment-more-row').hidden = !cmts.cursor;
    wireCommentActions();
  }

  function wireCommentActions() {
    var list = $('comment-list');
    Array.prototype.forEach.call(list.querySelectorAll('[data-like]'), function (b) {
      b.addEventListener('click', function () { toggleLike(findComment(b.getAttribute('data-like'))); });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-reply]'), function (b) {
      b.addEventListener('click', function () {
        var entry = findComment(b.getAttribute('data-reply'));
        if (!entry) return;
        cmts.replyTo = { id: entry.c.id, name: entry.c.username };
        updateReplyingChip();
        $('comment-input').focus();
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-report]'), function (b) {
      b.addEventListener('click', function () {
        var entry = findComment(b.getAttribute('data-report'));
        if (entry) openReport({ comment_id: entry.c.id, name: 'this comment' });
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        var entry = findComment(b.getAttribute('data-del'));
        if (!entry) return;
        if (!window.confirm('Delete this comment and its replies?')) return;
        removeComment(entry.c.id);
        renderComments();
        api('comments/' + entry.c.id, { method: 'DELETE' })
          .catch(function () { reloadComments(); });
      });
    });
  }

  function removeComment(id) {
    for (var i = 0; i < cmts.top.length; i++) {
      var c = cmts.top[i];
      if (String(c.id) === String(id)) { cmts.top.splice(i, 1); return; }
      for (var j = 0; j < (c.replies || []).length; j++) {
        if (String(c.replies[j].id) === String(id)) { c.replies.splice(j, 1); return; }
      }
    }
  }

  function replaceComment(tmpId, serverComment) {
    for (var i = 0; i < cmts.top.length; i++) {
      var c = cmts.top[i];
      if (String(c.id) === String(tmpId)) { cmts.top[i] = serverComment; return; }
      for (var j = 0; j < (c.replies || []).length; j++) {
        if (String(c.replies[j].id) === String(tmpId)) { c.replies[j] = serverComment; return; }
      }
    }
  }

  function updateReplyingChip() {
    var chip = $('comment-replying');
    if (cmts && cmts.replyTo) {
      $('comment-replying-name').textContent = cmts.replyTo.name;
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
  }

  function commentSkeleton() {
    var row = function () {
      return '<li class="cmt"><div class="skeleton" style="height:12px;width:30%;margin-bottom:6px"></div>' +
        '<div class="skeleton" style="height:12px;width:80%"></div></li>';
    };
    return row() + row() + row();
  }

  function reloadComments() {
    if (cmts) loadComments(cmts.episodeId);
  }

  function loadComments(episodeId) {
    cmts = { episodeId: episodeId, top: [], cursor: null, replyTo: null };
    updateReplyingChip();
    $('comment-input').value = '';
    $('comment-error').hidden = true;
    $('comment-list').innerHTML = commentSkeleton();
    $('comment-more-row').hidden = true;
    api('episodes/' + episodeId + '/comments').then(function (r) {
      if (!cmts || cmts.episodeId !== episodeId) return;
      cmts.top = r.comments;
      cmts.cursor = r.next_cursor;
      renderComments();
    }).catch(function () {
      if (!cmts || cmts.episodeId !== episodeId) return;
      $('comment-list').innerHTML =
        '<li class="state-error" style="list-style:none"><div class="text-body font-semibold">The comments could not be loaded</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">Everything else on this sheet still works.</p>' +
        '<button id="retry-comments" class="btn-secondary">Retry</button></li>';
      $('retry-comments').addEventListener('click', function () { loadComments(episodeId); });
    });
  }

  $('comment-more').addEventListener('click', function () {
    if (!cmts || !cmts.cursor) return;
    api('episodes/' + cmts.episodeId + '/comments?cursor=' + encodeURIComponent(cmts.cursor))
      .then(function (r) {
        if (!cmts) return;
        cmts.top = cmts.top.concat(r.comments);
        cmts.cursor = r.next_cursor;
        renderComments();
      }).catch(function () {});
  });

  function postComment() {
    if (!cmts) return;
    var input = $('comment-input');
    var body = input.value.trim();
    if (!body) return;
    var replyTo = cmts.replyTo;
    var optimistic = null;
    if (signedIn) {
      // In the thread straight away, with the server's answer replacing it.
      optimistic = {
        id: 'tmp' + Date.now(), username: viewerName, body: body,
        created_at: new Date().toISOString(),
        reply_to_username: replyTo ? replyTo.name : null,
        like_count: 0, viewer_liked: false, mine: true, replies: [],
      };
      if (replyTo) {
        var entry = findComment(replyTo.id);
        if (entry) (entry.parent || entry.c).replies.push(optimistic);
      } else {
        cmts.top.unshift(optimistic);
      }
      input.value = '';
      cmts.replyTo = null;
      $('comment-error').hidden = true;
      updateReplyingChip();
      renderComments();
    }
    var payload = { body: body };
    if (replyTo) payload.parent_id = replyTo.id;
    api('episodes/' + cmts.episodeId + '/comments', { method: 'POST', body: payload })
      .then(function (r) {
        $('comment-error').hidden = true;
        if (optimistic) {
          replaceComment(optimistic.id, r.comment);
          renderComments();
        } else {
          // A guest was asked for an account by the bridge; their text stays.
        }
      }).catch(function (err) {
        if (optimistic) { removeComment(optimistic.id); renderComments(); }
        if (err.status === 401) return; // the bridge asks for an account
        var p = $('comment-error');
        p.textContent = filterMessage(err);
        p.hidden = false;
      });
  }
  $('post-comment').addEventListener('click', postComment);
  $('comment-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') postComment();
  });
  $('comment-input').addEventListener('input', function () {
    $('comment-error').hidden = true;
  });
  $('cancel-reply').addEventListener('click', function () {
    if (cmts) { cmts.replyTo = null; updateReplyingChip(); }
  });

  // ── Sheets' contents ────────────────────────────────────────────────────

  function openAddDrama() {
    $('drama-title-input').value = '';
    $('drama-desc-input').value = '';
    $('drama-genres-input').value = '';
    $('drama-year-input').value = '';
    $('drama-country-input').value = '';
    $('drama-rating-input').value = '';
    $('drama-poster-input').value = '';
    $('add-drama-error').hidden = true;
    showSheet('sheet-add-drama');
  }
  $('add-drama-btn').addEventListener('click', openAddDrama);
  $('save-drama').addEventListener('click', function () {
    api('dramas', { method: 'POST', body: {
      title: $('drama-title-input').value,
      synopsis: $('drama-desc-input').value,
      genres: $('drama-genres-input').value,
      year: $('drama-year-input').value,
      country: $('drama-country-input').value,
      rating: $('drama-rating-input').value,
      poster_url: $('drama-poster-input').value,
    }}).then(function () {
      hideSheet();
      if (location.hash && location.hash !== '#/') location.hash = '#/';
      else loadHome();
    }).catch(function (err) {
      if (err.status === 401) { hideSheet(); return; }
      var p = $('add-drama-error');
      p.textContent = err.message;
      p.hidden = false;
    });
  });
  // Poster upload through the platform's storage (the bridge), with the
  // link field as the fallback everywhere the bridge is not there.
  $('poster-upload-btn').addEventListener('click', function () {
    $('poster-file-input').click();
  });
  $('poster-file-input').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (window.usernode && window.usernode.uploadFile) {
      toast('Uploading poster');
      window.usernode.uploadFile(file, { visibility: 'public' }).then(function (stored) {
        $('drama-poster-input').value = stored.url;
        toast('Poster uploaded');
      }).catch(function () {
        toast('Upload failed, paste a link instead');
      });
    } else {
      toast('Uploads need the Homeroom app, paste a link instead');
    }
  });

  function openAddEpisode() {
    if (!currentDrama) return;
    // Season starts at the season you are looking at; the episode number at
    // the next free one.
    var inSeason = currentDrama.episodes.filter(function (e) { return e.season === currentSeason; });
    var nextNumber = inSeason.reduce(function (m, e) { return Math.max(m, e.number); }, 0) + 1;
    $('ep-season-input').value = currentSeason;
    $('ep-number-input').value = nextNumber;
    $('ep-title-input').value = '';
    $('ep-minutes-input').value = '';
    $('ep-url-input').value = '';
    $('ep-media-input').value = '';
    $('ep-subtitle-input').value = '';
    $('ep-access-input').value = 'free';
    $('add-episode-error').hidden = true;
    showSheet('sheet-add-episode');
  }
  $('save-episode').addEventListener('click', function () {
    api('dramas/' + currentDramaId + '/episodes', { method: 'POST', body: {
      season: $('ep-season-input').value,
      number: $('ep-number-input').value,
      title: $('ep-title-input').value,
      minutes: $('ep-minutes-input').value || null,
      watch_url: $('ep-url-input').value || null,
      media_url: $('ep-media-input').value || null,
      subtitle_url: $('ep-subtitle-input').value || null,
      access: $('ep-access-input').value,
    }}).then(function () {
      hideSheet();
      loadDramaAgain();
    }).catch(function (err) {
      if (err.status === 401) { hideSheet(); return; }
      var p = $('add-episode-error');
      p.textContent = err.message;
      p.hidden = false;
    });
  });

  function openEpisodeDetails(ep) {
    $('episode-detail-title').textContent = i18n.t('episode_full', { s: ep.season, n: ep.number, title: ep.title });
    $('episode-detail-meta').textContent =
      (ep.minutes ? i18n.t('n_min', { n: ep.minutes }) + ', ' : '') + i18n.t('ep_added_by', { name: ep.added_by_username });
    var by = watchedBy(ep.watched_by, viewerName);
    $('episode-detail-watchers').textContent = by ? i18n.t('watched_by', { names: by }) : i18n.t('not_watched_yet');
    $('episode-detail-access').innerHTML = accessChip(ep.access);
    var link = $('episode-detail-link');
    if (ep.watch_url) {
      link.href = ep.watch_url;
      link.textContent = i18n.t('open_the_link');
      link.hidden = false;
    } else {
      link.hidden = true;
    }
    $('remove-episode-btn').hidden = !ep.mine;
    $('remove-episode-btn').onclick = function () {
      if (!window.confirm(i18n.t('remove_episode'))) return;
      hideSheet();
      api('episodes/' + ep.id, { method: 'DELETE' }).then(loadDramaAgain).catch(function () {});
    };
    $('report-episode-btn').onclick = function () {
      openReport({ episode_id: ep.id, name: ep.title });
    };
    $('share-episode-btn').onclick = function () {
      shareLink(episodeUrl(currentDrama.drama.id, ep.id),
        currentDrama.drama.title + ' - ' + ep.title);
    };
    loadComments(ep.id);
    showSheet('sheet-episode');
  }

  function openReport(target) {
    $('report-context').textContent = i18n.t('report_context', { name: target.name });
    $('report-reason').value = '';
    $('report-error').hidden = true;
    $('send-report').onclick = function () {
      api('reports', { method: 'POST', body: {
        drama_id: target.drama_id || null,
        episode_id: target.episode_id || null,
        comment_id: target.comment_id || null,
        reason: $('report-reason').value || null,
      }}).then(function () {
        hideSheet();
      }).catch(function (err) {
        if (err.status === 401) { hideSheet(); return; }
        var p = $('report-error');
        p.textContent = err.message;
        p.hidden = false;
      });
    };
    showSheet('sheet-report');
  }

  // ── Language sheet ──────────────────────────────────────────────────────

  function openLanguage() {
    var locales = i18n.locales();
    var current = i18n.locale();
    var wrap = $('language-list');
    wrap.innerHTML = locales.map(function (l) {
      var on = l.code === current;
      return '<div class="lang-row"' + (on ? ' aria-current="true"' : '') + ' data-lang="' + l.code + '" role="button" tabindex="0">' +
        '<span>' + esc(l.name) + '</span>' + (on ? '<span class="lang-on" aria-label="' + esc(l.name) + '">✓</span>' : '') +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-lang]'), function (row) {
      function pick() {
        var code = row.getAttribute('data-lang');
        hideSheet();
        if (code === i18n.locale()) return;
        i18n.setLang(code);
        track('language_changed', { to: code });
        route(); // re-render the current view in the chosen language
      }
      row.addEventListener('click', pick);
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    showSheet('sheet-language');
  }
  $('language-btn').addEventListener('click', openLanguage);
  $('downloads-btn').addEventListener('click', function () {
    location.hash = '#/downloads';
  });

  // ── VIP: plans, subscription, payment history ─────────────────────────
  // The client renders what the server decides: VIP status comes from
  // /api/me/subscription and locked episodes arrive without a watch link.

  function idr(n) {
    return 'Rp ' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  var LOCK_ICON = '<svg viewBox="0 0 24 24" style="width:14px;height:14px"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  var TICK_ICON = '<svg viewBox="0 0 24 24" style="width:18px;height:18px;color:rgb(var(--accent))"><path d="M5 12l4 4L19 6"/></svg>';
  var PERKS = ['No ads on any episode', 'Early access to new episodes', 'HD and 4K', 'Offline download'];
  var PLAN_NAMES = { monthly: 'Monthly', quarterly: '3 Months', yearly: 'Yearly' };
  var METHOD_LABELS = { card: 'Card', ewallet: 'E-wallet', bank_transfer: 'Bank transfer', qr: 'QR' };

  function accessChip(access) {
    if (access === 'vip') return '<span class="chip chip-vip">' + LOCK_ICON + 'VIP</span>';
    if (access === 'ads') return '<span class="chip chip-soft">Free with ads</span>';
    return '';
  }
  function labelChip(label) {
    if (label === 'VIP') return accessChip('vip');
    if (label === 'Free with ads') return accessChip('ads');
    return '';
  }
  function statusChip(status) {
    if (status === 'active') return '<span class="chip chip-vip">Active</span>';
    return '<span class="chip chip-soft">' + (status === 'canceled' ? 'Canceled' : 'Expired') + '</span>';
  }
  function paymentChip(status) {
    var label = { paid: 'Paid', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' }[status] || status;
    return '<span class="chip ' + (status === 'paid' ? 'chip-vip' : 'chip-soft') + '">' + esc(label) + '</span>';
  }
  function providerName(id) {
    return { stripe: 'Stripe', midtrans: 'Midtrans', xendit: 'Xendit' }[id] || id;
  }
  function perkList() {
    return '<ul style="list-style:none;padding:0;margin:8px 0;display:flex;flex-direction:column;gap:8px">' +
      PERKS.map(function (p) { return '<li style="display:flex;align-items:center;gap:8px">' + TICK_ICON + esc(p) + '</li>'; }).join('') +
      '</ul>';
  }
  function vipLink(href, label, cls) {
    return '<a href="' + href + '" class="' + cls + '" style="text-decoration:none">' + label + '</a>';
  }

  var vipLoadSeq = 0;

  function vipSkeleton() {
    var bar = function (w) { return '<div class="skeleton" style="height:12px;width:' + w + '"></div>'; };
    var row = '<li class="list-row"><div class="skeleton" style="width:20px;height:20px;border-radius:99px;flex:none"></div>' +
      '<div class="grow" style="display:flex;flex-direction:column;gap:6px">' + bar('45%') + bar('30%') + '</div></li>';
    $('vip-body').innerHTML = '<ul class="list" aria-hidden="true">' + row + row + row + '</ul>';
  }

  function vipError(what, onRetry) {
    $('vip-body').innerHTML =
      '<div class="state-error"><div class="text-body font-semibold">' + esc(what) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">You can retry. Nothing else in the app is affected.</p>' +
      '<button id="vip-retry" class="btn-secondary">Retry</button></div>';
    $('vip-retry').addEventListener('click', onRetry);
  }

  function vipEmpty(title, detail, linkHtml) {
    return '<div class="state-empty"><div class="text-body font-semibold">' + esc(title) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(detail) + '</p>' + (linkHtml || '') + '</div>';
  }

  function renewalLine(sub) {
    return esc(sub.plan ? sub.plan.name : '') + ' · ' + (sub.status === 'canceled' ? 'VIP until ' : 'Renews on ') +
      (sub.renewalDate ? fmtDate(sub.renewalDate) : '');
  }

  function loadVip(kind) {
    var token = ++vipLoadSeq;
    vipSkeleton();
    var titles = { vip: 'HomeClip VIP', manage: 'Manage subscription', payments: 'Payment history', ret: 'HomeClip VIP' };
    $('vip-title').textContent = titles[kind];
    $('vip-back').onclick = function () {
      if (kind === 'payments') location.hash = '#/vip/manage';
      else if (kind === 'manage') location.hash = '#/vip';
      else location.hash = '#/';
    };
    var retry = function () { loadVip(kind); };
    var done = function (fn) { return function (data) { if (token === vipLoadSeq) fn(data); }; };
    var failed = function (what) { return function () { if (token === vipLoadSeq) vipError(what, retry); }; };

    if (kind === 'payments') {
      api('payments').then(done(renderPayments)).catch(failed('The payment history could not load'));
    } else if (kind === 'ret') {
      renderReturn(token);
    } else {
      api('me/subscription').then(function (sub) {
        if (token !== vipLoadSeq) return;
        if (kind === 'manage') return renderManage(sub);
        return api('plans').then(done(function (plans) { renderVip(sub, plans); }))
          .catch(failed('The plans could not load'));
      }).catch(failed('Your subscription could not load'));
    }
  }

  function renderVip(sub, plansData) {
    var body = $('vip-body');
    var html = '<div class="hero"><div class="h">Watch everything, ad-free</div>' + perkList() + '</div>';
    if (sub.vip) {
      body.innerHTML = html +
        '<div class="hero" style="margin-top:12px"><div style="display:flex;align-items:center;gap:8px">' + accessChip('vip') +
        '<span style="font-weight:600">You are a VIP member</span></div>' +
        '<p class="sm muted" style="margin:6px 0 10px">' + renewalLine(sub) + '</p>' +
        vipLink('#/vip/manage', 'Manage subscription', 'btn-secondary') + '</div>';
      return;
    }
    var selected = 'monthly';
    var coupon = null; // { code, discountIdr, amountIdr } after a successful Apply
    var planById = function (id) { return plansData.plans.filter(function (p) { return p.id === id; })[0] || { priceIdr: 0 }; };
    var subscribeLabel = function () { return 'Subscribe · ' + idr(coupon ? coupon.amountIdr : planById(selected).priceIdr); };
    var plansHtml = function () {
      return plansData.plans.map(function (p) {
        var on = p.id === selected;
        var sub2 = p.id === 'monthly' ? 'Billed every month'
          : idr(Math.round(p.perMonthIdr / 100) * 100) + ' per month' + (p.save ? ' · save ' + p.save + '%' : '');
        return '<button data-plan="' + p.id + '" class="hero" style="display:flex;align-items:center;gap:12px;text-align:left;font:inherit;color:inherit;' +
          (on ? 'border-color:rgb(var(--accent));box-shadow:0 0 0 2px rgb(var(--accent))' : '') + '">' +
          '<span style="width:20px;height:20px;flex:none;border-radius:99px;border:2px solid rgb(var(--' + (on ? 'accent' : 'line') + ');background:' + (on ? 'rgb(var(--accent))' : 'none') + '"></span>' +
          '<span class="grow"><span style="font-weight:600;display:block">' + esc(p.name) + '</span><span class="sm muted">' + esc(sub2) + '</span></span>' +
          '<span style="font-weight:700">' + idr(p.priceIdr) + '</span></button>';
      }).join('');
    };
    body.innerHTML = html +
      '<div class="section-label">Plans</div><div id="vip-plans" style="display:flex;flex-direction:column;gap:8px">' + plansHtml() + '</div>' +
      '<label class="section-label" for="vip-coupon">Coupon</label>' +
      '<div style="display:flex;gap:8px"><input id="vip-coupon" class="field" placeholder="e.g. STAGE10" autocomplete="off">' +
      '<button id="vip-coupon-apply" class="btn-secondary">Apply</button></div>' +
      '<p id="vip-msg" class="sm muted" style="margin-top:8px" hidden></p>' +
      '<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px">' +
      '<button id="vip-subscribe" class="btn-primary">' + esc(subscribeLabel()) + '</button>' +
      (plansData.paymentConfigured
        ? '<p class="sm muted">You will finish payment on ' + esc(providerName(plansData.provider)) + '\'s secure page. No card details ever reach HomeClip.</p>'
        : '<p class="sm muted">Payment is not set up in this environment yet, so subscribing is off for now. Plans and prices show as they will be.</p>') +
      '</div>';
    var msg = $('vip-msg');
    var say = function (t) { msg.textContent = t; msg.hidden = !t; };
    var subscribe = $('vip-subscribe');
    if (!plansData.paymentConfigured) { subscribe.disabled = true; return; }
    var bindPlans = function () {
      Array.prototype.forEach.call(body.querySelectorAll('[data-plan]'), function (b) {
        b.addEventListener('click', function () {
          selected = b.getAttribute('data-plan');
          coupon = null;
          say('');
          $('vip-plans').innerHTML = plansHtml();
          bindPlans();
          subscribe.textContent = subscribeLabel();
        });
      });
    };
    bindPlans();
    $('vip-coupon-apply').addEventListener('click', function () {
      api('coupon/validate', { method: 'POST', body: { planId: selected, couponCode: $('vip-coupon').value } })
        .then(function (out) {
          coupon = out;
          say('Coupon ' + out.code + ' applied. You pay ' + idr(out.amountIdr) + '.');
        })
        .catch(function (err) {
          var code = err.data && err.data.error;
          coupon = null;
          say(code === 'expired' ? 'That code has expired.' : code === 'used_up' ? 'That code has no uses left.' : 'That code does not work.');
        })
        .then(function () { subscribe.textContent = subscribeLabel(); });
    });
    subscribe.addEventListener('click', function () {
      subscribe.disabled = true;
      api('checkout', { method: 'POST', body: { planId: selected, couponCode: coupon ? coupon.code : '' } })
        .then(function (out) { window.location.href = out.url; })
        .catch(function (err) {
          subscribe.disabled = false;
          var code = err.data && err.data.error;
          if (err.status === 401) say('Make an account to subscribe.');
          else if (code === 'already_vip') loadVip('vip');
          else if (err.status === 503) say('Payment is not set up in this environment yet.');
          else say('The checkout could not start. Try again in a moment.');
        });
    });
  }

  function renderManage(sub) {
    var body = $('vip-body');
    if (!sub.plan) {
      body.innerHTML = vipEmpty('No subscription yet', 'HomeClip VIP unlocks every episode and removes ads.',
        vipLink('#/vip', 'See VIP plans', 'btn-primary'));
      return;
    }
    var kv = function (label, value) {
      return '<div class="list-row" style="justify-content:space-between"><span class="sm muted">' + esc(label) + '</span><span>' + value + '</span></div>';
    };
    var html = '<ul class="list" style="list-style:none">' +
      kv('Status', statusChip(sub.status)) +
      kv('Plan', esc(sub.plan.name) + ' · ' + idr(sub.plan.priceIdr)) +
      (sub.renewalDate ? kv(sub.status === 'canceled' ? 'VIP until' : 'Renews on', fmtDate(sub.renewalDate)) : '') +
      (sub.startedAt ? kv('Member since', fmtDate(sub.startedAt)) : '') + '</ul>';
    html += '<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px;align-items:flex-start">';
    if (sub.canCancel) {
      html += '<button id="vip-cancel" class="btn-secondary">Cancel subscription</button>' +
        '<p class="sm muted">Cancel any time. You keep VIP until ' + (sub.renewalDate ? fmtDate(sub.renewalDate) : 'the renewal date') + '.</p>';
    }
    if (sub.canResume) {
      html += '<button id="vip-resume" class="btn-primary">Resume</button>' +
        '<p class="sm muted">Resuming keeps your plan renewing on ' + (sub.renewalDate ? fmtDate(sub.renewalDate) : '') + '.</p>';
    }
    if (sub.status === 'expired') html += vipLink('#/vip', 'Subscribe again', 'btn-primary');
    html += vipLink('#/vip/payments', 'Payment history', 'btn-secondary') + '</div>';
    body.innerHTML = html;
    var act = function (id, path) {
      var b = $(id);
      if (!b) return;
      b.addEventListener('click', function () {
        b.disabled = true;
        api(path, { method: 'POST', body: {} }).then(function () { loadVip('manage'); })
          .catch(function () { b.disabled = false; });
      });
    };
    act('vip-cancel', 'subscription/cancel');
    act('vip-resume', 'subscription/resume');
  }

  function renderPayments(data) {
    if (!data.payments.length) {
      $('vip-body').innerHTML = vipEmpty('No payments yet', 'Charges for HomeClip VIP appear here once you subscribe.',
        vipLink('#/vip', 'See VIP plans', 'btn-primary'));
      return;
    }
    $('vip-body').innerHTML = '<ul class="list">' + data.payments.map(function (p) {
      return '<li class="list-row"><div class="grow"><div style="font-weight:600">' + fmtDate(p.createdAt) + ' · ' + esc(PLAN_NAMES[p.planId] || p.planId) + '</div>' +
        '<div class="sm muted">' + esc(METHOD_LABELS[p.method] || p.method) + ' · ' + esc(providerName(p.provider)) +
        (p.couponCode ? ' · coupon ' + esc(p.couponCode) : '') + '</div></div>' +
        '<span style="font-weight:600">' + idr(p.amountIdr) + '</span>' + paymentChip(p.status) + '</li>';
    }).join('') + '</ul>' +
      '<p class="sm muted" style="margin-top:8px">HomeClip never sees or stores card numbers.</p>';
  }

  // Stripe sends the browser back to /vip/return?session_id=…; the server
  // asks Stripe about the session before anything unlocks.
  function renderReturn(token) {
    var sessionId = new URLSearchParams(location.search).get('session_id');
    var body = $('vip-body');
    if (!sessionId) {
      vipError('We could not find the payment session', function () { location.hash = '#/vip'; });
      return;
    }
    body.innerHTML = '<p class="sm muted">Finishing your payment…</p>';
    api('checkout/confirm?session_id=' + encodeURIComponent(sessionId)).then(function (sub) {
      if (token !== vipLoadSeq) return;
      if (sub.vip) {
        body.innerHTML = '<div class="hero">' + accessChip('vip') +
          '<div class="h" style="margin-top:8px">You are a VIP member</div>' +
          '<p class="sm muted" style="margin:6px 0 12px">' + renewalLine(sub) + '. Every episode is unlocked and ads are gone.</p>' +
          '<div style="display:flex;gap:8px">' + vipLink('#/', 'Start watching', 'btn-primary') +
          vipLink('#/vip/manage', 'Manage subscription', 'btn-secondary') + '</div></div>';
      } else {
        body.innerHTML = vipEmpty('Your payment is still processing', 'Once it completes, your subscription activates and VIP unlocks automatically.',
          vipLink('#/vip/payments', 'Payment history', 'btn-secondary'));
      }
    }).catch(function () {
      if (token !== vipLoadSeq) return;
      body.innerHTML = vipEmpty('The payment could not be confirmed yet',
        'If you completed payment, check Payment history in a moment. The confirmation can take a minute.',
        vipLink('#/vip/manage', 'Manage subscription', 'btn-secondary'));
    });
  }

  // ── Paywall and pre-roll ad ───────────────────────────────────────────

  function showPaywall(ep) {
    $('paywall-detail').textContent = 'Season ' + ep.season + ', Episode ' + ep.number + ': ' + ep.title +
      '. Subscribe to watch it, or keep going with the free episodes.';
    showSheet('sheet-paywall');
  }

  var adTimer = null;
  // Free-with-ads episodes show a pre-roll placeholder first; VIP never gets
  // requiresAd. `go` runs once the countdown ends.
  function showAd(go) {
    var left = 5;
    $('ad-count').textContent = String(left);
    showSheet('sheet-ad');
    clearInterval(adTimer);
    adTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(adTimer);
        adTimer = null;
        hideSheet();
        go();
      } else {
        $('ad-count').textContent = String(left);
      }
    }, 1000);
  }

  // ── Routing ─────────────────────────────────────────────────────────────
  // Two entry styles agree: the platform-facing path routes
  // (/drama/:id, /watch/:id, /downloads) and the in-app hash routes
  // (#/drama/:id, #/watch/:id, #/downloads). A hash navigation wins over
  // the entry path and resets the path to /, so the two never disagree.

  // The screens are one at a time; every show* hides the rest through this
  // helper.
  var VIEWS = ['view-home', 'view-drama', 'view-watch', 'view-downloads',
               'view-vip', 'view-search', 'view-profiles'];
  function showView(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
  }

  function showHome() {
    showView('view-home');
    document.title = i18n.t('title_home');
    hideSheet();
    track('screen_view', { screen: 'home' });
    currentSeason = null;
    loadHome();
  }
  function showDrama(id, episodeId) {
    showView('view-drama');
    hideSheet();
    track('screen_view', { screen: 'drama', drama_id: Number(id) });
    // A shared episode link (#/drama/:id?ep=:episodeId) opens that episode's
    // sheet once the drama has loaded.
    pendingEpisodeId = episodeId ? Number(episodeId) : null;
    loadDrama(id);
  }
  function showVip(sub) {
    showView('view-vip');
    hideSheet();
    loadVip(sub === 'return' ? 'ret' : (sub || 'vip'));
  }
  function showWatch(id) {
    showView('view-watch');
    hideSheet();
    track('screen_view', { screen: 'watch', episode_id: Number(id) });
    loadWatch(id);
  }
  function showDownloads() {
    showView('view-downloads');
    document.title = i18n.t('title_downloads');
    hideSheet();
    track('screen_view', { screen: 'downloads' });
    loadDownloads();
  }
  function showSearch() {
    showView('view-search');
    document.title = i18n.t('title_search');
    hideSheet();
    track('screen_view', { screen: 'search' });
    loadSearch();
  }
  function showProfiles() {
    showView('view-profiles');
    document.title = i18n.t('title_profiles');
    hideSheet();
    track('screen_view', { screen: 'profiles' });
    loadProfiles();
  }
  // /add is the Add drama sheet over the home screen: the home feed loads
  // behind it, so closing the sheet leaves a real screen.
  function showAdd() {
    showView('view-home');
    document.title = i18n.t('title_home');
    hideSheet();
    track('screen_view', { screen: 'add' });
    loadHome();
    openAddDrama();
  }
  function showSlugDrama(slug) {
    showView('view-drama');
    hideSheet();
    track('screen_view', { screen: 'drama', drama_slug: slug });
    loadSlugDrama(slug);
  }

  function loadWatch(id) {
    // Lazily loaded: the player's module and, only when an episode actually
    // streams HLS, hls.js under it. The first load never fetches either.
    // Identity and VIP settle first: the player reads HC.viewer() for both,
    // and at boot it can open before /api/me and /api/subscription answer.
    Promise.all([mePromise, subPromise]).then(function () {
      return ensureScript('watch.js');
    }).then(function () {
      window.HCWatch.show(id);
    }).catch(function () {
      renderWatchShellError(id);
    });
  }
  function loadDownloads() {
    // Identity must be known before the view can tell a guest from a member,
    // but the subscription answer only splits VIP from free, so the view
    // renders without waiting for it and re-renders when it arrives (the
    // request can never fail the page: the server answers free on error and
    // a failed fetch falls back to the remembered state).
    Promise.all([mePromise, ensureScript('downloads.js')]).then(function () {
      window.HCDownloads.show();
      subPromise.then(function () {
        if (!$('view-downloads').hidden) window.HCDownloads.show();
      });
    }).catch(function () {
      $('dl-state').hidden = false;
      $('dl-body').hidden = true;
      $('dl-state').innerHTML = '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('feed_error_title')) + '</div></div>';
    });
  }

  function ensureScript(src) {
    if (!ensureScript.cache) ensureScript.cache = {};
    if (ensureScript.cache[src]) return ensureScript.cache[src];
    ensureScript.cache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/' + src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return ensureScript.cache[src];
  }
  window.HC.ensureScript = ensureScript;

  function renderWatchShellError(id) {
    $('watch-state').hidden = false;
    $('watch-body').hidden = true;
    $('watch-state').innerHTML =
      '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('watch_error_title')) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('state_error_body')) + '</p>' +
      '<button id="retry-watch" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div>';
    $('retry-watch').addEventListener('click', function () { showWatch(id); });
  }

  // ── Search ──────────────────────────────────────────────────────────────
  // The field lives in index.html (input[data-search]); the results render
  // here as the feed's rows, one drama per row. A deep link (/search?q=…)
  // runs its query on open.

  var searchLoad = 0;
  var searchTimer = null;

  function searchQuery() {
    var h = location.hash || '';
    var qi = h.indexOf('?');
    var q = new URLSearchParams(qi > -1 ? h.slice(qi + 1) : '').get('q');
    if (!q && location.pathname === '/search') {
      q = new URLSearchParams(location.search).get('q');
    }
    return (q || '').trim();
  }

  function loadSearch() {
    var q = searchQuery();
    var input = $('search-input');
    if (q && input.value !== q) input.value = q;
    if (q) runSearch(q);
    else renderSearchIntro();
  }

  function renderSearchIntro() {
    var state = $('search-state');
    var list = $('search-results');
    list.hidden = true;
    list.innerHTML = '';
    state.hidden = false;
    state.innerHTML =
      '<div class="state-empty"><div class="text-heading">' + esc(i18n.t('search_prompt_title')) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('search_prompt_body')) + '</p></div>';
  }

  function searchRowHtml(d) {
    var poster = '<span class="poster" style="background:' + posterColor(d.id) + ';display:block" aria-hidden="true"></span>';
    var openLabel = i18n.t('open_drama', { title: d.title });
    return '<li class="list-row">' + poster +
      '<a class="grow" href="#/drama/' + d.id + '" style="text-decoration:none;color:inherit" aria-label="' + esc(openLabel) + '">' +
      '<div style="font-weight:600">' + esc(d.title) + '</div>' +
      (d.summary ? '<div class="sm muted">' + esc(d.summary) + '</div>' : '') + '</a></li>';
  }

  function runSearch(q) {
    var token = ++searchLoad;
    var state = $('search-state');
    var list = $('search-results');
    state.hidden = false;
    state.innerHTML =
      '<ul class="list">' +
      '<li class="list-row"><span class="skeleton" style="width:56px;height:84px;border-radius:8px;flex:none"></span>' +
      '<div class="grow" style="display:flex;flex-direction:column;gap:6px"><div class="skeleton" style="height:12px;width:45%"></div><div class="skeleton" style="height:12px;width:70%"></div></div></li>' +
      '</ul>';
    list.hidden = true;
    list.innerHTML = '';
    api('search?q=' + encodeURIComponent(q)).then(function (data) {
      if (token !== searchLoad) return;
      state.hidden = true;
      state.innerHTML = '';
      list.hidden = false;
      if (!(data.dramas || []).length) {
        list.hidden = true;
        state.hidden = false;
        state.innerHTML =
          '<div class="state-empty"><div class="text-heading">' + esc(i18n.t('search_empty_title')) + '</div>' +
          '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('search_empty_body')) + '</p>' +
          '<a class="btn-secondary" href="#/add" style="text-decoration:none">' + esc(i18n.t('add_drama')) + '</a></div>';
        return;
      }
      list.innerHTML = data.dramas.map(searchRowHtml).join('');
    }).catch(function () {
      if (token !== searchLoad) return;
      list.hidden = true;
      state.hidden = false;
      state.innerHTML =
        '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('search_error_title')) + '</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('state_error_body')) + '</p>' +
        '<button id="retry-search" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div>';
      $('retry-search').addEventListener('click', function () { runSearch(q); });
    });
  }

  // ── Profiles ────────────────────────────────────────────────────────────
  // Who is watching: the account, its profiles (per-profile follows and
  // watches read the x-homeclip-profile header), and the form that creates
  // the first one. Everything renders here; the words come from i18n.

  function profilesError() {
    $('profiles-body').hidden = true;
    var state = $('profiles-state');
    state.hidden = false;
    state.innerHTML =
      '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('profiles_error_title')) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('state_error_body')) + '</p>' +
      '<button id="retry-profiles" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div>';
    $('retry-profiles').addEventListener('click', showProfiles);
  }

  function profileFormHtml(p, first) {
    p = p || { id: '', name: '', is_kids: false };
    return '<form' + (first ? ' data-first' : '') + ' data-profile-form="' + (p.id || 'new') + '"' +
      ' style="display:flex;flex-direction:column;gap:10px;margin-top:12px">' +
      '<input class="field" data-profile-id="' + p.id + '" value="' + esc(p.name) + '" maxlength="40"' +
      ' aria-label="' + esc(i18n.t('profile_name_label')) + '" data-i18n-ph="ph_profile_name" placeholder="e.g. Sari" autocomplete="off">' +
      '<label style="display:flex;align-items:center;gap:8px;min-height:44px">' +
      '<input type="checkbox" data-kids' + (p.is_kids ? ' checked' : '') + '>' +
      '<span class="sm">' + esc(i18n.t('profiles_kids')) + '</span></label>' +
      '<div style="display:flex;gap:8px">' +
      '<button type="submit" class="btn-primary">' + esc(i18n.t(p.id ? 'profiles_save' : 'profiles_create')) + '</button>' +
      '<button type="button" class="btn-secondary" data-cancel-profile>' + esc(i18n.t('cancel')) + '</button>' +
      (p.id ? '<button type="button" class="btn-secondary" data-delete-profile="' + p.id + '">' + esc(i18n.t('delete')) + '</button>' : '') +
      '</div></form>';
  }

  function renderProfiles(me) {
    var body = $('profiles-body');
    var state = $('profiles-state');
    state.hidden = true;
    state.innerHTML = '';
    body.hidden = false;
    if (!me.user) {
      body.innerHTML =
        '<div class="state-empty"><div class="text-heading">' + esc(i18n.t('downloads_vip_title')) + '</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('account_needed_title')) + '</p>' +
        '<button id="profiles-account" class="btn-primary">' + esc(i18n.t('account_needed_title')) + '</button></div>';
      $('profiles-account').addEventListener('click', function () {
        try { window.usernode.askForAccount({ action: i18n.t('profiles_title').toLowerCase() }); } catch (e) {}
      });
      return;
    }
    var profiles = me.profiles || [];
    var initial = (me.account && me.account.username || '?').charAt(0).toUpperCase();
    var rows = '<li class="list-row"><span class="avatar">' + esc(initial) + '</span>' +
      '<div class="grow"><div style="font-weight:600">' + esc(me.account.username) + '</div>' +
      '<div class="sm muted">' + esc(i18n.t('profiles_you')) + '</div></div></li>' +
      profiles.map(function (p) {
        return '<li class="list-row" data-profile-row="' + p.id + '">' +
          '<span class="avatar avatar-sm">' + esc(p.name.charAt(0)) + '</span>' +
          '<div class="grow"><div style="font-weight:600">' + esc(p.name) + '</div>' +
          (p.is_kids ? '<span class="chip">' + esc(i18n.t('profiles_kids')) + '</span>' : '') + '</div>' +
          '<button class="btn-secondary" data-edit-profile="' + p.id + '">' + esc(i18n.t('profiles_edit')) + '</button></li>';
      }).join('');
    // The create form sits outside the list: a form is not a list row.
    body.innerHTML = '<h1 class="title">' + esc(i18n.t('profiles_title')) + '</h1>' +
      '<ul class="list" style="margin-top:12px">' + rows + '</ul>' +
      profileFormHtml(null, !profiles.length);
    wireProfiles(me, profiles);
  }

  function wireProfiles(me, profiles) {
    var body = $('profiles-body');
    var editing = null;
    function refetch() {
      api('me').then(function (fresh) {
        renderProfiles(fresh);
      }).catch(profilesError);
    }
    body.onsubmit = function (ev) {
      ev.preventDefault();
      var form = ev.target;
      var isNew = form.getAttribute('data-profile-form') === 'new';
      var input = form.querySelector('input[data-profile-id]');
      var payload = {
        name: input.value,
        isKids: form.querySelector('[data-kids]').checked,
      };
      var call = isNew
        ? api('profiles', { method: 'POST', body: payload })
        : api('profiles/' + input.getAttribute('data-profile-id'), { method: 'PATCH', body: payload });
      call.then(refetch).catch(function (err) {
        toast(err.message || i18n.t('state_error_body'));
      });
    };
    body.onclick = function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-edit-profile],[data-cancel-profile],[data-delete-profile]') : null;
      if (!btn) return;
      if (btn.hasAttribute('data-cancel-profile')) { refetch(); return; }
      if (btn.hasAttribute('data-delete-profile')) {
        var p = profiles.filter(function (x) { return String(x.id) === btn.getAttribute('data-delete-profile'); })[0];
        if (!p || !window.confirm(i18n.t('profiles_delete_confirm', { name: p.name }))) return;
        api('profiles/' + p.id, { method: 'DELETE' }).then(refetch)
          .catch(function (err) { toast(err.message || i18n.t('state_error_body')); });
        return;
      }
      // Edit: the row's content becomes its form, name input carrying the
      // profile id.
      var id = btn.getAttribute('data-edit-profile');
      var p = profiles.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!p || editing === id) return;
      editing = id;
      var row = body.querySelector('[data-profile-row="' + id + '"]');
      row.innerHTML = '<span class="avatar avatar-sm">' + esc(p.name.charAt(0)) + '</span>' + profileFormHtml(p);
      var input = row.querySelector('input[data-profile-id]');
      input.value = p.name;
      input.focus();
    };
  }

  function loadProfiles() {
    mePromise.then(renderProfiles).catch(profilesError);
  }

  function resolveRoute() {
    var hash = location.hash || '#/';
    var m;
    if ((m = hash.match(/^#\/watch\/(\d+)$/))) {
      history.replaceState(null, '', '/');
      return ['watch', m[1]];
    }
    if ((m = hash.match(/^#\/drama\/(\d+)(?:\?ep=(\d+))?$/))) {
      history.replaceState(null, '', '/');
      return ['drama', m[1], m[2]];
    }
    // The VIP screens keep their hash: Stripe's return lands on the path.
    if ((m = hash.match(/^#\/vip(?:\/(manage|payments|return))?\/?$/))) return ['vip', m[1]];
    if (hash === '#/downloads') {
      history.replaceState(null, '', '/');
      return ['downloads'];
    }
    // Search, profiles and the Add drama sheet, in hash form.
    if ((m = hash.match(/^#\/(search|profiles|add)(?:\?.*)?\/?$/))) {
      history.replaceState(null, '', location.pathname === '/search' ? location.pathname + location.search : '/');
      return [m[1]];
    }
    // A drama addressed by slug (the Phase-2 share form).
    if ((m = hash.match(/^#\/dramas\/([a-z0-9-]+)\/?$/))) {
      history.replaceState(null, '', '/');
      return ['drama-slug', m[1]];
    }
    if ((m = location.pathname.match(/^\/watch\/(\d+)$/))) return ['watch', m[1]];
    if ((m = location.pathname.match(/^\/drama\/(\d+)$/))) return ['drama', m[1]];
    // A deep link like /search?q=harbour: the query stays on the path so
    // loadSearch can pick it up.
    if ((m = location.pathname.match(/^\/(search|profiles|add)\/?$/))) return [m[1]];
    if ((m = location.pathname.match(/^\/dramas\/([a-z0-9-]+)\/?$/))) return ['drama-slug', m[1]];
    if (location.pathname === '/downloads') return ['downloads'];
    if ((m = location.pathname.match(/^\/vip(?:\/(manage|payments|return))?\/?$/))) return ['vip', m[1]];
    return ['home'];
  }

  // The hash carries the route; Stripe's return lands on the path
  // /vip/return with no hash.
  function routeKey() {
    return location.hash && location.hash !== '#' ? location.hash.slice(1) : location.pathname;
  }

  function route() {
    var r = resolveRoute();
    window.scrollTo(0, 0);
    if (r[0] === 'watch') showWatch(r[1]);
    else if (r[0] === 'drama') showDrama(r[1], r[2]);
    else if (r[0] === 'drama-slug') showSlugDrama(r[1]);
    else if (r[0] === 'downloads') showDownloads();
    else if (r[0] === 'vip') showVip(r[1]);
    else if (r[0] === 'search') showSearch();
    else if (r[0] === 'profiles') showProfiles();
    else if (r[0] === 'add') showAdd();
    else showHome();
  }
  window.addEventListener('hashchange', route);
  $('back-btn').addEventListener('click', function () {
    if (history.length > 1) history.back();
    else location.hash = '#/';
  });
  $('watch-back').addEventListener('click', function () {
    var d = window.HCWatch ? window.HCWatch.dramaId() : null;
    location.hash = d ? '#/drama/' + d : '#/';
  });
  $('dl-back').addEventListener('click', function () {
    location.hash = '#/';
  });
  $('search-back').addEventListener('click', function () {
    location.hash = '#/';
  });
  $('profiles-back').addEventListener('click', function () {
    location.hash = '#/';
  });
  // Search: Enter (the form's submit) runs the query at once; typing runs
  // it after a short pause. An empty field returns to the intro.
  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('search-input').value.trim();
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    if (q) runSearch(q); else renderSearchIntro();
  });
  $('search-input').addEventListener('input', function () {
    var q = this.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) { searchTimer = null; renderSearchIntro(); return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 300);
  });

  // ── Boot ────────────────────────────────────────────────────────────────

  // Identity and the feed load in parallel. When /api/me cannot be reached
  // (an offline launch has no ?token=), the remembered account answers from
  // hc-me and the cached data renders — nothing is wiped.
  var mePromise = api('me').then(function (me) {
    viewerName = me.user ? me.user.username : null;
    viewerId = me.user ? me.user.id : null;
    isGuest = !!me.guest;
    if (viewerId) {
      var meCached = readJSON(meCacheKey(), {}) || {};
      meCached.id = viewerId;
      meCached.username = viewerName;
      meCached.guest = false;
      writeJSON(meCacheKey(), meCached);
    }
    signedIn = !!me.user;
    if (!me.user) $('add-drama-btn').disabled = true;
    return me;
  }).catch(function () {
    var me = readJSON(meCacheKey(), null);
    if (me) { viewerName = me.username; viewerId = me.id; isGuest = false; }
    return { user: me ? { id: me.id, username: me.username } : null, guest: false };
  });

  // VIP is fetched once per boot; the downloads and watch views read it.
  // Kept as a promise so those views can wait for it, and remembered in the
  // hc-me cache so an offline launch still knows a VIP viewer is one.
  var subPromise = api('subscription').then(function (s) {
    viewerVip = !!s.vip;
    var me = readJSON(meCacheKey(), null);
    if (me) { me.vip = viewerVip; writeJSON(meCacheKey(), me); }
    return s;
  }).catch(function () {
    var me = readJSON(meCacheKey(), null);
    if (me) viewerVip = !!me.vip;
  });

  i18n.init();
  i18n.onChange(function () {
    offlineBanner($('offline-banner') && !$('offline-banner').hidden);
  });

  // The offline shell. Registration can fail in a third-party iframe that
  // refuses storage; that is a normal degradation, not an error to surface.
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    } catch (e) {}
  }
  // Installability at the app's own address: remember the prompt event so
  // the browser's own install offer works, and record when it is accepted.
  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installEvent = e;
  });
  window.addEventListener('appinstalled', function () {
    track('install_prompt_accepted');
  });

  if (!/^#\/(drama|watch)\/\d+(\?ep=\d+)?$/.test(location.hash || '#/') && !/^\/(drama|watch)\/\d+$/.test(location.pathname) && location.pathname !== '/downloads' && (location.hash || '#/') !== '#/downloads' && !/^\/vip/.test(routeKey())) {
    renderHomeSkeleton();
  }
  route();
  replayQueue();
})();

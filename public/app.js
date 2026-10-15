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
    return fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        TOKEN ? { 'x-usernode-token': TOKEN } : {}
      ),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong');
          err.status = res.status;
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

  var $ = function (id) { return document.getElementById(id); };
  var viewerName = null;
  var viewerId = null;
  var isGuest = false;
  var viewerVip = false;

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
      esc(next.hero.minutes ? i18n.t('n_min', { n: next.hero.minutes }) : '');
    $('hero-watch').onclick = function () { watchEpisode(next.hero, loadHome); };
  }

  function upcomingHtml(next) {
    var row = $('upcoming-row');
    row.innerHTML = next.upcoming.map(function (e) {
      return '<div class="ep" data-drama="' + next.dramaId + '">' +
        '<div class="scr">' + esc(i18n.t('ep_n', { n: e.number })) + '</div><div class="foot"></div>' +
        '<div class="sm">' + esc(e.title) + '</div></div>';
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
    return '<li class="list-row"><a href="#/drama/' + d.id + '" class="poster" style="background:' + posterColor(d.id) + ';display:block" aria-label="' + esc(i18n.t('open_drama', { title: d.title })) + '"></a>' +
      '<a class="grow" href="#/drama/' + d.id + '" style="text-decoration:none;color:inherit">' +
      '<div style="font-weight:600">' + esc(d.title) + '</div>' +
      '<div class="sm muted">' + esc(seasons + ', ' + episodes) + '</div>' +
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
    if (ep.media_url) { location.hash = '#/watch/' + ep.id; return; }
    if (ep.watch_url) window.open(ep.watch_url, '_blank', 'noopener');
    api('episodes/' + ep.id + '/watched', { method: 'PUT' }).then(function () {
      done();
    }).catch(function () {
      // A guest is asked for an account by the bridge; nothing to do here.
      done();
    });
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
    $('retry-drama').addEventListener('click', function () { loadDrama(currentDramaId); });
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
    return '<li class="list-row"><button class="icon-btn" style="width:auto;height:auto;padding:0;border:0;background:none" data-open-episode="' + e.id + '" aria-label="' + esc(i18n.t('episode_details')) + '">' + scr + '</button>' +
      '<button class="grow" style="text-align:left;border:0;background:none;font:inherit;color:inherit;padding:0;min-height:44px" data-open-episode="' + e.id + '">' +
      '<div style="font-weight:' + (isNext ? '600' : '500') + '">' + esc(e.title) + '</div>' +
      (meta ? '<div class="sm muted">' + esc(meta) + '</div>' : '') +
      '</button>' + action + '</li>';
  }

  function renderDrama(data) {
    currentDrama = data;
    $('drama-state').hidden = true;
    $('drama-state').innerHTML = '';
    $('drama-body').hidden = false;

    $('drama-poster').style.background = posterColor(data.drama.id);
    $('drama-title').textContent = data.drama.title;
    document.title = i18n.t('title_drama', { title: data.drama.title });
    var desc = (data.drama.synopsis ? data.drama.synopsis + ' ' : '') +
      i18n.t('added_by', { name: data.drama.added_by_username });
    $('drama-desc').textContent = desc;
    var folBtn = $('drama-follow');
    folBtn.textContent = data.following ? i18n.t('following') : i18n.t('follow');
    folBtn.setAttribute('aria-pressed', data.following ? 'true' : 'false');
    folBtn.className = data.following ? 'fol' : 'btn-secondary';
    $('remove-drama-btn').hidden = !data.drama.mine;

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
          if (err.status !== 401) loadDrama(currentDramaId);
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
        queuedApi('episodes/' + ep.id + '/watched', { method: on ? 'DELETE' : 'PUT' })
          .then(function (r) { if (!r.queued) loadDramaAgain(); })
          .catch(function (err) {
            if (err.status !== 401) loadDramaAgain();
          });
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
    loadDrama(currentDramaId);
  }

  var currentDramaId = null;
  function loadDrama(id) {
    currentDramaId = id;
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

  // ── Sheets' contents ────────────────────────────────────────────────────

  function openAddDrama() {
    $('drama-title-input').value = '';
    $('drama-desc-input').value = '';
    $('add-drama-error').hidden = true;
    showSheet('sheet-add-drama');
  }
  $('add-drama-btn').addEventListener('click', openAddDrama);
  $('save-drama').addEventListener('click', function () {
    api('dramas', { method: 'POST', body: {
      title: $('drama-title-input').value,
      synopsis: $('drama-desc-input').value,
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

  // ── Routing ─────────────────────────────────────────────────────────────
  // Two entry styles agree: the platform-facing path routes
  // (/drama/:id, /watch/:id, /downloads) and the in-app hash routes
  // (#/drama/:id, #/watch/:id, #/downloads). A hash navigation wins over
  // the entry path and resets the path to /, so the two never disagree.

  function showHome() {
    $('view-home').hidden = false;
    $('view-drama').hidden = true;
    $('view-watch').hidden = true;
    $('view-downloads').hidden = true;
    document.title = i18n.t('title_home');
    hideSheet();
    track('screen_view', { screen: 'home' });
    loadHome();
  }
  function showDrama(id) {
    $('view-home').hidden = true;
    $('view-drama').hidden = false;
    $('view-watch').hidden = true;
    $('view-downloads').hidden = true;
    hideSheet();
    track('screen_view', { screen: 'drama', drama_id: Number(id) });
    loadDrama(id);
  }
  function showWatch(id) {
    $('view-home').hidden = true;
    $('view-drama').hidden = true;
    $('view-watch').hidden = false;
    $('view-downloads').hidden = true;
    hideSheet();
    track('screen_view', { screen: 'watch', episode_id: Number(id) });
    loadWatch(id);
  }
  function showDownloads() {
    $('view-home').hidden = true;
    $('view-drama').hidden = true;
    $('view-watch').hidden = true;
    $('view-downloads').hidden = false;
    document.title = i18n.t('title_downloads');
    hideSheet();
    track('screen_view', { screen: 'downloads' });
    loadDownloads();
  }

  function loadWatch(id) {
    // Lazily loaded: the player's module and, only when an episode actually
    // streams HLS, hls.js under it. The first load never fetches either.
    ensureScript('watch.js').then(function () {
      window.HCWatch.show(id);
    }).catch(function () {
      renderWatchShellError(id);
    });
  }
  function loadDownloads() {
    ensureScript('downloads.js').then(function () {
      window.HCDownloads.show();
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

  function resolveRoute() {
    var hash = location.hash || '#/';
    var m;
    if ((m = hash.match(/^#\/watch\/(\d+)$/))) {
      history.replaceState(null, '', '/');
      return ['watch', m[1]];
    }
    if ((m = hash.match(/^#\/drama\/(\d+)$/))) {
      history.replaceState(null, '', '/');
      return ['drama', m[1]];
    }
    if (hash === '#/downloads') {
      history.replaceState(null, '', '/');
      return ['downloads'];
    }
    if ((m = location.pathname.match(/^\/watch\/(\d+)$/))) return ['watch', m[1]];
    if ((m = location.pathname.match(/^\/drama\/(\d+)$/))) return ['drama', m[1]];
    if (location.pathname === '/downloads') return ['downloads'];
    return ['home'];
  }

  function route() {
    var r = resolveRoute();
    if (r[0] === 'watch') showWatch(r[1]);
    else if (r[0] === 'drama') showDrama(r[1]);
    else if (r[0] === 'downloads') showDownloads();
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

  // ── Boot ────────────────────────────────────────────────────────────────

  // Identity and the feed load in parallel. When /api/me cannot be reached
  // (an offline launch has no ?token=), the remembered account answers from
  // hc-me and the cached data renders — nothing is wiped.
  var mePromise = api('me').then(function (me) {
    viewerName = me.user ? me.user.username : null;
    viewerId = me.user ? me.user.id : null;
    isGuest = !!me.guest;
    if (viewerId) writeJSON(meCacheKey(), { id: viewerId, username: viewerName, guest: false });
    if (!me.user) $('add-drama-btn').disabled = true;
    return me;
  }).catch(function () {
    var me = readJSON(meCacheKey(), null);
    if (me) { viewerName = me.username; viewerId = me.id; isGuest = false; }
    return { user: me ? { id: me.id, username: me.username } : null, guest: false };
  });

  // VIP is fetched once per boot; the downloads and watch views read it.
  api('subscription').then(function (s) {
    viewerVip = !!s.vip;
  }).catch(function () {});

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

  if (!/^#\/(drama|watch)\/\d+$/.test(location.hash || '#/') && !/^\/(drama|watch)\/\d+$/.test(location.pathname) && location.pathname !== '/downloads' && (location.hash || '#/') !== '#/downloads') {
    renderHomeSkeleton();
  }
  route();
  replayQueue();
})();

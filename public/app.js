/* HomeClip client: the drama feed (screen 1) and a drama's page (screen 2),
 * with hash routes #/ and #/drama/:id, sheets for Add drama, Add episode,
 * episode details and Report. The markup and classes are the ones the spec's
 * screens drew; this script only fills them from data and wires the actions.
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
  var isGuest = false;

  // ── Sheets ──────────────────────────────────────────────────────────────

  var openSheet = null;
  function showSheet(id) {
    hideSheet();
    openSheet = $(id);
    openSheet.classList.remove('hidden');
    $('sheet-backdrop').classList.remove('hidden');
  }
  function hideSheet() {
    if (openSheet) openSheet.classList.add('hidden');
    openSheet = null;
    $('sheet-backdrop').classList.add('hidden');
  }
  $('sheet-backdrop').addEventListener('click', hideSheet);
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
    b.addEventListener('click', hideSheet);
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

  function renderHomeError() {
    $('next-section').hidden = true;
    $('feed-label').hidden = true;
    var list = $('feed-list');
    list.hidden = true;
    list.innerHTML = '';
    var state = $('home-state');
    state.hidden = false;
    state.innerHTML =
      '<div class="state-error"><div class="text-body font-semibold">The feed could not be loaded</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">Nothing you marked was lost. Check your connection and try again.</p>' +
      '<button id="retry-btn" class="btn-secondary">Retry</button></div>';
    $('retry-btn').addEventListener('click', loadHome);
  }

  function heroHtml(next) {
    var pct = next.progress ? Math.round((next.progress.watched / next.progress.total) * 100) : 0;
    $('hero-season').textContent = next.dramaTitle + ', Season ' + next.season;
    $('hero-title').textContent = 'Episode ' + next.hero.number + ': ' + next.hero.title;
    $('hero-bar').style.width = pct + '%';
    $('hero-note').innerHTML =
      (next.progress ? esc(next.progress.watched + ' of ' + next.progress.total + ' watched this season') + '<br>' : '') +
      esc(next.hero.minutes ? next.hero.minutes + ' min' : '');
    $('hero-watch').onclick = function () { watchEpisode(next.hero, loadHome); };
  }

  function upcomingHtml(next) {
    var row = $('upcoming-row');
    row.innerHTML = next.upcoming.map(function (e) {
      return '<div class="ep" data-drama="' + next.dramaId + '">' +
        '<div class="scr">Ep ' + e.number + '</div><div class="foot"></div>' +
        '<div class="sm">' + esc(e.title) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(row.children, function (el) {
      el.addEventListener('click', function () {
        location.hash = '#/drama/' + el.getAttribute('data-drama');
      });
    });
  }

  function feedRowHtml(d, viewerName) {
    var note;
    if (d.note.kind === 'progress') {
      var pct = Math.round(d.note.pct * 100);
      note = '<div class="bar" style="margin-top:6px" aria-label="' + esc(d.note.text) + '"><i style="width:' + pct + '%"></i></div>';
    } else if (d.note.kind === 'new') {
      note = '<span class="chip">New episode</span>';
    } else if (d.note.kind === 'others' || d.note.kind === 'finished') {
      note = '<div class="sm tag">' + esc(d.note.text) + '</div>';
    } else if (d.note.text) {
      note = '<div class="sm muted">' + esc(d.note.text) + '</div>';
    } else {
      note = '';
    }
    var follow = d.following
      ? '<button class="fol" data-follow="' + d.id + '" data-on="1">Following</button>'
      : '<button class="btn-secondary" data-follow="' + d.id + '">Follow</button>';
    return '<li class="list-row"><a href="#/drama/' + d.id + '" class="poster" style="background:' + posterColor(d.id) + ';display:block" aria-label="Open ' + esc(d.title) + '"></a>' +
      '<a class="grow" href="#/drama/' + d.id + '" style="text-decoration:none;color:inherit">' +
      '<div style="font-weight:600">' + esc(d.title) + '</div>' +
      '<div class="sm muted">' + d.seasons + (d.seasons === 1 ? ' season, ' : ' seasons, ') + d.episodes + (d.episodes === 1 ? ' episode' : ' episodes') + '</div>' +
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

    var label = 'Drama feed' + (DEMO ? ' <span data-usernode-demo-note>(Staging demo)</span>' : '');
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
        '<div class="state-empty"><div class="text-heading">No dramas yet</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">Add the first drama your group watches.</p>' +
        '<button id="empty-add-drama" class="btn-primary">Add drama</button></div>';
      $('empty-add-drama').addEventListener('click', function () { openAddDrama(); });
      return;
    }
    labelEl.hidden = false;
    $('add-drama-btn').hidden = false;
    list.innerHTML = data.dramas.map(function (d) { return feedRowHtml(d, viewerName); }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-follow]'), function (b) {
      b.addEventListener('click', function () {
        var on = b.getAttribute('data-on') === '1';
        api('dramas/' + b.getAttribute('data-follow') + '/follow', { method: on ? 'DELETE' : 'PUT' })
          .then(loadHome)
          .catch(function () { loadHome(); });
      });
    });
  }

  function loadHome() {
    var token = ++homeLoad;
    renderHomeSkeleton();
    api('feed').then(function (data) {
      if (token !== homeLoad) return;
      renderHome(data);
    }).catch(function () {
      if (token !== homeLoad) return;
      renderHomeError();
    });
  }

  function watchEpisode(ep, done) {
    api('episodes/' + ep.id + '/watched', { method: 'PUT' }).then(function () {
      if (ep.watch_url) window.open(ep.watch_url, '_blank', 'noopener');
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
      '<div class="state-error"><div class="text-body font-semibold">This drama could not be loaded</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">Nothing you marked was lost. Check your connection and try again.</p>' +
      '<button id="retry-drama" class="btn-secondary">Retry</button></div>';
    $('retry-drama').addEventListener('click', function () { loadDrama(currentDramaId); });
  }

  function seasonProgressHtml(eps) {
    var total = eps.length;
    var watched = eps.filter(function (e) { return e.viewer_watched; }).length;
    var pct = total ? Math.round((watched / total) * 100) : 0;
    $('season-bar').style.width = pct + '%';
    $('season-progress').textContent = total
      ? watched + ' of ' + total + ' watched this season'
      : '';
    return watched < total ? eps.filter(function (e) { return !e.viewer_watched; })[0] : null;
  }

  function epMeta(e) {
    var parts = [];
    if (e.minutes) parts.push(e.minutes + ' min');
    var by = watchedBy(e.watched_by, viewerName);
    if (by) parts.push('watched by ' + by);
    return parts.join(', ');
  }

  function epRowHtml(e, nextEp) {
    var isNext = nextEp && nextEp.id === e.id;
    var scr = '<div class="scr' + (isNext ? ' next' : '') + '">' + e.number + '</div>';
    var action;
    if (isNext) {
      action = '<button class="btn-primary" data-watch="' + e.id + '">' + svg('M7 5l12 7-12 7z') + 'Watch</button>';
    } else if (e.viewer_watched) {
      action = '<button class="check" data-watch="' + e.id + '" data-on="1" aria-label="Watched">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg></button>';
    } else {
      action = '<button class="check off" data-watch="' + e.id + '" aria-label="Mark watched">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg></button>';
    }
    var meta = epMeta(e);
    return '<li class="list-row"><button class="icon-btn" style="width:auto;height:auto;padding:0;border:0;background:none" data-open-episode="' + e.id + '" aria-label="Episode details">' + scr + '</button>' +
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
    var desc = (data.drama.synopsis ? data.drama.synopsis + ' ' : '') +
      'Added by ' + data.drama.added_by_username;
    $('drama-desc').textContent = desc;
    var folBtn = $('drama-follow');
    folBtn.textContent = data.following ? 'Following' : 'Follow';
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
      api('dramas/' + currentDrama.drama.id + '/follow', { method: on ? 'DELETE' : 'PUT' })
        .then(function (r) {
          currentDrama.following = r.following;
          folBtn.textContent = r.following ? 'Following' : 'Follow';
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
      if (!window.confirm('Remove ' + currentDrama.drama.title + ' and its episodes?')) return;
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
          return '<button data-season="' + s + '"' + (s === currentSeason ? ' class="on"' : '') + '>Season ' + s + '</button>';
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
      list.innerHTML = '<li class="state-empty" style="list-style:none"><div class="text-body font-semibold">No episodes yet</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">Add the first episode of this season.</p></li>';
      $('add-episode-btn').classList.remove('btn-secondary');
      $('add-episode-btn').classList.add('btn-primary');
      $('season-bar').style.width = '0%';
      $('season-progress').textContent = '';
      return;
    }
    $('add-episode-btn').classList.add('btn-secondary');
    $('add-episode-btn').classList.remove('btn-primary');
    var nextEp = seasonProgressHtml(eps);
    list.innerHTML = eps.map(function (e) { return epRowHtml(e, nextEp); }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-watch]'), function (b) {
      b.addEventListener('click', function () {
        var ep = eps.filter(function (e) { return String(e.id) === b.getAttribute('data-watch'); })[0];
        var on = b.getAttribute('data-on') === '1';
        api('episodes/' + ep.id + '/watched', { method: on ? 'DELETE' : 'PUT' })
          .then(loadDramaAgain)
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
    api('dramas/' + id).then(function (data) {
      if (token !== dramaLoad) return;
      renderDrama(data);
    }).catch(function () {
      if (token !== dramaLoad) return;
      renderDramaError();
    });
  }

  // ── Sheets' contents ────────────────────────────────────────────────────

  function openAddDrama() {
    $('drama-title-input').value = '';
    $('drama-desc-input').value = '';
    $('add-drama-error').hidden = true;
    showSheet('sheet-add-drama');
    $('drama-title-input').focus();
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
    $('add-episode-error').hidden = true;
    showSheet('sheet-add-episode');
    $('ep-title-input').focus();
  }
  $('save-episode').addEventListener('click', function () {
    api('dramas/' + currentDramaId + '/episodes', { method: 'POST', body: {
      season: $('ep-season-input').value,
      number: $('ep-number-input').value,
      title: $('ep-title-input').value,
      minutes: $('ep-minutes-input').value || null,
      watch_url: $('ep-url-input').value || null,
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
    $('episode-detail-title').textContent = 'Season ' + ep.season + ', Episode ' + ep.number + ': ' + ep.title;
    $('episode-detail-meta').textContent =
      (ep.minutes ? ep.minutes + ' min, ' : '') + 'added by ' + ep.added_by_username;
    var by = watchedBy(ep.watched_by, viewerName);
    $('episode-detail-watchers').textContent = by ? 'Watched by ' + by : 'Not watched yet';
    var link = $('episode-detail-link');
    if (ep.watch_url) {
      link.href = ep.watch_url;
      link.textContent = ep.watch_url;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
    $('remove-episode-btn').hidden = !ep.mine;
    $('remove-episode-btn').onclick = function () {
      if (!window.confirm('Remove this episode?')) return;
      hideSheet();
      api('episodes/' + ep.id, { method: 'DELETE' }).then(loadDramaAgain).catch(function () {});
    };
    $('report-episode-btn').onclick = function () {
      openReport({ episode_id: ep.id, name: ep.title });
    };
    showSheet('sheet-episode');
  }

  function openReport(target) {
    $('report-context').textContent = 'Report ' + target.name + ' to the group' + "'s admins. Nothing is hidden automatically.";
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

  // ── Routing ─────────────────────────────────────────────────────────────

  function route() {
    var hash = location.hash || '#/';
    var drama = hash.match(/^#\/drama\/(\d+)$/);
    if (drama) {
      $('view-home').hidden = true;
      $('view-drama').hidden = false;
      hideSheet();
      loadDrama(drama[1]);
    } else {
      $('view-drama').hidden = true;
      $('view-home').hidden = false;
      hideSheet();
      currentSeason = null;
      loadHome();
    }
  }
  window.addEventListener('hashchange', route);
  $('back-btn').addEventListener('click', function () {
    if (history.length > 1) history.back();
    else location.hash = '#/';
  });

  // ── Boot ────────────────────────────────────────────────────────────────

  // The skeleton shows while /api/me is still pending too, not only while
  // the feed request is: route() (which calls loadHome) waits for it.
  if (!/^#\/drama\/\d+$/.test(location.hash || '#/')) renderHomeSkeleton();

  api('me').then(function (me) {
    viewerName = me.user ? me.user.username : null;
    isGuest = !!me.guest;
    if (!me.user) $('add-drama-btn').disabled = true;
    route();
  }).catch(function () {
    route();
  });
})();

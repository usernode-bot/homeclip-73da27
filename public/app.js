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
    var url = '/api/tracker/' + path + (DEMO ? sep + 'demo=1' : '');
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
  var isGuest = false;
  var signedIn = false;

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
    clearInterval(adTimer);
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
      esc(next.hero.minutes ? next.hero.minutes + ' min' : '') +
      (next.hero.access !== 'free' ? ' ' + accessChip(next.hero.access) : '');
    $('hero-watch').onclick = function () {
      watchEpisode(Object.assign({ season: next.season }, next.hero), loadHome);
    };
  }

  function upcomingHtml(next) {
    var row = $('upcoming-row');
    row.innerHTML = next.upcoming.map(function (e) {
      return '<div class="ep" data-drama="' + next.dramaId + '">' +
        '<div class="scr">Ep ' + e.number + '</div><div class="foot"></div>' +
        '<div class="sm">' + esc(e.title) + '</div>' + accessChip(e.access) + '</div>';
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
      '<div class="sm muted">' + d.seasons + (d.seasons === 1 ? ' season, ' : ' seasons, ') + d.episodes + (d.episodes === 1 ? ' episode' : ' episodes') +
      ' ' + labelChip(d.access_label) + '</div>' +
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
    if (ep.locked) { showPaywall(ep); return; }
    var go = function () {
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
    var chip = accessChip(e.access);
    return '<li class="list-row"><button class="icon-btn" style="width:auto;height:auto;padding:0;border:0;background:none" data-open-episode="' + e.id + '" aria-label="Episode details">' + scr + '</button>' +
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

    $('drama-poster').style.background = posterColor(data.drama.id);
    $('drama-title').textContent = data.drama.title;
    var desc = (data.drama.synopsis ? data.drama.synopsis + ' ' : '') +
      'Added by ' + data.drama.added_by_username;
    $('drama-desc').textContent = desc;
    var folBtn = $('drama-follow');
    folBtn.textContent = data.following ? 'Following' : 'Follow';
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
        if (!on && ep.locked) { showPaywall(ep); return; }
        var go = function () {
          api('episodes/' + ep.id + '/watched', { method: on ? 'DELETE' : 'PUT' })
            .then(loadDramaAgain)
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
    $('ep-access-input').value = 'free';
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
    $('episode-detail-title').textContent = 'Season ' + ep.season + ', Episode ' + ep.number + ': ' + ep.title;
    $('episode-detail-meta').textContent =
      (ep.minutes ? ep.minutes + ' min, ' : '') + 'added by ' + ep.added_by_username;
    var by = watchedBy(ep.watched_by, viewerName);
    $('episode-detail-watchers').textContent = by ? 'Watched by ' + by : 'Not watched yet';
    $('episode-detail-access').innerHTML = accessChip(ep.access);
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
    $('share-episode-btn').onclick = function () {
      shareLink(episodeUrl(currentDrama.drama.id, ep.id),
        currentDrama.drama.title + ' - ' + ep.title);
    };
    loadComments(ep.id);
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

  // The hash carries the route; Stripe's return lands on the path
  // /vip/return with no hash.
  function routeKey() {
    return location.hash && location.hash !== '#' ? location.hash.slice(1) : location.pathname.replace(/^\/tracker(?=\/)/, '');
  }

  function route() {
    var key = routeKey();
    // #/drama/:id, and a shared episode link #/drama/:id?ep=:episodeId.
    var drama = key.match(/^\/drama\/(\d+)(?:\?ep=(\d+))?$/);
    var vip = key.match(/^\/vip(?:\/(manage|payments|return))?\/?$/);
    $('view-home').hidden = !!(drama || vip);
    $('view-drama').hidden = !drama;
    $('view-vip').hidden = !vip;
    hideSheet();
    window.scrollTo(0, 0);
    if (drama) {
      pendingEpisodeId = drama[2] ? Number(drama[2]) : null;
      loadDrama(drama[1]);
    } else if (vip) {
      loadVip(vip[1] === 'return' ? 'ret' : (vip[1] || 'vip'));
    } else {
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
  if (routeKey() === '/') renderHomeSkeleton();

  api('me').then(function (me) {
    viewerName = me.user ? me.user.username : null;
    isGuest = !!me.guest;
    signedIn = !!me.user;
    if (!me.user) $('add-drama-btn').disabled = true;
    route();
  }).catch(function () {
    route();
  });
})();

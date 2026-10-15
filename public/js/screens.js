// HC.screens — every screen, plus the shared UI helpers they render with.
// Each screen is a function mount(view, params) called by the router; it
// renders the content's own loading shape first (skeleton), then the cached
// data if the profile has one, then the fresh network answer. Failures show
// the error state only when there is no cached copy to fall back on.
//
// Data rules used throughout:
//   - reads go through HC.api.fresh(key, path): stale-while-revalidate over
//     the profile-namespaced cache;
//   - writes go through HC.api.mutate(...): on the network, or queued durably
//     when offline (the UI then says so, never "saved" when it isn't);
//   - a Kids profile never receives mature dramas — the server filters them,
//     so these screens have no maturity toggle of their own.

window.HC = window.HC || {};

HC.screens = (function () {
  const api = () => HC.api;

  // ── Small helpers ────────────────────────────────────────────────────────

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(message) {
    let t = document.getElementById('hc-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hc-toast';
      t.setAttribute('role', 'status');
      t.className = 'pointer-events-none fixed inset-x-4 bottom-6 z-50 mx-auto max-w-md rounded-lg bg-fg px-4 py-3 text-center text-body text-ground shadow-lg';
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  function fmtDur(sec) {
    sec = Number(sec) || 0;
    if (sec >= 3600) {
      const m = Math.round((sec % 3600) / 60);
      return Math.floor(sec / 3600) + 'h' + (m ? ' ' + m + 'm' : '');
    }
    if (sec >= 60) return Math.round(sec / 60) + ' min';
    return sec ? sec + 's' : '';
  }

  function fmtPos(sec) {
    sec = Math.max(Number(sec) || 0, 0);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function pct(pos, dur) {
    if (!dur) return pos > 0 ? 100 : 0;
    return Math.min(Math.round((pos / dur) * 100), 100);
  }

  function matureBadge() {
    return '<span class="ml-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-small text-muted">Mature</span>';
  }

  function avatarHtml(p, cls) {
    const initial = esc((p.name || '?').trim().charAt(0).toUpperCase() || '?');
    const inner = p.avatar_url
      ? '<img src="' + esc(p.avatar_url) + '" alt="" class="h-full w-full rounded-full object-cover">'
      : '<span aria-hidden="true">' + initial + '</span>';
    return '<span class="avatar ' + (cls || '') + '">' + inner + '</span>';
  }

  // A drama poster tile. The catalogue stores a colour, not artwork, so the
  // tile is a plain raised block carrying the title: no invented gradients
  // or images.
  function posterTile(d, extra) {
    const badge = d.maturity === 'mature' ? matureBadge() : '';
    return (
      '<a href="/dramas/' + esc(d.slug) + '" data-nav class="group block">' +
      '<div class="flex aspect-[2/3] flex-col justify-between rounded-xl border border-line bg-raised p-3">' +
      '<div class="text-body font-medium leading-snug">' + esc(d.title) + '</div>' +
      '<div class="text-small text-muted">' + esc(d.seasons ? d.seasons + (d.seasons === 1 ? ' season' : ' seasons') : '') + '</div>' +
      '</div>' +
      '<div class="mt-1 px-0.5 text-small text-muted">' + badge + (extra || '') + '</div>' +
      '</a>'
    );
  }

  function resumeBar(position, duration) {
    if (!position) return '';
    return '<div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-line">' +
      '<div class="h-full rounded-full bg-accent" style="width:' + pct(position, duration) + '%"></div></div>';
  }

  function starsHtml(myStars, groupAverage, groupCount) {
    const mine = Number(myStars) || 0;
    let out = '<div class="flex items-center gap-2" data-stars role="group" aria-label="Your rating">';
    for (let i = 1; i <= 5; i++) {
      out += '<button type="button" data-star="' + i + '" aria-label="Rate ' + i + ' star' + (i > 1 ? 's' : '') + '" class="min-h-11 min-w-11 text-heading ' +
        (i <= mine ? 'text-accent' : 'text-line') + '" aria-pressed="' + (i <= mine) + '">&#9733;</button>';
    }
    out += '</div>';
    if (groupCount > 0) {
      out += '<p class="text-small text-muted">Group rating ' + Number(groupAverage).toFixed(1) + ' from ' + groupCount +
        (groupCount === 1 ? ' person' : ' people') + '</p>';
    }
    return out;
  }

  function errorBox(message, retryAttr) {
    return '<div class="state-error">' +
      '<p class="text-body font-medium">' + esc(message) + '</p>' +
      '<p class="text-small text-muted">Your saved list and history still work offline.</p>' +
      '<button type="button" class="btn-secondary" ' + retryAttr + '>Retry</button>' +
      '</div>';
  }

  function emptyBox(title, body, actionHtml) {
    return '<div class="state-empty">' +
      '<p class="text-body font-medium">' + esc(title) + '</p>' +
      '<p class="text-small text-muted">' + esc(body) + '</p>' +
      (actionHtml || '') +
      '</div>';
  }

  function skeletonRows(n, tall) {
    let out = '<div class="space-y-3">';
    for (let i = 0; i < (n || 3); i++) {
      out += '<div class="flex items-center gap-3">' +
        '<div class="skeleton h-14 w-14 shrink-0 rounded-xl"></div>' +
        '<div class="flex-1 space-y-2"><div class="skeleton h-4 w-2/3"></div><div class="skeleton h-3 w-1/3"></div></div>' +
        (tall ? '<div class="skeleton h-9 w-20 rounded-lg"></div>' : '') +
        '</div>';
    }
    return out + '</div>';
  }

  function skeletonTiles(n) {
    let out = '<div class="grid grid-cols-3 gap-3">';
    for (let i = 0; i < (n || 6); i++) {
      out += '<div><div class="skeleton aspect-[2/3] rounded-xl"></div><div class="skeleton mt-2 h-3 w-3/4"></div></div>';
    }
    return out + '</div>';
  }

  // Stale-while-revalidate section loader. Renders the cached copy at once
  // (marked stale so callers can dim it), then replaces it with the network
  // answer. Empty data shows the section's empty state; a network failure
  // with no cache shows the error state with Retry.
  function loadSection(box, key, path, handlers) {
    let cached = null;
    try { cached = api().cacheGet(key); } catch (e) {}
    // The cached copy follows the same rules as a fresh one: empty shows the
    // empty state, not a broken draw.
    if (cached) {
      if (handlers.isEmpty && handlers.isEmpty(cached)) {
        if (handlers.empty) box.innerHTML = handlers.empty(cached);
      } else {
        handlers.draw(box, cached, true);
      }
    } else {
      box.innerHTML = (handlers.skeleton || skeletonRows)();
    }

    function run() {
      return api().fresh(key, path).then(function (data) {
        if (handlers.isEmpty && handlers.isEmpty(data)) {
          box.innerHTML = handlers.empty ? handlers.empty(data) : '';
        } else {
          handlers.draw(box, data, false);
        }
      }).catch(function (err) {
        if (cached) return; // stale copy stays; nothing to shout about
        box.innerHTML = errorBox(handlers.errorText || 'Could not load this.', retryAttr);
      });
    }
    const retryAttr = 'data-retry="' + esc(key) + '"';
    box.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-retry]');
      if (!btn || btn.getAttribute('data-retry') !== key) return;
      box.innerHTML = (handlers.skeleton || skeletonRows)();
      run();
    });
    return run();
  }

  function bindClicks(root, map) {
    root.addEventListener('click', function (e) {
      for (const sel in map) {
        const target = e.target.closest(sel);
        if (target && root.contains(target)) { map[sel](e, target); return; }
      }
    });
  }

  function offlineResult(result, savedText) {
    if (result && result.queued) toast('Saved on this device. Will sync when you are back online.');
    else if (result && result.degraded) toast(savedText || 'Saved for this session only. This device does not keep storage.');
  }

  function guestBlocked() {
    toast('Make an account in Homeroom to save this.');
  }

  function write(method, path, body, opts) {
    return api().mutate(method, path, body, opts).catch(function (err) {
      if (err.guestWrite) guestBlocked();
      throw err;
    });
  }

  // ── Home ─────────────────────────────────────────────────────────────────

  function nextUpHtml(next) {
    const ep = next.episode;
    return (
      '<div class="card">' +
      '<div class="text-small text-muted">' + esc(next.drama.title) + ' · Season ' + next.seasonNumber +
      ', watched ' + next.watchedInSeason + ' of ' + next.seasonTotal + '</div>' +
      '<div class="mt-1 text-heading">' + esc('Episode ' + ep.number + ': ' + ep.title) + '</div>' +
      resumeBar(ep.positionSeconds, ep.durationSeconds) +
      '<div class="mt-3 flex items-center gap-2">' +
      '<a href="/watch/' + ep.id + '" data-nav class="btn-primary">Continue watching</a>' +
      (ep.durationSeconds ? '<span class="text-small text-muted">' + fmtDur(ep.durationSeconds) + '</span>' : '') +
      '</div></div>'
    );
  }

  function continueRow(it) {
    return (
      '<a href="/watch/' + it.episodeId + '" data-nav class="list-row">' +
      '<span class="avatar" aria-hidden="true">' + esc((it.dramaTitle || '?').charAt(0)) + '</span>' +
      '<span class="min-w-0 flex-1">' +
      '<span class="block truncate text-body">' + esc(it.dramaTitle) + '</span>' +
      '<span class="block text-small text-muted">Season ' + it.seasonNumber + ', Episode ' + it.episodeNumber +
      (it.positionSeconds > 0 ? ' · stopped at ' + fmtPos(it.positionSeconds) : '') + '</span>' +
      resumeBar(it.positionSeconds, it.durationSeconds) +
      '</span></a>'
    );
  }

  function dramaRow(d, sub) {
    return (
      '<a href="/dramas/' + esc(d.slug) + '" data-nav class="list-row">' +
      '<span class="avatar" aria-hidden="true">' + esc((d.title || '?').charAt(0)) + '</span>' +
      '<span class="min-w-0 flex-1">' +
      '<span class="block truncate text-body">' + esc(d.title) + (d.maturity === 'mature' ? ' ' + matureBadge() : '') + '</span>' +
      '<span class="block text-small text-muted">' + esc(sub || '') + '</span>' +
      '</span></a>'
    );
  }

  function mountHome(view) {
    const hasProfile = api().hasProfile();
    view.innerHTML =
      '<section data-sec="next" class="mb-6"><h2 class="section-label">Next up</h2><div data-box></div></section>' +
      '<section data-sec="continue" class="mb-6"><h2 class="section-label">Continue watching</h2><div data-box></div></section>' +
      '<section data-sec="mylist" class="mb-6"><h2 class="section-label">My list</h2><div data-box></div></section>' +
      '<section data-sec="recs" class="mb-6"><h2 class="section-label">Because you watched</h2><div data-box></div></section>' +
      '<section data-sec="feed" class="mb-6"><div class="flex items-center justify-between"><h2 class="section-label mb-0">All dramas</h2>' +
      '<a href="/add" data-nav class="btn-secondary min-h-9 px-3 text-small">Add a drama</a></div><div data-box class="mt-2"></div>' +
      '<div data-more class="pt-3"></div></section>';

    const nextSec = view.querySelector('[data-sec="next"]');

    if (!hasProfile) {
      // A guest, or an account with no profile yet: the catalogue still
      // browses, but the viewer rows would all be empty.
      nextSec.innerHTML = emptyBox(
        'Choose who is watching',
        'Pick or create a profile so Home can keep your place.',
        '<a href="/profiles" data-nav class="btn-primary">Choose a profile</a>');
      view.querySelector('[data-sec="continue"]').hidden = true;
      view.querySelector('[data-sec="mylist"]').hidden = true;
      view.querySelector('[data-sec="recs"]').hidden = true;
    } else {
      // Next up
      loadSection(nextSec.querySelector('[data-box]'), 'next', '/api/next-to-watch', {
      errorText: 'Could not load your next episode.',
      skeleton: skeletonRows.bind(null, 1, true),
      isEmpty: function (d) { return !d.next; },
      empty: function (d) {
        if (d.finished) {
          return emptyBox('You finished ' + d.finished.title, 'Follow another drama and its next episode shows up here.',
            '<a href="/" data-nav class="btn-secondary">Back to dramas</a>');
        }
        return emptyBox('Nothing to continue yet', 'Follow a drama and start an episode. It will pick up here.');
      },
      draw: function (box, d) {
        box.innerHTML = nextUpHtml(d.next);
      },
    });
    }

    // Continue watching
    loadSection(view.querySelector('[data-sec="continue"] [data-box]'), 'cw', '/api/continue-watching', {
      errorText: 'Could not load continue watching.',
      isEmpty: function (d) { return d.items.length === 0; },
      empty: function () { return emptyBox('Nothing in progress', 'Episodes you stop part-way show up here.'); },
      draw: function (box, d) {
        box.innerHTML = '<div class="list">' + d.items.map(continueRow).join('') + '</div>';
      },
    });

    // My list
    loadSection(view.querySelector('[data-sec="mylist"] [data-box]'), 'mylist', '/api/my-list', {
      errorText: 'Could not load your list.',
      isEmpty: function (d) { return d.items.length === 0; },
      empty: function () { return emptyBox('Your list is empty', 'Open a drama and choose Save to watch later.'); },
      draw: function (box, d) {
        box.innerHTML = '<div class="list">' + d.items.map(function (d) {
          return dramaRow(d, d.seasons + (d.seasons === 1 ? ' season · ' : ' seasons · ') + d.episodes + ' episodes');
        }).join('') + '</div>';
      },
    });

    // Because you watched
    loadSection(view.querySelector('[data-sec="recs"] [data-box]'), 'recs', '/api/recommendations', {
      errorText: 'Could not load recommendations.',
      skeleton: skeletonTiles.bind(null, 3),
      isEmpty: function (d) { return !d.base || d.items.length === 0; },
      // No history yet: hide the row entirely, heading included.
      empty: function () {
        const sec = view.querySelector('[data-sec="recs"]');
        if (sec) sec.hidden = true;
        return '';
      },
      draw: function (box, d) {
        const sec = box.closest('[data-sec]');
        if (sec) sec.querySelector('.section-label').textContent =
          'Because you watched ' + d.base.title;
        box.innerHTML = '<div class="grid grid-cols-3 gap-3">' +
          d.items.map(function (r) { return posterTile(r, ''); }).join('') + '</div>';
      },
    });

    // All dramas feed, with Load more (keyset cursor).
    const feedBox = view.querySelector('[data-sec="feed"] [data-box]');
    const moreBox = view.querySelector('[data-more]');
    let cursor = null;
    let loadedAny = false;

    function drawFeed(d) {
      loadedAny = loadedAny || d.dramas.length > 0;
      cursor = d.nextCursor;
      const grid = feedBox.querySelector('[data-grid]');
      const html = d.dramas.map(function (d) {
        return posterTile(d, d.note ? '<div>' + esc(d.note) + '</div>' : '');
      }).join('');
      if (grid) grid.insertAdjacentHTML('beforeend', html);
      else feedBox.innerHTML = '<div class="grid grid-cols-3 gap-3" data-grid>' + html + '</div>';
      moreBox.innerHTML = cursor
        ? '<button type="button" class="btn-secondary w-full" data-more-btn>Load more</button>'
        : (loadedAny ? '' : '');
    }

    function loadFeed(path) {
      return api().fresh('feed:' + (path ? 'more' : 'head'), path || '/api/dramas?limit=18').then(function (d) {
        drawFeed(d);
      }).catch(function () {
        if (!loadedAny) feedBox.innerHTML = errorBox('Could not load the dramas.', 'data-feed-retry');
      });
    }

    loadFeed(null);
    view.addEventListener('click', function (e) {
      if (e.target.closest('[data-more-btn]')) {
        e.target.closest('[data-more-btn]').disabled = true;
        loadFeed('/api/dramas?limit=18&cursor=' + encodeURIComponent(cursor));
      }
      if (e.target.closest('[data-feed-retry]')) {
        feedBox.innerHTML = skeletonTiles(6);
        loadFeed(null);
      }
    });
  }

  // ── Drama detail ─────────────────────────────────────────────────────────

  function episodeRowHtml(d, ep, viewer, whoElse) {
    const w = viewer && viewer.watches && viewer.watches[ep.id];
    const done = w && w.completed;
    const pos = w ? w.positionSeconds : 0;
    let state;
    if (done) state = '<span class="text-small text-muted">Watched</span>';
    else if (pos > 0) state = '<span class="text-small text-accent">Resume at ' + fmtPos(pos) + '</span>';
    else state = '<span class="text-small text-muted">Not watched</span>';
    const others = whoElse && whoElse[ep.id] && whoElse[ep.id].length
      ? '<div class="text-small text-muted">Also watched by ' + esc(whoElse[ep.id].join(', ')) + '</div>'
      : '';
    return (
      '<a href="/watch/' + ep.id + '" data-nav class="list-row items-start">' +
      '<span class="text-small text-muted" style="min-width:2.5rem">' + esc('E' + ep.number) + '</span>' +
      '<span class="min-w-0 flex-1">' +
      '<span class="block text-body ' + (done ? 'text-muted' : '') + '">' + esc(ep.title) + '</span>' +
      state + (ep.duration_seconds ? ' <span class="text-small text-muted">· ' + fmtDur(ep.duration_seconds) + '</span>' : '') +
      others +
      resumeBar(pos, ep.duration_seconds) +
      '</span></a>'
    );
  }

  function mountDrama(view, params) {
    const slug = String(params && params.slug || '');
    const key = 'drama:' + slug;
    let data = null;
    let followed = false, listed = false;
    const myStars = { v: null };

    function render() {
      const d = data.drama;
      const viewer = data.viewer || {};
      followed = viewer.following; listed = viewer.inList; myStars.v = viewer.myStars;
      const firstUnwatched = data.episodes.find(function (ep) {
        const w = viewer.watches && viewer.watches[ep.id];
        return !(w && w.completed);
      });
      const seasonsHtml = data.seasons.map(function (s) {
        const eps = data.episodes.filter(function (e) { return e.season_id === s.id; });
        return '<h3 class="section-label mt-5">Season ' + s.number + ' · ' + s.episode_count + ' episodes</h3>' +
          '<div class="list">' + eps.map(function (ep) {
            return episodeRowHtml(d, ep, viewer, data.whoElse);
          }).join('') + '</div>';
      }).join('');
      view.innerHTML =
        '<a href="/" data-nav class="text-small text-muted">Back to Home</a>' +
        '<h1 class="mt-2 text-title">' + esc(d.title) + (d.maturity === 'mature' ? ' ' + matureBadge() : '') + '</h1>' +
        '<p class="text-small text-muted">' +
        esc(data.seasons.length + (data.seasons.length === 1 ? ' season · ' : ' seasons · ') +
          data.episodes.length + ' episodes') +
        (data.genres.length ? ' · ' + esc(data.genres.join(', ')) : '') + '</p>' +
        (d.summary ? '<p class="mt-2 text-body">' + esc(d.summary) + '</p>' : '') +
        '<div class="mt-3 flex flex-wrap items-center gap-2">' +
        (firstUnwatched
          ? '<a href="/watch/' + firstUnwatched.id + '" data-nav class="btn-primary">' +
            (viewer.watches && viewer.watches[firstUnwatched.id] && viewer.watches[firstUnwatched.id].positionSeconds > 0
              ? 'Resume episode' : 'Start episode') + '</a>'
          : '<a href="/" data-nav class="btn-primary">Back to Home</a>') +
        '<button type="button" class="btn-secondary" data-act="follow">' + (followed ? 'Following' : 'Follow') + '</button>' +
        '<button type="button" class="btn-secondary" data-act="save">' + (listed ? 'Saved' : 'Save') + '</button>' +
        '</div>' +
        '<div class="mt-4"><h2 class="section-label">Your rating</h2>' +
        '<div data-rating>' + (api().hasProfile()
          ? starsHtml(viewer.myStars, viewer.groupAverage, viewer.groupRatingCount)
          : '<p class="text-small text-muted">Make an account in Homeroom to rate dramas.</p>') + '</div></div>' +
        seasonsHtml +
        (data.cast.length ? '<h2 class="section-label mt-6">Cast</h2><div class="list">' +
          data.cast.map(function (c) {
            return '<div class="list-row"><span class="text-body">' + esc(c.name) + '</span>' +
              '<span class="flex-1"></span><span class="text-small text-muted">' + esc(c.character_name || '') + '</span></div>';
          }).join('') + '</div>' : '') +
        '<div class="mt-6"><button type="button" class="btn-secondary" data-act="add-ep">Add an episode</button></div>' +
        '<form data-ep-form hidden class="mt-3 space-y-3">' +
        '<div><label class="section-label mb-1 block" for="ep-title">Episode title</label>' +
        '<input id="ep-title" name="title" class="field" required></div>' +
        '<div><label class="section-label mb-1 block" for="ep-url">Video link (optional)</label>' +
        '<input id="ep-url" name="watchUrl" class="field" placeholder="e.g. https://example.com/clip.mp4"></div>' +
        '<div><label class="section-label mb-1 block" for="ep-dur">Length in seconds (optional)</label>' +
        '<input id="ep-dur" name="durationSeconds" class="field" inputmode="numeric" placeholder="e.g. 1320"></div>' +
        '<div class="flex gap-2"><button type="submit" class="btn-primary">Add episode</button>' +
        '<button type="button" class="btn-secondary" data-act="cancel-ep">Cancel</button></div></form>' +
        '<p class="text-small text-muted mt-6">Added by ' + esc(d.addedBy || 'someone in your homeroom') + '</p>';

      bindRating(view);
    }

    function bindRating(view) {
      const box = view.querySelector('[data-rating]');
      if (!box) return;
      box.addEventListener('click', function (e) {
        const star = e.target.closest('[data-star]');
        if (!star) return;
        const stars = Number(star.getAttribute('data-star'));
        write('PUT', '/api/ratings', { dramaId: data.drama.id, stars: stars }, { dedupe: 'rating:' + data.drama.id })
          .then(function () {
            myStars.v = stars;
            box.innerHTML = starsHtml(stars, data.viewer && data.viewer.groupAverage, data.viewer && data.viewer.groupRatingCount);
            toast('Rated ' + stars + ' star' + (stars > 1 ? 's' : ''));
          }).catch(function (err) {
            if (!err.guestWrite) toast('Could not save your rating. Try again.');
          });
      });
    }

    function draw(d) {
      data = d;
      render();
    }

    let cached = null;
    try { cached = api().cacheGet(key); } catch (e) {}
    if (cached) draw(cached);
    else view.innerHTML = '<div class="skeleton h-8 w-1/2"></div><div class="skeleton mt-3 h-4 w-1/3"></div>' +
      '<div class="mt-6">' + skeletonRows(4, true) + '</div>';

    api().fresh(key, '/api/dramas/' + encodeURIComponent(slug)).then(function (d) {
      draw(d);
    }).catch(function (err) {
      if (err.status === 404) {
        view.innerHTML = emptyBox('Drama not found', 'It may have been removed.',
          '<a href="/" data-nav class="btn-secondary">Back to Home</a>');
      } else if (err.status === 403 && err.code === 'mature_hidden') {
        view.innerHTML = emptyBox('Not available on this profile', 'Kids profiles do not include mature dramas.',
          '<a href="/" data-nav class="btn-secondary">Back to Home</a>');
      } else if (!cached) {
        view.innerHTML = errorBox('Could not load this drama.', 'data-retry-drama');
        view.addEventListener('click', function (e) {
          if (e.target.closest('[data-retry-drama]')) mountDrama(view, { slug: slug });
        }, { once: true });
      }
    });

    view.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-act]');
      if (!btn || !data) return;
      const act = btn.getAttribute('data-act');
      if (act === 'follow') {
        const method = followed ? 'DELETE' : 'POST';
        const path = followed ? '/api/follows/' + data.drama.id : '/api/follows';
        write(method, path, followed ? undefined : { dramaId: data.drama.id }, { dedupe: 'follow:' + data.drama.id })
          .then(function (r) {
            if (r && r.queued) { offlineResult(r); return; }
            followed = !followed;
            btn.textContent = followed ? 'Following' : 'Follow';
            api().cacheDrop('next'); api().cacheDrop('recs');
            toast(followed ? 'Following. New episodes show on Home.' : 'Unfollowed');
          }).catch(function (err) {
            if (!err.guestWrite) toast('Could not save that. Try again.');
          });
      } else if (act === 'save') {
        const method = listed ? 'DELETE' : 'POST';
        const path = listed ? '/api/my-list/' + data.drama.id : '/api/my-list';
        write(method, path, listed ? undefined : { dramaId: data.drama.id }, { dedupe: 'save:' + data.drama.id })
          .then(function (r) {
            if (r && r.queued) { offlineResult(r); return; }
            listed = !listed;
            btn.textContent = listed ? 'Saved' : 'Save';
            api().cacheDrop('mylist');
            toast(listed ? 'Saved to My list' : 'Removed from My list');
          }).catch(function (err) {
            if (!err.guestWrite) toast('Could not save that. Try again.');
          });
      } else if (act === 'add-ep') {
        const form = view.querySelector('[data-ep-form]');
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('input').focus();
      } else if (act === 'cancel-ep') {
        view.querySelector('[data-ep-form]').hidden = true;
      }
    });

    view.addEventListener('submit', function (e) {
      const form = e.target.closest('[data-ep-form]');
      if (!form || !data) return;
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        title: fd.get('title'),
        watchUrl: fd.get('watchUrl'),
        durationSeconds: Number(fd.get('durationSeconds')) || 0,
      };
      write('POST', '/api/dramas/' + encodeURIComponent(slug) + '/episodes', body, { dedupe: 'ep:' + slug + ':' + body.title })
        .then(function (r) {
          if (r && r.queued) { offlineResult(r); form.reset(); form.hidden = true; return; }
          toast('Episode added');
          api().cacheDrop(key); api().cacheDrop('feed:head'); api().cacheDrop('next');
          mountDrama(view, { slug: slug }); // re-render with the new episode
        }).catch(function (err) {
          if (!err.guestWrite) toast('Could not add the episode. Try again.');
        });
    });
  }

  // ── Search ───────────────────────────────────────────────────────────────

  function mountSearch(view) {
    view.innerHTML =
      '<h1 class="text-title">Search</h1>' +
      '<form data-search-form class="mt-3 flex gap-2">' +
      '<input data-search class="field flex-1" type="search" placeholder="Titles, summaries, cast" autocomplete="off" aria-label="Search dramas">' +
      '<button type="submit" class="btn-primary">Search</button></form>' +
      '<div data-suggest class="mt-3"></div>' +
      '<div data-recent class="mt-3"></div>' +
      '<div data-results class="mt-4"></div>';

    const input = view.querySelector('[data-search]');
    const suggestBox = view.querySelector('[data-suggest]');
    const recentBox = view.querySelector('[data-recent]');
    const resultsBox = view.querySelector('[data-results]');
    let activeQuery = '';
    let debounceTimer = null;

    function drawRecent() {
      if (!api().hasProfile()) { recentBox.innerHTML = ''; return; }
      api().fresh('recent', '/api/search/recent').then(function (d) {
        if (!d.items.length || input.value) { recentBox.innerHTML = ''; return; }
        recentBox.innerHTML = '<h2 class="section-label">Recent searches</h2><div class="list">' +
          d.items.map(function (it) {
            return '<div class="list-row">' +
              '<button type="button" class="flex-1 text-left text-body" data-use="' + esc(it.query) + '">' + esc(it.query) + '</button>' +
              '<button type="button" class="btn-secondary min-h-9 min-w-9 px-2 text-small" data-del-recent="' + it.id + '" aria-label="Remove">✕</button>' +
              '</div>';
          }).join('') +
          '<div class="list-row"><button type="button" class="text-small text-muted" data-clear-recent>Clear all</button></div></div>';
      }).catch(function () { recentBox.innerHTML = ''; });
    }

    function runSearch(q) {
      activeQuery = q;
      suggestBox.innerHTML = '';
      recentBox.innerHTML = '';
      if (!q) { resultsBox.innerHTML = ''; drawRecent(); return; }
      resultsBox.innerHTML = skeletonRows(3);
      api().fresh('search:' + q.toLowerCase(), '/api/search?q=' + encodeURIComponent(q)).then(function (d) {
        if (activeQuery !== q) return;
        drawResults(d, q, false);
      }).catch(function () {
        if (activeQuery !== q) return;
        resultsBox.innerHTML = errorBox('Could not search just now.', 'data-search-retry');
      });
      // Recent searches are recorded per profile; queued when offline.
      if (api().hasProfile()) {
        write('POST', '/api/search/recent', { query: q }, { dedupe: 'recent:' + q.toLowerCase() })
          .then(function () { api().cacheDrop('recent'); })
          .catch(function () {});
      }
    }

    let lastCursor = null;
    function drawResults(d, q, more) {
      lastCursor = d.nextCursor;
      const cards = d.dramas.map(function (dr) {
        return posterTile(dr, dr.episodes ? '<div>' + dr.episodes + ' episodes</div>' : '');
      }).join('');
      const grid = resultsBox.querySelector('[data-grid]');
      if (more && grid) grid.insertAdjacentHTML('beforeend', cards);
      else if (d.dramas.length) {
        resultsBox.innerHTML = '<h2 class="section-label">Results</h2>' +
          '<div class="grid grid-cols-3 gap-3" data-grid>' + cards + '</div>' +
          (d.nextCursor ? '<div class="pt-3"><button type="button" class="btn-secondary w-full" data-more>Load more</button></div>' : '');
      } else if (!more) {
        resultsBox.innerHTML = emptyBox('No matches for "' + q + '"',
          'Check the spelling, or add the drama yourself.',
          '<a href="/add" data-nav class="btn-primary">Add a drama</a>');
      }
    }

    function drawSuggestions(q) {
      api().rawJson('GET', '/api/search/suggestions?q=' + encodeURIComponent(q)).then(function (d) {
        if (activeQuery === q) return; // a search already took over
        if (!d.suggestions.length) { suggestBox.innerHTML = ''; return; }
        suggestBox.innerHTML = '<div class="list">' + d.suggestions.map(function (s) {
          if (s.type === 'drama') {
            return '<a href="/dramas/' + esc(s.slug) + '" data-nav class="list-row">' +
              '<span class="text-body">' + esc(s.title) + '</span><span class="flex-1"></span>' +
              '<span class="text-small text-muted">Drama</span></a>';
          }
          return '<div class="list-row"><span class="text-body">' + esc(s.name) + '</span>' +
            '<span class="flex-1"></span><span class="text-small text-muted">' + esc((s.dramas || []).join(', ')) + '</span></div>';
        }).join('') + '</div>';
      }).catch(function () { suggestBox.innerHTML = ''; });
    }

    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (q.length < 2) { suggestBox.innerHTML = ''; return; }
      debounceTimer = setTimeout(function () { drawSuggestions(q); }, 250);
    });

    view.addEventListener('submit', function (e) {
      if (!e.target.closest('[data-search-form]')) return;
      e.preventDefault();
      runSearch(input.value.trim());
    });
    input.addEventListener('search', function () {
      if (input.value.trim()) runSearch(input.value.trim());
    });

    view.addEventListener('click', function (e) {
      const use = e.target.closest('[data-use]');
      if (use) { input.value = use.getAttribute('data-use'); runSearch(input.value); return; }
      const del = e.target.closest('[data-del-recent]');
      if (del) {
        write('DELETE', '/api/search/recent/' + del.getAttribute('data-del-recent'), undefined,
          { dedupe: 'del-recent:' + del.getAttribute('data-del-recent') })
          .then(function () { api().cacheDrop('recent'); drawRecent(); })
          .catch(function () {});
        return;
      }
      if (e.target.closest('[data-clear-recent]')) {
        write('DELETE', '/api/search/recent', undefined, { dedupe: 'clear-recent' })
          .then(function () { api().cacheDrop('recent'); recentBox.innerHTML = ''; })
          .catch(function () {});
        return;
      }
      if (e.target.closest('[data-search-retry]') && activeQuery) runSearch(activeQuery);
      const more = e.target.closest('[data-more]');
      if (more && lastCursor) {
        more.disabled = true;
        api().fresh('searchmore:' + activeQuery.toLowerCase(),
          '/api/search?q=' + encodeURIComponent(activeQuery) + '&cursor=' + encodeURIComponent(lastCursor))
          .then(function (d) { drawResults(d, activeQuery, true); })
          .catch(function () { more.disabled = false; });
      }
    });

    drawRecent();
    // A ?q= deep link (tests, share links) runs the search immediately.
    const initial = new URLSearchParams(location.search).get('q');
    if (initial) {
      input.value = initial;
      runSearch(initial.trim());
    } else {
      input.focus();
    }
  }

  // ── Profiles: Who's watching? ────────────────────────────────────────────

  function mountProfiles(view) {
    const st = api().state;

    if (st.guest) {
      view.innerHTML = '<h1 class="text-title">Who&#39;s watching?</h1>' +
        emptyBox('Profiles come with a Homeroom account',
          'Make an account in Homeroom, then create up to four profiles here.',
          '<a href="/" data-nav class="btn-secondary">Browse dramas</a>');
      return;
    }

    function render(profiles) {
      const active = st.activeProfileId;
      view.innerHTML =
        '<h1 class="text-title">Who&#39;s watching?</h1>' +
        '<p class="text-small text-muted mt-1">Watching on ' + esc(st.account.username) + '&#39;s account</p>' +
        '<div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">' +
        profiles.map(function (p) {
          const isActive = String(p.id) === String(active);
          return '<div class="text-center">' +
            '<button type="button" data-pick="' + p.id + '" class="group block w-full text-center">' +
            '<span class="mx-auto block">' + avatarHtml(p, isActive ? 'ring-2 ring-focus' : '') + '</span>' +
            '<span class="mt-2 block truncate text-body">' + esc(p.name) + '</span>' +
            (p.is_kids ? '<span class="text-small text-muted">Kids profile</span>' : '') +
            (isActive ? '<span class="text-small text-accent">Watching now</span>' : '') +
            '</button>' +
            '<a href="/profiles/' + p.id + '/edit" data-nav class="text-small text-muted">Edit</a>' +
            '</div>';
        }).join('') +
        '</div>' +
        (profiles.length < 4
          ? '<div class="mt-6"><a href="/profiles/new" data-nav class="btn-primary">Add a profile</a></div>'
          : '<p class="mt-6 text-small text-muted">Four profiles is the limit for an account.</p>');
    }

    view.addEventListener('click', function (e) {
      const pick = e.target.closest('[data-pick]');
      if (!pick) return;
      api().setActiveProfile(Number(pick.getAttribute('data-pick')));
      toast('Now watching as ' + (api().profile() ? api().profile().name : 'profile'));
      HC.router.go('/');
    });

    function load() {
      api().rawJson('GET', '/api/me').then(function (me) {
        if (me.guest) {
          // Only boot() normally sets state.guest; set it here too, or this
          // re-entry would fetch /api/me forever.
          st.guest = true;
          mountProfiles(view);
          return;
        }
        st.account = me.account; st.profiles = me.profiles;
        render(me.profiles);
        if (!me.profiles.length) {
          view.innerHTML = '<h1 class="text-title">Who&#39;s watching?</h1>' +
            '<div class="mt-6 card"><h2 class="text-heading">Create your first profile</h2>' +
            '<form data-first class="mt-3 space-y-3">' +
            '<div><label class="section-label mb-1 block" for="pf-name">Profile name</label>' +
            '<input id="pf-name" name="name" class="field" required maxlength="40"></div>' +
            '<label class="flex min-h-11 items-center gap-3 text-body">' +
            '<input type="checkbox" name="isKids" class="h-5 w-5"> Kids profile (hides mature dramas)</label>' +
            '<div class="flex gap-2"><button type="submit" class="btn-primary">Create profile</button></div></form></div>';
        }
      }).catch(function () {
        view.innerHTML = errorBox('Could not load profiles.', 'data-pf-retry');
        view.querySelector('[data-pf-retry]').addEventListener('click', load);
      });
    }

    view.addEventListener('submit', function (e) {
      const form = e.target.closest('[data-first]');
      if (!form) return;
      e.preventDefault();
      const fd = new FormData(form);
      api().mutate('POST', '/api/profiles', { name: fd.get('name'), isKids: fd.get('isKids') === 'on' })
        .then(function (r) {
          const me = { account: st.account, profiles: st.profiles.concat([r.profile]) };
          api().setActiveProfile(r.profile.id);
          st.profiles = me.profiles;
          try { HC.store.writeJSON('hc:me', me); } catch (err) {}
          toast('Profile created');
          HC.router.go('/');
        }).catch(function (err) {
          if (err.guestWrite) return;
          if (err.code === 'profile_limit') toast('Four profiles is the limit for an account.');
          else if (err.code === 'duplicate_name') toast('A profile with that name already exists.');
          else toast('Could not create the profile. Try again.');
        });
    });

    load();
  }

  // ── Profile edit ─────────────────────────────────────────────────────────

  function mountProfileEdit(view, params) {
    const st = api().state;
    // The /profiles/new route carries no id param; an id always means edit.
    const creating = !params.id || params.id === 'new';
    let profile = null;
    let avatar = { url: '', fileId: '' };

    function findProfile() {
      return st.profiles.find(function (p) { return String(p.id) === String(params.id); });
    }

    if (creating) {
      profile = { name: '', language: '', is_kids: false };
    } else {
      profile = findProfile();
      if (!profile) {
        view.innerHTML = emptyBox('Profile not found', '',
          '<a href="/profiles" data-nav class="btn-secondary">Back to profiles</a>');
        return;
      }
      avatar = { url: profile.avatar_url || '', fileId: profile.avatar_file_id || '' };
    }

    function avatarPreview() {
      return avatar.url
        ? '<img src="' + esc(avatar.url) + '" alt="Profile avatar" class="h-20 w-20 rounded-full object-cover">'
        : '<span class="avatar" style="width:5rem;height:5rem;font-size:1.75rem">' +
          esc((profile.name || '?').charAt(0).toUpperCase()) + '</span>';
    }

    view.innerHTML =
      '<a href="/profiles" data-nav class="text-small text-muted">Back to profiles</a>' +
      '<h1 class="mt-2 text-title">' + (creating ? 'Add a profile' : 'Edit profile') + '</h1>' +
      '<form data-form class="mt-4 space-y-4" data-profile-id="' + esc(params.id) + '">' +
      '<div class="flex items-center gap-4"><span data-avatar-slot>' + avatarPreview() + '</span>' +
      '<div class="space-y-2">' +
      '<div><label class="btn-secondary cursor-pointer min-h-9 text-small">Change photo' +
      '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-avatar class="hidden"></label></div>' +
      (avatar.url ? '<button type="button" class="text-small text-muted" data-avatar-remove>Remove photo</button>' : '') +
      '</div></div>' +
      '<div><label class="section-label mb-1 block" for="pf-name">Name</label>' +
      '<input id="pf-name" name="name" class="field" required maxlength="40" value="' + esc(profile.name) + '"></div>' +
      '<div><label class="section-label mb-1 block" for="pf-lang">Preferred language (optional)</label>' +
      '<input id="pf-lang" name="language" class="field" maxlength="20" placeholder="e.g. en or pt-BR" value="' + esc(profile.language || '') + '"></div>' +
      '<label class="flex min-h-11 items-center gap-3 text-body">' +
      '<input type="checkbox" name="isKids" class="h-5 w-5"' + (profile.is_kids ? ' checked' : '') + '>' +
      'Kids profile (hides mature dramas)</label>' +
      '<div class="flex gap-2 pt-2">' +
      '<button type="submit" class="btn-primary">' + (creating ? 'Create profile' : 'Save changes') + '</button>' +
      '<a href="/profiles" data-nav class="btn-secondary">Cancel</a></div>' +
      '</form>' +
      (!creating ? '<div class="mt-8 border-t border-line pt-4">' +
        '<button type="button" class="btn-secondary text-danger" data-delete>Delete profile</button>' +
        '<p class="text-small text-muted mt-1">Its history, list, ratings and searches go with it.</p></div>' : '');

    const form = view.querySelector('[data-form]');

    form.querySelector('[data-avatar]').addEventListener('change', function () {
      const file = this.files && this.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast('Photos are limited to 5 MB.'); return; }
      if (!window.usernode || typeof window.usernode.uploadFile !== 'function') {
        toast('Photo upload is not available here. Try the app inside Homeroom.');
        return;
      }
      toast('Uploading photo…');
      window.usernode.uploadFile(file, { visibility: 'public' }).then(function (stored) {
        avatar = { url: stored.url, fileId: stored.id };
        const slot = form.querySelector('[data-avatar-slot]');
        if (slot) slot.innerHTML = avatarPreview();
        toast('Photo uploaded. Save changes to keep it.');
      }).catch(function () {
        toast('Upload did not go through. Try again.');
      });
    });

    view.addEventListener('click', function (e) {
      if (e.target.closest('[data-avatar-remove]')) {
        avatar = { url: '', fileId: '' };
        toast('Photo removed. Save changes to keep it.');
      }
      if (e.target.closest('[data-delete]')) {
        if (!confirm('Delete the profile "' + profile.name + '"? Its history, list and ratings go with it.')) return;
        api().mutate('DELETE', '/api/profiles/' + profile.id, undefined, { dedupe: 'del-profile:' + profile.id })
          .then(function (r) {
            if (r && r.queued) { offlineResult(r); HC.router.go('/profiles'); return; }
            if (avatar.fileId && window.usernode && window.usernode.deleteFile) {
              try { window.usernode.deleteFile(avatar.fileId).catch(function () {}); } catch (err) {}
            }
            toast('Profile deleted');
            HC.router.go('/profiles');
          }).catch(function (err) {
            if (err.guestWrite) return;
            if (err.code === 'last_profile') toast('An account keeps at least one profile.');
            else toast('Could not delete the profile. Try again.');
          });
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        name: fd.get('name'),
        language: (fd.get('language') || '').trim(),
        isKids: fd.get('isKids') === 'on',
      };
      if (!creating) { body.avatarUrl = avatar.url; body.avatarFileId = avatar.fileId; }
      api().mutate(creating ? 'POST' : 'PATCH',
        creating ? '/api/profiles' : '/api/profiles/' + profile.id, body,
        { dedupe: (creating ? 'new-profile:' : 'edit-profile:') + params.id + ':' + body.name })
        .then(function (r) {
          if (r && r.queued) { offlineResult(r); HC.router.go('/profiles'); return; }
          const saved = r.profile || r;
          const others = st.profiles.filter(function (p) { return String(p.id) !== String(saved.id); });
          st.profiles = others.concat([saved]).sort(function (a, b) { return a.id - b.id; });
          try { HC.store.writeJSON('hc:me', { account: st.account, profiles: st.profiles }); } catch (err) {}
          if (creating || !st.activeProfileId) api().setActiveProfile(saved.id);
          toast(creating ? 'Profile created' : 'Changes saved');
          HC.router.go('/profiles');
        }).catch(function (err) {
          if (err.guestWrite) return;
          if (err.code === 'duplicate_name') toast('A profile with that name already exists.');
          else if (err.code === 'profile_limit') toast('Four profiles is the limit for an account.');
          else toast('Could not save the profile. Try again.');
        });
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  function mountSettings(view) {
    const key = 'settings';
    const st = api().state;

    function draw(s) {
      const theme = s.theme || 'auto';
      view.innerHTML =
        '<a href="/" data-nav class="text-small text-muted">Back to Home</a>' +
        '<h1 class="mt-2 text-title">Settings</h1>' +
        '<h2 class="section-label mt-6">Appearance</h2>' +
        '<div class="list" role="radiogroup" aria-label="Theme">' +
        [['auto', 'Follow Homeroom'], ['light', 'Light'], ['dark', 'Dark']].map(function (opt) {
          return '<label class="list-row cursor-pointer">' +
            '<input type="radio" name="theme" value="' + opt[0] + '" class="h-5 w-5"' + (theme === opt[0] ? ' checked' : '') + '>' +
            '<span class="text-body">' + opt[1] + '</span></label>';
        }).join('') + '</div>' +
        '<h2 class="section-label mt-6">Notifications</h2>' +
        '<div class="list"><label class="list-row cursor-pointer">' +
        '<input type="checkbox" data-notify class="h-5 w-5"' + (s.notifyNewEpisode ? ' checked' : '') + '>' +
        '<span class="min-w-0 flex-1"><span class="block text-body">New episodes</span>' +
        '<span class="block text-small text-muted">A note on Home when a followed drama adds one</span></span></label></div>' +
        '<h2 class="section-label mt-6">Profile</h2>' +
        '<div class="list">' +
        '<div class="list-row"><span class="text-body">' + esc(s.name) + '</span>' +
        '<span class="flex-1"></span><span class="text-small text-muted">' + (s.isKids ? 'Kids profile' : 'Standard') + '</span></div>' +
        '<a href="/profiles/' + s.profileId + '/edit" data-nav class="list-row"><span class="text-body text-accent">Edit profile</span></a>' +
        '<a href="/profiles" data-nav class="list-row"><span class="text-body text-accent">Switch profile</span></a></div>' +
        '<h2 class="section-label mt-6">Account</h2>' +
        '<div class="list"><div class="list-row"><span class="text-body">' + esc(s.account.username) + '</span>' +
        '<span class="flex-1"></span><span class="text-small text-muted">Homeroom account</span></div>' +
        (s.account.locale ? '<div class="list-row"><span class="text-body">Homeroom language</span>' +
          '<span class="flex-1"></span><span class="text-small text-muted">' + esc(s.account.locale) + '</span></div>' : '') + '</div>';

      view.querySelectorAll('input[name="theme"]').forEach(function (radio) {
        radio.addEventListener('change', function () {
          const v = radio.value;
          try { localStorage.setItem('hc:ui:theme', v === 'auto' ? '' : v); } catch (e) {}
          if (window.__hcApplyTheme) window.__hcApplyTheme();
          saveSettings({ theme: v }, 'Appearance saved');
        });
      });
      const notify = view.querySelector('[data-notify]');
      notify.addEventListener('change', function () {
        saveSettings({ notifyNewEpisode: notify.checked }, 'Notifications saved');
      });
    }

    function saveSettings(body, msg) {
      api().mutate('PUT', '/api/settings', body, { dedupe: 'settings' })
        .then(function (r) { if (r && r.queued) offlineResult(r); else toast(msg); })
        .catch(function (err) {
          if (err.guestWrite) return;
          if (err.code === 'profile_required') {
            toast('Choose a profile first.');
            return;
          }
          toast('Could not save settings. Try again.');
        });
    }

    let cached = null;
    try { cached = api().cacheGet(key); } catch (e) {}
    if (cached) draw(cached);
    else view.innerHTML = '<div class="skeleton h-8 w-1/3"></div><div class="mt-6">' + skeletonRows(3) + '</div>';

    api().fresh(key, '/api/settings').then(draw).catch(function (err) {
      if (err.status === 403) {
        view.innerHTML = emptyBox('Choose a profile first', 'Settings belong to a profile.',
          '<a href="/profiles" data-nav class="btn-primary">Choose a profile</a>');
      } else if (!cached) {
        view.innerHTML = errorBox('Could not load settings.', 'data-settings-retry');
      }
    });
    view.addEventListener('click', function (e) {
      if (e.target.closest('[data-settings-retry]')) mountSettings(view);
    });
  }

  // ── Add a drama ──────────────────────────────────────────────────────────

  function mountAdd(view) {
    view.innerHTML =
      '<a href="/" data-nav class="text-small text-muted">Back to Home</a>' +
      '<h1 class="mt-2 text-title">Add a drama</h1>' +
      '<form data-form class="mt-4 space-y-4">' +
      '<div><label class="section-label mb-1 block" for="d-title">Title</label>' +
      '<input id="d-title" name="title" class="field" required maxlength="120"></div>' +
      '<div><label class="section-label mb-1 block" for="d-summary">Summary (optional)</label>' +
      '<textarea id="d-summary" name="summary" class="field" rows="3" maxlength="600"></textarea></div>' +
      '<div><label class="section-label mb-1 block" for="d-genres">Genres, comma separated (optional)</label>' +
      '<input id="d-genres" name="genres" class="field" placeholder="e.g. Mystery, Drama"></div>' +
      '<div><label class="section-label mb-1 block" for="d-cast">Cast, comma separated (optional)</label>' +
      '<input id="d-cast" name="cast" class="field" placeholder="e.g. Ana Reyes"></div>' +
      '<label class="flex min-h-11 items-center gap-3 text-body">' +
      '<input type="checkbox" name="mature" class="h-5 w-5"> Mature (hidden from Kids profiles)</label>' +
      '<div class="flex gap-2 pt-2"><button type="submit" class="btn-primary">Add drama</button>' +
      '<a href="/" data-nav class="btn-secondary">Cancel</a></div></form>';

    view.querySelector('[data-form]').addEventListener('submit', function (e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        title: fd.get('title'),
        summary: fd.get('summary'),
        maturity: fd.get('mature') === 'on' ? 'mature' : 'all',
        genres: String(fd.get('genres') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        cast: String(fd.get('cast') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      };
      api().mutate('POST', '/api/dramas', body, { dedupe: 'drama:' + body.title })
        .then(function (r) {
          if (r && r.queued) { offlineResult(r); HC.router.go('/'); return; }
          toast('Drama added');
          api().cacheDrop('feed:head');
          HC.router.go('/dramas/' + r.drama.slug);
        }).catch(function (err) {
          if (err.guestWrite) return;
          toast('Could not add the drama. Try again.');
        });
    });
  }

  // ── Watch (the player screen) ────────────────────────────────────────────

  function mountWatch(view, params) {
    HC.player.mount(view, Number(params && params.id) || 0);
  }

  return {
    home: mountHome,
    drama: mountDrama,
    search: mountSearch,
    profiles: mountProfiles,
    profileEdit: mountProfileEdit,
    settings: mountSettings,
    add: mountAdd,
    watch: mountWatch,
    toast: toast,
    esc: esc,
  };
})();

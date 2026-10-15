// HC.player — the watch screen. Two kinds of episode:
//
//  - a video the frame can play (an .mp4 the homeroom uploaded): a real
//    <video> element. The resume position is saved every 5 seconds, on
//    pause and when the page is hidden, so closing the app mid-episode
//    keeps the place. The queue in HC.store makes those saves survive
//    being offline. At 90% watched the screen offers "Mark watched".
//  - any other link: the frame cannot show it, so the screen keeps Phase
//    1's behaviour — an Open button to the source in a new tab — and
//    records that the episode was opened (first_opened_at server-side),
//    with a Mark watched button beside it.

window.HC = window.HC || {};

HC.player = (function () {
  let saveTimer = null;
  let currentVideo = null;
  let currentSave = null;

  function save(episodeId, positionSeconds, completed) {
    const body = { episodeId: episodeId, positionSeconds: Math.floor(positionSeconds || 0), completed: Boolean(completed) };
    currentSave = body;
    return HC.api.mutate('PUT', '/api/watches', body, { dedupe: 'watch:' + episodeId })
      .then(function (r) {
        if (r && r.queued) HC.screens.toast('Position saved on this device. Will sync when you are back online.');
      })
      .catch(function () { /* retried by the next tick or the offline queue */ });
  }

  function stopTimers() {
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
  }

  function mount(view, episodeId) {
    episodeId = Number(episodeId);
    stopTimers();
    currentVideo = null;

    view.innerHTML = '<div class="skeleton aspect-video w-full rounded-xl"></div>' +
      '<div class="skeleton mt-4 h-5 w-2/3"></div><div class="skeleton mt-2 h-4 w-1/3"></div>';

    HC.api.fresh('ep:' + episodeId, '/api/episodes/' + episodeId).then(function (d) {
      // The player keeps its own copy fresh: a resume position saved seconds
      // ago must not be overwritten by a stale cache entry.
      if (currentSave && d.watch) {
        d.watch.position_seconds = Math.max(d.watch.position_seconds, currentSave.positionSeconds);
      }
      draw(d);
    }).catch(function (err) {
      if (err.status === 404) {
        view.innerHTML = '<div class="state-empty"><p class="text-body font-medium">Episode not found</p>' +
          '<p class="text-small text-muted">It may have been removed.</p></div>';
      } else if (err.status === 403 && err.code === 'mature_hidden') {
        view.innerHTML = '<div class="state-empty"><p class="text-body font-medium">Not available on this profile</p>' +
          '<p class="text-small text-muted">Kids profiles do not include mature dramas.</p></div>';
      } else {
        view.innerHTML = '<div class="state-error"><p class="text-body font-medium">Could not open the episode.</p>' +
          '<button type="button" class="btn-secondary" data-retry>Retry</button></div>';
        view.querySelector('[data-retry]').addEventListener('click', function () { mount(view, episodeId); });
      }
    });

    function draw(d) {
      const ep = d.episode;
      const drama = d.drama;
      const watch = d.watch || null;
      const savedPos = watch ? watch.position_seconds : 0;
      const playable = /\.(mp4|webm|m3u8)(\?|$)/i.test(ep.watchUrl || '');

      let mediaHtml;
      if (playable) {
        mediaHtml = '<video data-video controls playsinline preload="metadata" class="w-full rounded-xl bg-black" style="aspect-ratio:16/9"></video>';
      } else {
        mediaHtml = '<div class="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl border border-line bg-raised p-4 text-center">' +
          '<p class="text-body font-medium">This episode plays on another site</p>' +
          (ep.watchUrl
            ? '<a href="' + HC.screens.esc(ep.watchUrl) + '" target="_blank" rel="noopener noreferrer" class="btn-primary" data-open>Open episode link</a>'
            : '<p class="text-small text-muted">No video link was added for it.</p>') +
          '</div>';
      }

      view.innerHTML =
        '<a href="/dramas/' + HC.screens.esc(drama.slug) + '" data-nav class="text-small text-muted">Back to ' + HC.screens.esc(drama.title) + '</a>' +
        '<div class="mt-2">' + mediaHtml + '</div>' +
        '<h1 class="mt-3 text-heading">' + HC.screens.esc(drama.title) +
        ' · Season ' + ep.seasonNumber + ', Episode ' + ep.number + '</h1>' +
        '<p class="text-body text-muted">' + HC.screens.esc(ep.title) +
        (ep.durationSeconds ? ' · ' + fmtDur(ep.durationSeconds) : '') + '</p>' +
        (savedPos > 0 && !watch.completed
          ? '<p class="text-small text-muted mt-1">You stopped at ' + fmtPos(savedPos) + '.</p>' : '') +
        '<div class="mt-3 flex flex-wrap gap-2">' +
        '<button type="button" class="btn-secondary" data-mark>' + (watch && watch.completed ? 'Watched ✓' : 'Mark watched') + '</button>' +
        (watch && (watch.position_seconds > 0 || watch.completed)
          ? '<button type="button" class="btn-secondary" data-unmark>Remove from history</button>' : '') +
        '</div>';

      const markBtn = view.querySelector('[data-mark]');
      const unmarkBtn = view.querySelector('[data-unmark]');

      if (playable) {
        const video = view.querySelector('[data-video]');
        currentVideo = video;
        if (ep.watchUrl) video.src = ep.watchUrl;
        // Resume: jump to the saved position once the length is known.
        if (savedPos > 0 && !watch.completed) {
          video.addEventListener('loadedmetadata', function () {
            try { video.currentTime = Math.min(savedPos, Math.max((video.duration || 0) - 2, 0)); } catch (e) {}
          }, { once: true });
        }
        video.addEventListener('loadedmetadata', function () {
          if (!ep.durationSeconds && video.duration) {
            ep.durationSeconds = Math.round(video.duration); // for the progress bar's % only
          }
        });
        video.addEventListener('pause', function () {
          save(episodeId, Math.floor(video.currentTime), video.currentTime / (video.duration || 1) >= 0.9);
        });
        video.addEventListener('ended', function () {
          save(episodeId, Math.floor(video.duration || 0), true);
          markBtn.textContent = 'Watched ✓';
        });
        video.addEventListener('play', function () {
          stopTimers();
          saveTimer = setInterval(function () {
            if (!video.paused) save(episodeId, Math.floor(video.currentTime), false);
          }, 5000);
        });
        if (ep.watchUrl) video.load();
      } else if (ep.watchUrl) {
        // Record first_opened_at the way the spec defines it: opening the
        // link counts as starting the episode, with no position.
        save(episodeId, savedPos, false);
      }

      markBtn.addEventListener('click', function () {
        const done = markBtn.textContent.indexOf('✓') !== -1;
        if (done) return;
        const pos = currentVideo ? Math.floor(currentVideo.currentTime) : Math.max(savedPos, 0);
        save(episodeId, pos, true).then(function () {
          markBtn.textContent = 'Watched ✓';
          HC.screens.toast('Marked as watched');
          HC.api.cacheDrop('next'); HC.api.cacheDrop('cw');
        });
      });
      if (unmarkBtn) {
        unmarkBtn.addEventListener('click', function () {
          HC.api.mutate('DELETE', '/api/watches/' + episodeId, undefined, { dedupe: 'unwatch:' + episodeId })
            .then(function (r) {
              if (r && r.queued) { HC.screens.toast('Removed on this device. Will sync when you are back online.'); }
              else { HC.screens.toast('Removed from history'); }
              HC.api.cacheDrop('next'); HC.api.cacheDrop('cw'); HC.api.cacheDrop('ep:' + episodeId);
              mount(view, episodeId);
            }).catch(function () {
              HC.screens.toast('Could not remove it. Try again.');
            });
        });
      }
    }
  }

  function fmtDur(sec) {
    sec = Number(sec) || 0;
    if (sec >= 60) return Math.round(sec / 60) + ' min';
    return sec + 's';
  }

  // Called by the router before every navigation: flush the last position
  // so a quick back-swipe cannot lose a few seconds.
  function teardown() {
    stopTimers();
    if (currentVideo && currentSave && !currentVideo.paused) {
      const v = currentVideo;
      const body = currentSave;
      body.positionSeconds = Math.floor(v.currentTime);
      save(body.episodeId, body.positionSeconds, false);
    }
    currentVideo = null;
  }

  window.addEventListener('pagehide', function () {
    if (currentVideo && currentSave) {
      // Best effort: the queued write keeps the position for the next load
      // even if the network never sees it.
      save(currentSave.episodeId, Math.floor(currentVideo.currentTime || 0), false);
    }
  });

  return { mount: mount, teardown: teardown };
})();

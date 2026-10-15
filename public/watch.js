/* The watch view's player: one episode, played inside the app's TV look.
 * Loaded by app.js only when this view opens; hls.js (the one new
 * dependency, served from /vendor/hls.min.js) is loaded below it only when
 * an episode actually streams HLS.
 *
 * What it does: resume from the stored position, skip intro, captions with
 * a size/background picker, quality from the HLS manifest (Auto + heights),
 * PiP and fullscreen where the browser has them, a Download button (run by
 * downloads.js), an 8-second next-episode countdown at the end, progress
 * saved every 15 seconds and on pause/leave, and playback from a download
 * when the network is gone.
 */
(function () {
  'use strict';

  var HC = window.HC;
  var i18n = window.i18n;
  var $ = function (id) { return document.getElementById(id); };
  var esc = HC.esc;

  // ── State ───────────────────────────────────────────────────────────────

  var S = {
    id: null,          // the episode being shown
    data: null,        // the /api/watch/:id answer
    hls: null,         // the hls.js instance, when streaming
    blobUrl: null,     // object URL of a downloaded episode
    playing: false,
    completed: false,  // watch_completed already fired for this episode
    started: false,    // watch_started already fired
    lastHb: 0,         // last heartbeat position, in seconds
    lastSent: 0,       // last progress position sent, in seconds
    offline: false,    // playing from a download, no network
    countdown: null,   // the next-episode countdown timer id
    controlsTimer: null,
    levels: null,      // [{ i, h }] quality levels, from the manifest
    pendingSeek: null, // position to seek to once metadata arrives
  };

  window.HCWatch = {
    show: show,
    active: function () { return S.id; },
    currentPosition: function () {
      var v = video();
      return v && v.duration ? Math.floor(v.currentTime) : null;
    },
    currentDuration: function () {
      var v = video();
      return v && v.duration ? Math.round(v.duration) : null;
    },
    dramaId: function () {
      return S.data && S.data.drama ? S.data.drama.id : null;
    },
  };

  function video() { return $('player-video'); }

  // ── Entry ───────────────────────────────────────────────────────────────

  function show(id) {
    cleanup();
    S.id = Number(id);
    $('watch-body').hidden = true;
    $('watch-state').hidden = false;
    $('watch-state').innerHTML = loadingHtml();
    HC.api('watch/' + id).then(function (data) {
      setup(data, false);
    }).catch(function (err) {
      console.error('watch show failed for ' + id, err);
      // A network failure on a downloaded episode is not an error: the
      // download plays from IndexedDB with no connection at all.
      offlinePlayback(id).then(function (found) {
        if (found) return;
        if (err.status === undefined && !navigator.onLine) offlineBanner(true);
        renderError(id);
      });
    });
  }

  function loadingHtml() {
    var bar = function (w) { return '<div class="skeleton" style="height:12px;width:' + w + '"></div>'; };
    return '<div class="skeleton" style="height:210px;border-radius:12px;margin-bottom:16px"></div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' + bar('55%') + bar('35%') + '</div>';
  }

  function renderError(id) {
    $('watch-state').hidden = false;
    $('watch-body').hidden = true;
    $('watch-state').innerHTML =
      '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('watch_error_title')) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('state_error_body')) + '</p>' +
      '<button id="retry-watch" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div>';
    $('retry-watch').addEventListener('click', function () { show(id); });
  }

  function cleanup() {
    if (S.countdown) { clearInterval(S.countdown); S.countdown = null; }
    if (S.controlsTimer) { clearTimeout(S.controlsTimer); S.controlsTimer = null; }
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    var v = video();
    if (v) {
      try { v.pause(); } catch (e) {}
      v.removeAttribute('src');
      try { v.load(); } catch (e) {}
      var track = v.querySelector('track');
      if (track) track.parentNode.removeChild(track);
    }
    if (S.blobUrl) { URL.revokeObjectURL(S.blobUrl); S.blobUrl = null; }
    overlayHide();
    S.playing = false;
    S.completed = false;
    S.started = false;
    S.lastHb = 0;
    S.lastSent = 0;
    S.offline = false;
    S.levels = null;
    S.pendingSeek = null;
  }

  function setup(data, offline) {
    S.data = data;
    S.offline = !!offline;
    var ep = data.episode;
    var drama = data.drama || {};

    $('watch-title').textContent = i18n.t('episode_n_colon', { n: ep.number, title: ep.title });
    document.title = i18n.t('title_watch', { drama: drama.title || '', s: ep.season, n: ep.number, title: ep.title });
    renderUpnext(data);

    $('watch-state').hidden = true;
    $('watch-state').innerHTML = '';
    $('watch-body').hidden = false;

    // No playable video: say so, and offer the episode's own link.
    var v = video();
    if (!ep.media_url && !S.blobUrl) {
      v.hidden = true;
      $('player-bigplay').hidden = true;
      $('player-controls').hidden = true;
      var inner =
        '<div class="p-ovcard"><div class="text-body font-semibold">' + esc(i18n.t('no_video_title')) + '</div>' +
        '<p class="sm" style="color:rgb(var(--muted))">' + esc(i18n.t('no_video_body')) + '</p>';
      if (ep.watch_url) {
        inner += '<div class="p-ovrow"><a class="btn-secondary" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(ep.watch_url) + '">' + esc(i18n.t('open_the_link')) + '</a></div>';
      }
      overlayShow(inner + '</div>');
      return;
    }

    v.hidden = false;
    attachSource(ep);
    wireControls(ep);
  }

  // ── Source: hls.js for manifests, a download when offline, direct else ──

  function attachSource(ep) {
    var v = video();
    $('player-bigplay').hidden = false;
    if (S.blobUrl) {
      // Playing a download: a blob URL needs no CORS wiring.
      v.removeAttribute('crossorigin');
      v.src = S.blobUrl;
      setTrack(ep);
      return;
    }
    var base = ep.media_url.split('?')[0];
    if (/\.m3u8$/.test(base)) {
      HC.ensureScript('vendor/hls.min.js').then(function () {
        if (window.Hls && window.Hls.isSupported()) attachHls(ep);
        else directSource(ep);
      }).catch(function () { directSource(ep); });
      return;
    }
    directSource(ep);
  }

  function directSource(ep) {
    var v = video();
    // The video element's crossorigin decides whether a cross-origin
    // caption file may be fetched at all; leave it off otherwise, so a
    // plain MP4 that sends no CORS headers still plays.
    var cross = ep.subtitle_url && !/^(\/|blob:)/.test(ep.subtitle_url);
    if (cross) v.setAttribute('crossorigin', 'anonymous');
    else v.removeAttribute('crossorigin');
    v.src = S.blobUrl || ep.media_url;
    setTrack(ep);
  }

  function attachHls(ep) {
    var v = video();
    v.removeAttribute('crossorigin'); // hls.js fetches segments itself
    var hls = new window.Hls({ startLevel: -1 });
    S.hls = hls;
    hls.loadSource(ep.media_url);
    hls.attachMedia(v);
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      buildQualityMenu();
      applySavedQuality();
      setTrack(ep);
    });
    hls.on(window.Hls.Events.ERROR, function (_e, d) {
      if (d && d.fatal) {
        if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
        mediaError();
      }
    });
  }

  function mediaError() {
    var v = video();
    v.pause();
    S.playing = false;
    $('player-bigplay').hidden = true;
    overlayShow(
      '<div class="p-ovcard"><div class="text-body font-semibold">' + esc(i18n.t('play_error_title')) + '</div>' +
      '<p class="sm" style="color:rgb(var(--muted))">' + esc(i18n.t('play_error_body')) + '</p>' +
      '<div class="p-ovrow"><button id="player-reload" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div></div>'
    );
    $('player-reload').addEventListener('click', function () {
      overlayHide();
      show(S.id);
    });
  }

  // ── Captions ────────────────────────────────────────────────────────────

  function captionPrefs() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('hc-captions') || 'null'); } catch (e) {}
    return Object.assign({ size: 'standard', bg: 'half' }, saved || {});
  }
  function saveCaptionPrefs(p) {
    try { localStorage.setItem('hc-captions', JSON.stringify(p)); } catch (e) {}
  }
  var CAPTION_SIZES = { small: '15px', standard: '21px', large: '30px' };
  var CAPTION_BGS = { clear: 'rgba(0,0,0,0)', half: 'rgba(0,0,0,0.55)', solid: 'rgba(0,0,0,0.95)' };
  function applyCaptionStyle() {
    var p = captionPrefs();
    var el = document.getElementById('hc-cue-style') || document.head.appendChild(document.createElement('style'));
    el.id = 'hc-cue-style';
    el.textContent = '#player-video::cue{font-size:' + CAPTION_SIZES[p.size] +
      ';background:' + CAPTION_BGS[p.bg] + ';color:#fff}';
  }

  function setTrack(ep) {
    var v = video();
    var old = v.querySelector('track');
    if (old) old.parentNode.removeChild(old);
    if (!ep.subtitle_url) { $('player-cc').hidden = true; return; }
    applyCaptionStyle();
    var track = document.createElement('track');
    track.kind = 'captions';
    track.label = 'CC';
    track.src = ep.subtitle_url;
    v.appendChild(track);
    var cc = $('player-cc');
    cc.hidden = false;
    cc.setAttribute('data-cc', 'off');
    cc.classList.remove('p-on');
  }

  function toggleCaptions() {
    var v = video();
    var t = v.textTracks[0];
    if (!t) return;
    var show = t.mode !== 'showing';
    t.mode = show ? 'showing' : 'hidden';
    var cc = $('player-cc');
    cc.setAttribute('data-cc', show ? 'on' : 'off');
    cc.classList.toggle('p-on', show);
  }

  function openCaptionsMenu() {
    var p = captionPrefs();
    var on = video().textTracks[0] && video().textTracks[0].mode === 'showing';
    var rows = menuRow('cc-toggle', '1', on ? i18n.t('cc_on') : i18n.t('cc'), on) +
      menuLabel(i18n.t('captions_size')) +
      ['small', 'standard', 'large'].map(function (k) {
        return menuRow('cc-size', k, i18n.t(k), p.size === k);
      }).join('') +
      menuLabel(i18n.t('captions_bg')) +
      ['clear', 'half', 'solid'].map(function (k) {
        return menuRow('cc-bg', k, i18n.t(k), p.bg === k);
      }).join('');
    overlayShow('<div class="p-menu">' + rows + '</div>');
    bindMenu(function (kind, val) {
      if (kind === 'cc-toggle') { toggleCaptions(); overlayHide(); return; }
      if (kind === 'cc-size') p.size = val; else p.bg = val;
      saveCaptionPrefs(p);
      applyCaptionStyle();
      overlayHide();
    });
  }

  // ── Quality ─────────────────────────────────────────────────────────────

  function buildQualityMenu() {
    if (!S.hls) return;
    var heights = (S.hls.levels || [])
      .map(function (l, i) { return { i: i, h: l.height || 0 }; })
      .filter(function (l) { return l.h; })
      .sort(function (a, b) { return b.h - a.h; });
    if (!heights.length) return;
    S.levels = heights;
    $('player-quality').hidden = false;
    labelQuality();
  }
  function labelQuality() {
    if (!S.hls) return;
    $('player-quality').textContent = S.hls.autoLevelEnabled
      ? i18n.t('auto')
      : currentHeightLabel();
  }
  function currentHeightLabel() {
    var cur = S.hls ? S.hls.levels[S.hls.currentLevel] : null;
    return cur && cur.height ? cur.height + 'p' : i18n.t('auto');
  }
  function applySavedQuality() {
    if (!S.hls || !S.levels) return;
    var saved = parseInt(localStorage.getItem('hc-quality'), 10);
    if (!isNaN(saved)) {
      var hit = S.levels.filter(function (l) { return l.i === saved; })[0];
      if (hit) S.hls.currentLevel = hit.i;
    }
    labelQuality();
  }
  function openQualityMenu() {
    if (!S.hls || !S.levels) return;
    var isAuto = S.hls.autoLevelEnabled;
    var rows = menuRow('q', '-1', i18n.t('auto'), isAuto) +
      S.levels.map(function (l) {
        return menuRow('q', String(l.i), l.h + 'p', !isAuto && S.hls.currentLevel === l.i);
      }).join('');
    overlayShow('<div class="p-menu">' + rows + '</div>');
    bindMenu(function (_kind, val) {
      var n = parseInt(val, 10);
      S.hls.currentLevel = n;
      try { localStorage.setItem('hc-quality', String(n)); } catch (e) {}
      overlayHide();
      labelQuality();
    });
  }

  function menuRow(kind, val, label, on) {
    return '<button class="p-menu-row' + (on ? ' p-on' : '') + '" data-menu-kind="' + kind + '" data-menu-val="' + esc(val) + '">' +
      esc(label) + (on ? '<span aria-hidden="true">✓</span>' : '') + '</button>';
  }
  function menuLabel(text) {
    return '<div class="p-menu-label">' + esc(text) + '</div>';
  }
  function bindMenu(onPick) {
    Array.prototype.forEach.call(
      document.querySelectorAll('#player-overlay [data-menu-kind]'),
      function (b) {
        b.addEventListener('click', function () {
          onPick(b.getAttribute('data-menu-kind'), b.getAttribute('data-menu-val'));
        });
      }
    );
  }

  // ── Overlay (resume prompt, countdown, menus) ───────────────────────────

  function overlayShow(inner) {
    var o = $('player-overlay');
    o.innerHTML = inner;
    o.hidden = false;
  }
  function overlayHide() {
    var o = $('player-overlay');
    o.hidden = true;
    o.innerHTML = '';
  }

  function showResume(seconds) {
    var v = video();
    overlayShow(
      '<div class="p-ovcard"><div class="text-body font-semibold">' +
      esc(i18n.t('resume_from', { time: fmt(seconds) })) + '</div>' +
      '<div class="p-ovrow"><button id="resume-yes" class="btn-primary">' + esc(i18n.t('resume')) + '</button>' +
      '<button id="resume-no" class="btn-secondary">' + esc(i18n.t('start_over')) + '</button></div></div>'
    );
    $('resume-yes').addEventListener('click', function () {
      overlayHide();
      v.currentTime = seconds;
      play();
    });
    $('resume-no').addEventListener('click', function () {
      overlayHide();
      v.currentTime = 0;
      play();
    });
  }

  // ── Controls ────────────────────────────────────────────────────────────

  // Listeners that live on the static markup are wired once, here; per-
  // episode state (button handlers, visibility) is set in wireControls.
  function initStatic() {
    var v = video();
    var box = $('player-box');
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', function () {
      // A direct-source failure (hls.js reports its own through its
      // ERROR event).
      if (!S.hls && v.error && v.src) mediaError();
    });
    box.addEventListener('click', function (e) {
      if (e.target.closest('button, a, .p-menu, .p-ovcard')) return;
      var vv = video();
      if (!vv.duration || !$('watch-body') || $('watch-body').hidden) return;
      showControls();
      if (S.playing) vv.pause(); else play();
    });
    box.addEventListener('mousemove', showControls);
    box.addEventListener('touchstart', showControls, { passive: true });
    // Seek: a click on the progress bar jumps there.
    $('player-bar').parentElement.addEventListener('click', function (e) {
      var vv = video();
      if (!vv.duration) return;
      var r = e.currentTarget.getBoundingClientRect();
      var x = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
      vv.currentTime = x * vv.duration;
      showControls();
    });
    document.addEventListener('keydown', keydown);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && S.id) sendProgress(true);
    });
  }

  function wireControls(ep) {
    var v = video();
    $('player-controls').hidden = false;

    $('player-bigplay').onclick = function () { play(); };
    $('player-playpause').onclick = function () { v.paused ? play() : v.pause(); };
    $('player-skip').onclick = function () { v.currentTime = 90; };
    $('player-quality').onclick = openQualityMenu;
    $('player-cc').onclick = openCaptionsMenu;
    $('player-fs').onclick = toggleFullscreen;
    $('player-pip').onclick = togglePip;
    $('player-download').onclick = function () {
      HC.ensureScript('downloads.js').then(function () {
        window.HCDownloads.start(S.data.episode, S.data.drama);
      });
    };
    $('player-pip').hidden = !('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled;
    $('player-fs').hidden = !document.fullscreenEnabled;
    $('player-download').hidden = !ep.media_url;
    $('player-skip').hidden = true;
  }

  function keydown(e) {
    if ($('view-watch').hidden) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    var v = video();
    if (!v.duration) return;
    switch (e.key) {
      case ' ': case 'k': case 'K':
        e.preventDefault(); v.paused ? play() : v.pause(); break;
      case 'ArrowLeft': e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); break;
      case 'ArrowRight': e.preventDefault(); v.currentTime = Math.min(v.duration, v.currentTime + 10); break;
      case 'j': case 'J': v.currentTime = Math.max(0, v.currentTime - 10); break;
      case 'l': case 'L': v.currentTime = Math.min(v.duration, v.currentTime + 10); break;
      case 'ArrowUp': e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
      case 'ArrowDown': e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
      case 'm': case 'M': v.muted = !v.muted; break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'c': case 'C': toggleCaptions(); break;
    }
    showControls();
  }

  function toggleFullscreen() {
    var box = $('player-box');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.fullscreenEnabled) box.requestFullscreen();
  }

  function togglePip() {
    var v = video();
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else if (document.pictureInPictureEnabled) v.requestPictureInPicture().catch(function () {});
  }

  function play() {
    var v = video();
    if (!v.src && !v.currentSrc) return;
    var pr = v.play();
    if (pr && pr.catch) pr.catch(function () {});
  }

  function onPlay() {
    S.playing = true;
    $('player-playpause-icon').innerHTML = '<path d="M7 5h4v14H7zM14 5h4v14h-4z"/>';
    $('player-bigplay').hidden = true;
    if (!S.started) {
      S.started = true;
      HC.track('watch_started', { episode_id: S.id });
    }
    showControls();
  }
  function onPause() {
    S.playing = false;
    $('player-playpause-icon').innerHTML = '<path d="M8 5l11 7-11 7z"/>';
    $('player-bigplay').hidden = false;
    sendProgress(true);
    showControls();
  }

  function onMeta() {
    var v = video();
    $('player-duration').textContent = fmt(v.duration);
    // The stored position offers a resume when it is far enough in and the
    // episode is not already finished.
    var pb = S.data && S.data.playback;
    var pos = pb ? pb.position_s : 0;
    if (v.duration && pos >= 15 && pos < v.duration - 30 && pos / v.duration < 0.9) {
      S.pendingSeek = pos;
      showResume(pos);
    } else if (v.duration && pos >= 15 && (pos >= v.duration - 30 || pos / v.duration >= 0.9)) {
      // Finished before: start clean.
      S.pendingSeek = 0;
    } else if (pos > 0 && pos < 15) {
      S.pendingSeek = pos;
    } else {
      S.pendingSeek = null;
    }
    if (S.pendingSeek !== null && !S.hls) {
      try { v.currentTime = S.pendingSeek; } catch (e) {}
      if (S.pendingSeek === pos && pos > 0) S.lastHb = pos;
      S.pendingSeek = null;
    }
  }

  function onTime() {
    var v = video();
    if (!v.duration) return;
    $('player-bar').style.width = ((v.currentTime / v.duration) * 100) + '%';
    $('player-time').textContent = fmt(v.currentTime);
    // Skip intro shows from 5 seconds in until the 90 second mark, when the
    // episode is long enough to have one.
    $('player-skip').hidden = !(v.duration > 135 && v.currentTime >= 5 && v.currentTime < 90);
    // A heartbeat every 15 seconds of position, and completion at 90%.
    if (Math.floor(v.currentTime / 15) > Math.floor(S.lastHb / 15)) {
      S.lastHb = v.currentTime;
      sendProgress();
      HC.track('watch_heartbeat', { episode_id: S.id, position_s: Math.floor(v.currentTime) });
    }
    if (!S.completed && v.currentTime / v.duration >= 0.9) {
      S.completed = true;
      sendProgress();
      HC.track('watch_completed', { episode_id: S.id });
      HC.api('episodes/' + S.id + '/watched', { method: 'PUT' }).catch(function () {});
    }
  }

  function onEnded() {
    var v = video();
    v.pause();
    S.playing = false;
    if (!S.completed) {
      S.completed = true;
      HC.track('watch_completed', { episode_id: S.id });
      HC.api('episodes/' + S.id + '/watched', { method: 'PUT' }).catch(function () {});
    }
    var next = S.data && S.data.next;
    if (next && next.has_media) startCountdown(next);
    else if (next) $('watch-next-note').textContent = i18n.t('next_episode') + ': ' + next.title;
  }

  function startCountdown(next) {
    var left = 8;
    drawCountdown(next, left);
    S.countdown = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(S.countdown);
        S.countdown = null;
        overlayHide();
        location.hash = '#/watch/' + next.id;
      } else {
        drawCountdown(next, left);
      }
    }, 1000);
  }
  function drawCountdown(next, left) {
    overlayShow(
      '<div class="p-ovcard"><div class="text-body font-semibold">' + esc(next.title) + '</div>' +
      '<p class="sm" style="color:rgb(var(--muted))">' + esc(i18n.t('next_in', { title: next.title, s: left })) + '</p>' +
      '<div class="p-ovrow"><button id="countdown-cancel" class="btn-secondary">' + esc(i18n.t('cancel')) + '</button>' +
      '<button id="countdown-go" class="btn-primary">' + esc(i18n.t('next_episode')) + '</button></div></div>'
    );
    $('countdown-cancel').onclick = function () {
      if (S.countdown) { clearInterval(S.countdown); S.countdown = null; }
      overlayHide();
      $('watch-next-note').textContent = i18n.t('next_episode') + ': ' + next.title;
    };
    $('countdown-go').onclick = function () {
      if (S.countdown) { clearInterval(S.countdown); S.countdown = null; }
      overlayHide();
      location.hash = '#/watch/' + next.id;
    };
  }

  function sendProgress(force) {
    var v = video();
    if (!v || !v.duration || S.offline) return;
    var pos = Math.floor(v.currentTime);
    if (!force && Math.abs(pos - S.lastSent) < 5) return;
    S.lastSent = pos;
    HC.api('episodes/' + S.id + '/progress', {
      method: 'PUT',
      body: { position_s: pos, duration_s: Math.round(v.duration) },
    }).catch(function () {});
  }

  window.addEventListener('pagehide', function () {
    if (!S.id || !S.started) return;
    var v = video();
    var d = v && v.duration ? v.duration : 0;
    if (d && !S.completed && v.currentTime > 5 && v.currentTime / d < 0.9) {
      HC.track('drop_off', { episode_id: S.id, position_s: Math.floor(v.currentTime) });
    }
  });

  // ── Controls visibility ─────────────────────────────────────────────────

  function showControls() {
    var c = $('player-controls');
    c.classList.remove('p-hidden');
    if (S.controlsTimer) clearTimeout(S.controlsTimer);
    if (S.playing) {
      S.controlsTimer = setTimeout(function () {
        c.classList.add('p-hidden');
      }, 3000);
    }
  }

  // ── Up next ─────────────────────────────────────────────────────────────

  function renderUpnext(data) {
    var tiles = [];
    if (data.prev) tiles.push(data.prev);
    if (data.next) tiles.push(data.next);
    var row = $('watch-upnext');
    row.innerHTML = tiles.map(function (t) {
      return '<div class="ep" data-ep="' + t.id + '" tabindex="0" role="button">' +
        '<div class="scr">' + esc(i18n.t('ep_n', { n: t.number })) + '</div><div class="foot"></div>' +
        '<div class="sm">' + esc(t.title) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(row.querySelectorAll('[data-ep]'), function (el) {
      el.addEventListener('click', function () {
        location.hash = '#/watch/' + el.getAttribute('data-ep');
      });
    });
    $('watch-next-note').textContent = data.next && data.next.has_media
      ? i18n.t('auto_next_note', { n: data.next.number })
      : '';
  }

  // ── Offline playback from a download ────────────────────────────────────

  function offlinePlayback(id) {
    return HC.ensureScript('downloads.js').then(function () {
      return window.HCDownloads.lookup(id).then(function (rec) {
        if (!rec) return false;
        S.blobUrl = rec.videoUrl;
        setup({
          episode: Object.assign({}, rec.meta, {
            media_url: rec.videoUrl,
            subtitle_url: rec.subtitleUrl || null,
          }),
          drama: rec.meta.drama || null,
          prev: null,
          next: null,
          playback: rec.meta.playback || null,
        }, true);
        $('player-download').hidden = true;
        return true;
      });
    }).catch(function () { return false; });
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  initStatic();
})();

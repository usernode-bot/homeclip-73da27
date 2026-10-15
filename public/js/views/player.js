// Video player: play/pause, seek bar, fullscreen, episode switcher, next
// episode, playback speed and subtitle language selector. Episodes point
// at royalty-free sample videos; playback resumes from the viewer's last
// minute, and progress is saved as it plays.

import { api } from '../api.js';
import { el, icon, openSheet, toast, timeFmt, errorState, emptyState } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../router.js';
import { store } from '../store.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

let cleanup = null; // set by render(), run by unmount()

export function unmount() {
  if (cleanup) {
    try { cleanup(); } catch {}
    cleanup = null;
  }
}

export async function render({ view, params, query }) {
  const dramaId = parseInt(params[0], 10);
  let ep = parseInt(params[1], 10);
  // Demo rows (staging seed) need ?demo=1 forwarded to the API.
  const demoQ = query.get('demo') === '1' ? '?demo=1' : '';
  if (cleanup) unmount(); // a previous player instance may still be wired

  view.innerHTML = '';
  const stageSkel = el(
    '<div><div class="skeleton mb-4 w-full rounded-2xl border-0" style="aspect-ratio:16/9"></div>' +
    '<div class="skeleton h-5 w-48"></div></div>'
  );
  view.appendChild(stageSkel);

  let data;
  try {
    data = await api('/api/dramas/' + dramaId + demoQ);
  } catch (e) {
    view.innerHTML = '';
    if (e.status === 404) view.appendChild(emptyState(t('detail.notFound'), ''));
    else view.appendChild(errorState(() => render({ view, params })));
    return;
  }

  const { drama: d, episodes, progress } = data;
  const eps = episodes.map((e) => ({ num: e.num, durationMin: e.duration_min, videoUrl: e.video_url }));
  if (!eps.some((e) => e.num === ep)) ep = eps[0].num;

  view.innerHTML = '';
  const root = el('<div class="hc-player"></div>');
  view.appendChild(root);

  const stage = el(
    '<div class="hc-player-stage" data-stage>' +
      '<video class="absolute inset-0 h-full w-full object-contain" preload="metadata" playsinline controlslist="nodownload"></video>' +
      // Top bar: back + episode label.
      '<div class="absolute inset-x-0 top-0 flex items-center gap-2 p-2">' +
        '<button type="button" class="hc-iconbtn text-white" data-back aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</button>' +
        '<p class="min-w-0 truncate text-small text-white/90" data-eplabel></p>' +
      '</div>' +
      // Center big play button, visible while paused.
      '<button type="button" class="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-bigplay aria-label="' + t('player.play') + '">' +
        icon('play', 'h-8 w-8') +
      '</button>' +
      // Ended overlay.
      '<div class="absolute inset-0 hidden flex-col items-center justify-center gap-3 bg-black/70 p-4 text-center" data-ended>' +
        '<p class="text-heading text-white">' + t('player.ended') + '</p>' +
        '<div class="flex flex-wrap justify-center gap-2" data-ended-actions></div>' +
      '</div>' +
      // Bottom controls.
      '<div class="hc-player-controls" data-controlswrap>' +
        '<div class="px-1"><input class="hc-seek w-full" type="range" min="0" max="1000" value="0" step="1" aria-label="' + t('player.play') + ' / ' + t('player.pause') + '"></div>' +
        '<div class="flex items-center gap-1">' +
          '<button type="button" class="hc-iconbtn text-white" data-playpause aria-label="' + t('player.play') + '" data-icon>' + icon('play') + '</button>' +
          '<span class="min-w-16 text-small tabular-nums text-white/90" data-time>0:00</span>' +
          '<span class="flex-1"></span>' +
          '<button type="button" class="hc-iconbtn text-white" data-next aria-label="' + t('player.next') + '">' + icon('next') + '</button>' +
          '<button type="button" class="hc-iconbtn text-white" data-speed aria-label="' + t('player.speed') + '" data-badge>1x</button>' +
          '<button type="button" class="hc-iconbtn text-white" data-subtitles aria-label="' + t('player.subtitles') + '">' + icon('captions') + '</button>' +
          '<button type="button" class="hc-iconbtn text-white" data-episodes aria-label="' + t('player.episodes') + '">' + icon('list') + '</button>' +
          '<button type="button" class="hc-iconbtn text-white" data-fullscreen aria-label="' + t('player.fullscreen') + '" data-fsicon>' + icon('fullscreen') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
  root.appendChild(stage);

  const video = stage.querySelector('video');
  const seek = stage.querySelector('.hc-seek');
  const playBtn = stage.querySelector('[data-playpause]');
  const bigPlay = stage.querySelector('[data-bigplay]');
  const endedBox = stage.querySelector('[data-ended]');
  const endedActions = stage.querySelector('[data-ended-actions]');
  const epLabel = stage.querySelector('[data-eplabel]');
  const timeLabel = stage.querySelector('[data-time]');
  const nextBtn = stage.querySelector('[data-next]');
  const speedBtn = stage.querySelector('[data-speed]');
  const subBtn = stage.querySelector('[data-subtitles]');
  const epsBtn = stage.querySelector('[data-episodes]');
  const fsBtn = stage.querySelector('[data-fullscreen]');

  // Info below the stage.
  root.appendChild(el(
    '<div class="mt-3">' +
      '<h1 class="text-heading">' + d.title + '</h1>' +
      '<p class="text-small text-muted" data-meta></p>' +
    '</div>'
  ));
  const meta = root.querySelector('[data-meta]');

  // ── Live state ─────────────────────────────────────────────────────────
  let currentEp = ep;
  let currentSub = 'off';
  let resuming = progress && progress.ep === currentEp && progress.seconds > 15;
  let scrubbing = false;
  let lastSave = 0;
  let dead = false;
  const onFsChange = () => {
    fsBtn.innerHTML = document.fullscreenElement ? icon('shrink') : icon('fullscreen');
    fsBtn.setAttribute('aria-label', document.fullscreenElement ? t('player.exitFullscreen') : t('player.fullscreen'));
  };
  const onPageHide = () => { try { saveNow(); } catch {} };

  function subtitleTracks() {
    return [
      { lang: 'en', label: 'English' },
      { lang: 'id', label: 'Bahasa Indonesia' },
    ];
  }

  function loadEp(n, { autoplay = false, keepTime = null } = {}) {
    currentEp = n;
    const src = eps.find((e) => e.num === n);
    // Two sources for the committed sample clip; the browser picks the
    // codec it supports (VP8 in webm, or H.264 in mp4).
    video.removeAttribute('src');
    video.querySelectorAll('source').forEach((s) => s.remove());
    for (const s of [
      { url: src.videoUrl + '.webm', type: 'video/webm' },
      { url: src.videoUrl + '.mp4', type: 'video/mp4' },
    ]) {
      const source = document.createElement('source');
      source.setAttribute('src', s.url);
      source.setAttribute('type', s.type);
      video.appendChild(source);
    }
    // Subtitle tracks for the sample video.
    video.querySelectorAll('track').forEach((tr) => tr.remove());
    for (const tr of subtitleTracks()) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = tr.label;
      track.srclang = tr.lang;
      track.src = '/subtitles/' + tr.lang + '.vtt';
      video.appendChild(track);
    }
    if (keepTime !== null) video.currentTime = keepTime;
    video.load();
    resuming = !!(progress && progress.ep === n && progress.seconds > 15);
    epLabel.textContent = 'EP ' + n + ' · ' + d.title;
    meta.textContent = 'EP ' + n + ' / ' + eps[eps.length - 1].num + ' · ' + eps.find((e) => e.num === n).durationMin + ' ' + t('time.min');
    updateNext();
    endedBox.classList.add('hidden');
    endedBox.classList.remove('flex');
    endedActions.innerHTML = '';
    history.replaceState({}, '', '/watch/' + d.id + '/' + n + demoQ);
    if (autoplay) play();
    setPausedUi(true);
    // A fresh episode starts with subtitles off.
    currentSub = 'off';
  }

  function updateNext() {
    const hasNext = eps.some((e) => e.num === currentEp + 1);
    nextBtn.disabled = !hasNext;
    nextBtn.classList.toggle('opacity-50', !hasNext);
  }

  function setPausedUi(paused) {
    playBtn.innerHTML = icon(paused ? 'play' : 'pause');
    playBtn.setAttribute('aria-label', paused ? t('player.play') : t('player.pause'));
    bigPlay.classList.toggle('hidden', !paused);
  }

  function play() {
    video.play().catch(() => {
      // Autoplay policies refuse without a gesture; playback starts from the
      // viewer's tap, so this only guards a race.
    });
  }

  function saveNow() {
    if (dead || !store.me || !store.me.user) return;
    if (!video.duration || !isFinite(video.duration) || video.currentTime <= 0) return;
    api('/api/progress', {
      method: 'POST',
      body: {
        dramaId: d.id,
        ep: currentEp,
        seconds: Math.floor(video.currentTime),
        duration: Math.floor(video.duration),
      },
      action: 'save your progress',
    }).catch(() => {});
  }

  function onEnded() {
    setPausedUi(true);
    saveNow();
    endedBox.classList.remove('hidden');
    endedBox.classList.add('flex');
    endedActions.innerHTML = '';
    const hasNext = eps.some((e) => e.num === currentEp + 1);
    if (hasNext) {
      const nx = el('<button type="button" class="btn-primary">' + t('player.next') + '</button>');
      nx.addEventListener('click', () => switchEp(currentEp + 1, { autoplay: true }));
      endedActions.appendChild(nx);
    } else {
      endedActions.appendChild(el('<p class="text-small text-white/80">' + t('player.lastEp') + '</p>'));
    }
    const again = el('<button type="button" class="btn-secondary">' + t('player.watchAgain') + '</button>');
    again.addEventListener('click', () => {
      video.currentTime = 0;
      endedBox.classList.add('hidden');
      endedBox.classList.remove('flex');
      play();
    });
    endedActions.appendChild(again);
  }

  function switchEp(n, { autoplay = false } = {}) {
    saveNow();
    loadEp(n, { autoplay });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  loadEp(currentEp);

  video.addEventListener('loadedmetadata', () => {
    if (resuming) {
      const at = Math.min(progress.seconds, Math.max(0, video.duration - 10));
      if (at > 0) {
        video.currentTime = at;
        toast(t('player.resumeFrom', { t: timeFmt(at) }));
      }
      resuming = false;
    }
  });
  video.addEventListener('play', () => setPausedUi(false));
  video.addEventListener('pause', () => { setPausedUi(true); saveNow(); });
  video.addEventListener('ended', onEnded);
  video.addEventListener('timeupdate', () => {
    if (!scrubbing && video.duration) {
      seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
      timeLabel.textContent = timeFmt(video.currentTime);
    }
    const now = Date.now();
    if (!video.paused && now - lastSave > 5000) {
      lastSave = now;
      saveNow();
    }
  });
  video.addEventListener('error', () => {
    // The video element's failure is shown here, not thrown.
    endedBox.classList.remove('hidden');
    endedBox.classList.add('flex');
    endedActions.innerHTML = '';
    const msg = el('<p class="text-small text-white/80">' + t('player.error') + '</p>');
    const retry = el('<button type="button" class="btn-secondary">' + t('common.retry') + '</button>');
    retry.addEventListener('click', () => {
      endedBox.classList.add('hidden');
      endedBox.classList.remove('flex');
      loadEp(currentEp);
    });
    endedActions.appendChild(msg);
    endedActions.appendChild(retry);
  });

  playBtn.addEventListener('click', () => { video.paused ? play() : video.pause(); });
  bigPlay.addEventListener('click', () => { play(); });
  stage.addEventListener('click', (e) => {
    // Tapping the video itself toggles playback (buttons handle their own).
    if (e.target === video) { video.paused ? play() : video.pause(); }
  });

  seek.addEventListener('input', () => {
    if (video.duration) {
      scrubbing = true;
      video.currentTime = (Number(seek.value) / 1000) * video.duration;
      timeLabel.textContent = timeFmt(video.currentTime);
    }
  });
  seek.addEventListener('change', () => { scrubbing = false; saveNow(); });

  // Fullscreen must start from a real user gesture.
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
      if (req) stage.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('pagehide', onPageHide);

  nextBtn.addEventListener('click', () => {
    if (eps.some((e) => e.num === currentEp + 1)) switchEp(currentEp + 1, { autoplay: true });
  });

  // Playback speed menu.
  speedBtn.addEventListener('click', () => {
    const menu = el('<div role="menu" aria-label="' + t('player.speed') + '"><p class="section-label">' + t('player.speed') + '</p></div>');
    for (const s of SPEEDS) {
      const active = Math.abs(video.playbackRate - s) < 0.01;
      const item = el(
        '<button type="button" role="menuitemradio" aria-checked="' + active + '" class="list-row w-full ' +
        (active ? 'text-accent' : 'text-fg') + '">' + s + 'x</button>'
      );
      item.addEventListener('click', () => {
        video.playbackRate = s;
        speedBtn.textContent = (s === 1 ? '1' : String(s)) + 'x';
        menu.close();
      });
      menu.appendChild(item);
    }
    const sheet = openSheet(menu, { label: t('player.speed') });
    menu.close = sheet.close;
  });

  // Subtitle language selector.
  subBtn.addEventListener('click', () => {
    const menu = el('<div role="menu" aria-label="' + t('player.subtitles') + '"><p class="section-label">' + t('player.subtitles') + '</p></div>');
    const options = [{ key: 'off', label: t('player.subOff') }].concat(
      subtitleTracks().map((tr) => ({ key: tr.lang, label: tr.label }))
    );
    for (const opt of options) {
      const active = currentSub === opt.key;
      const item = el(
        '<button type="button" role="menuitemradio" aria-checked="' + active + '" class="list-row w-full ' +
        (active ? 'text-accent' : 'text-fg') + '">' + opt.label + '</button>'
      );
      item.addEventListener('click', () => {
        currentSub = opt.key;
        const tracks = video.textTracks;
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].mode = tracks[i].language === opt.key ? 'showing' : 'hidden';
        }
        menu.close();
      });
      menu.appendChild(item);
    }
    const sheet = openSheet(menu, { label: t('player.subtitles') });
    menu.close = sheet.close;
  });

  // Episode switcher.
  epsBtn.addEventListener('click', () => {
    const menu = el('<div role="menu" aria-label="' + t('player.episodes') + '"><p class="section-label">' + t('detail.episodes') + '</p></div>');
    for (const e of eps) {
      const active = e.num === currentEp;
      const item = el(
        '<button type="button" role="menuitemradio" aria-checked="' + active + '" class="list-row w-full ' +
        (active ? 'text-accent' : 'text-fg') + '">' +
        '<span class="flex-1 text-left">' + t('detail.episode', { n: e.num }) + '</span>' +
        '<span class="text-small text-muted">' + e.durationMin + ' ' + t('time.min') + '</span>' +
        '</button>'
      );
      item.addEventListener('click', () => {
        menu.close();
        switchEp(e.num, { autoplay: true });
      });
      menu.appendChild(item);
    }
    const sheet = openSheet(menu, { label: t('player.episodes') });
    menu.close = sheet.close;
  });

  stage.querySelector('[data-back]').addEventListener('click', () => {
    saveNow();
    navigate('/drama/' + d.id);
  });

  // Space bar toggles playback (desktop convenience).
  const onKey = (e) => {
    if (e.code === 'Space' && !e.target.closest('input,button,select,textarea')) {
      e.preventDefault();
      video.paused ? play() : video.pause();
    }
  };
  document.addEventListener('keydown', onKey);

  // Leaving the player saves progress, drops every listener and exits
  // fullscreen so the next screen starts clean.
  cleanup = () => {
    dead = true;
    saveNow();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('fullscreenchange', onFsChange);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
}

// Video player: play/pause, seek bar, volume, fullscreen, episode switcher,
// next episode, playback speed and subtitle language selector. Episodes point
// at royalty-free sample videos (or one HLS demo stream); playback resumes
// from the viewer's last minute, progress is saved as it plays, and VIP
// episodes render a paywall decided by the server. Every load failure ends
// in a visible error overlay with Retry: never a dead black stage.

import { api } from '../api.js';
import { el, icon, openSheet, toast, timeFmt, errorState, emptyState } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../router.js';
import { store } from '../store.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

let cleanup = null; // set by render(), run by unmount()

// hls.js is loaded only the first time an .m3u8 episode actually opens;
// every other episode never fetches the 400 KB library.
let hlsScriptPromise = null;
function loadHlsScript() {
  if (window.Hls) return Promise.resolve();
  if (!hlsScriptPromise) {
    hlsScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/hls.min.js';
      script.onload = () => {
        if (window.Hls) resolve();
        else { hlsScriptPromise = null; reject(new Error('hls.js failed to initialise')); }
      };
      script.onerror = () => { hlsScriptPromise = null; reject(new Error('hls.js failed to load')); };
      document.head.appendChild(script);
    });
  }
  return hlsScriptPromise;
}

function isHlsUrl(url) {
  return !!url && /\.m3u8($|\?)/.test(url);
}

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
  // A demo page load forwards demo=1, so staging can show VIP episodes
  // playing (the server grants VIP in memory only behind the flag).
  const demoParam = query && query.get('demo') === '1' ? '?demo=1' : '';

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
  const eps = episodes.map((e) => ({
    num: e.num,
    durationMin: e.duration_min,
    videoUrl: e.video_url,
    fallbackUrl: e.fallback_url,
    access: e.access || 'free',
    locked: !!e.locked,
  }));
  if (!eps.some((e) => e.num === ep)) ep = eps[0].num;

  view.innerHTML = '';
  const root = el('<div class="hc-player"></div>');
  view.appendChild(root);

  const stage = el(
    '<div class="hc-player-stage" data-stage>' +
      '<video class="absolute inset-0 h-full w-full object-contain" preload="metadata" playsinline controlslist="nodownload"></video>' +
      // Top bar: back + episode label.
      '<div class="absolute inset-x-0 top-0 z-30 flex items-center gap-2 p-2">' +
        '<button type="button" class="hc-iconbtn text-white" data-back aria-label="' + t('common.back') + '">' + icon('chevronLeft') + '</button>' +
        '<p class="min-w-0 truncate text-small text-white/90" data-eplabel></p>' +
      '</div>' +
      // Center buffering spinner, shown while a load or stall is in flight.
      '<div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden" data-spinner role="status" aria-label="' + t('player.buffering') + '">' +
        '<span class="hc-spinner"></span>' +
      '</div>' +
      // Center big play button, visible while paused.
      '<button type="button" class="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-bigplay aria-label="' + t('player.play') + '">' +
        icon('play', 'h-8 w-8') +
      '</button>' +
      // Ended / error overlay (error keeps the same box, with Retry; the
      // heading swaps to the error title so a failed load never reads
      // "Episode finished").
      // z-20: above the controls bar — its full-width seek slider would
      // otherwise swallow taps on the overlay's buttons mid-screen.
      '<div class="absolute inset-0 z-20 hidden flex-col items-center justify-center gap-3 bg-black/70 p-4 text-center" data-ended>' +
        '<p class="text-heading text-white" data-ended-title>' + t('player.ended') + '</p>' +
        '<div class="flex flex-col items-center gap-3" data-ended-actions></div>' +
      '</div>' +
      // VIP paywall for locked episodes (the server stripped their URLs).
      '<div class="absolute inset-0 z-10 hidden flex-col items-center justify-center gap-2 bg-black/85 p-6 text-center" data-paywall>' +
        '<span class="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white">' + icon('lock', 'h-6 w-6') + '</span>' +
        '<p class="text-heading text-white">' + t('player.vipTitle') + '</p>' +
        '<p class="text-small text-white/70">' + t('player.vipBody') + '</p>' +
        '<div class="mt-2 flex flex-col items-center gap-2">' +
          '<a class="btn-primary" data-nav href="/tracker/vip">' + t('player.vipPlans') + '</a>' +
          '<button type="button" class="btn-secondary" data-paywall-back>' + t('common.back') + '</button>' +
        '</div>' +
      '</div>' +
      // Streaming unavailable: an unlocked episode whose record carries no
      // authorized video URL. A clear state instead of a fake player. The
      // primary action hands the viewer to the drama's authorized streaming
      // platform when one is configured (d.watch_url).
      '<div class="absolute inset-0 z-10 hidden flex-col items-center justify-center gap-2 bg-black/85 p-6 text-center" data-unavail>' +
        '<span class="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white">' + icon('globe', 'h-6 w-6') + '</span>' +
        '<p class="text-heading text-white">' + t('player.unavailable') + '</p>' +
        '<p class="text-small text-white/70">' + t('player.unavailableBody') + '</p>' +
        '<div class="mt-2 flex flex-col items-center gap-2">' +
          '<a class="btn-primary hidden" data-unav-link target="_blank" rel="noopener">' + t('player.unavailableLink') + '</a>' +
          '<button type="button" class="btn-secondary" data-unavail-back>' + t('common.back') + '</button>' +
        '</div>' +
      '</div>' +
      // Bottom controls.
      '<div class="hc-player-controls" data-controlswrap>' +
        '<div class="px-1"><input class="hc-seek w-full" type="range" min="0" max="1000" value="0" step="1" aria-label="' + t('player.seek') + '"></div>' +
        '<div class="flex flex-wrap items-center gap-1">' +
          '<button type="button" class="hc-iconbtn text-white" data-playpause aria-label="' + t('player.play') + '" data-icon>' + icon('play') + '</button>' +
          '<button type="button" class="hc-iconbtn text-white" data-mute aria-label="' + t('player.mute') + '">' + icon('volume') + '</button>' +
          (window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? '' :
            '<input class="hc-seek w-16" type="range" min="0" max="100" value="100" step="1" data-vol aria-label="' + t('player.volume') + '">') +
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
  const spinner = stage.querySelector('[data-spinner]');
  const endedBox = stage.querySelector('[data-ended]');
  const endedTitle = stage.querySelector('[data-ended-title]');
  const endedActions = stage.querySelector('[data-ended-actions]');
  const paywall = stage.querySelector('[data-paywall]');
  const unavail = stage.querySelector('[data-unavail]');
  const unavLink = stage.querySelector('[data-unav-link]');
  const controlsWrap = stage.querySelector('[data-controlswrap]');
  const epLabel = stage.querySelector('[data-eplabel]');
  const timeLabel = stage.querySelector('[data-time]');
  const nextBtn = stage.querySelector('[data-next]');
  const speedBtn = stage.querySelector('[data-speed]');
  const subBtn = stage.querySelector('[data-subtitles]');
  const epsBtn = stage.querySelector('[data-episodes]');
  const fsBtn = stage.querySelector('[data-fullscreen]');
  const muteBtn = stage.querySelector('[data-mute]');
  const volSlider = stage.querySelector('[data-vol]');

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
  let resuming = false;
  let scrubbing = false;
  let lastSave = 0;
  let dead = false;
  let hls = null;
  let spinnerOn = false;
  let errorShown = false;
  let lockedUi = false;
  let unavailUi = false;
  let countdownTimer = null;

  // Restored volume/mute (element properties survive episode switches, but
  // the remembered choice must also outlive the player view).
  try {
    const saved = JSON.parse(localStorage.getItem('hc:volume') || 'null');
    if (saved && typeof saved.volume === 'number') video.volume = Math.min(1, Math.max(0, saved.volume));
    if (saved) video.muted = !!saved.muted;
  } catch {}

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

  function applySubMode() {
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = tracks[i].language === currentSub ? 'showing' : 'hidden';
    }
  }

  function updateStageUi() {
    const paused = video.paused || video.ended;
    playBtn.innerHTML = icon(paused ? 'play' : 'pause');
    playBtn.setAttribute('aria-label', paused ? t('player.play') : t('player.pause'));
    const showBig = paused && !spinnerOn && !errorShown && !lockedUi && !unavailUi;
    bigPlay.classList.toggle('hidden', !showBig);
    spinner.classList.toggle('hidden', !spinnerOn || errorShown || lockedUi || unavailUi);
  }

  function setSpinner(on) {
    spinnerOn = on;
    updateStageUi();
  }

  function cancelCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function hideError() {
    errorShown = false;
    endedBox.classList.add('hidden');
    endedBox.classList.remove('flex');
    endedActions.innerHTML = '';
    updateStageUi();
  }

  // The stage is dead (all sources failed / HLS fell over with no
  // fallback): a message and Retry, never a silent black box.
  function showError() {
    if (errorShown || lockedUi || unavailUi || dead) return;
    errorShown = true;
    spinnerOn = false;
    endedTitle.textContent = t('player.errorTitle');
    endedBox.classList.remove('hidden');
    endedBox.classList.add('flex');
    endedActions.innerHTML = '';
    endedActions.appendChild(el('<p class="text-small text-white/80">' + t('player.error') + '</p>'));
    const retry = el('<button type="button" class="btn-secondary">' + t('common.retry') + '</button>');
    retry.addEventListener('click', () => { loadEp(currentEp); });
    endedActions.appendChild(retry);
    updateStageUi();
  }

  function showPaywall() {
    lockedUi = true;
    hideError();
    cancelCountdown();
    paywall.classList.remove('hidden');
    paywall.classList.add('flex');
    controlsWrap.classList.add('hidden');
    updateStageUi();
  }

  function hidePaywall() {
    lockedUi = false;
    paywall.classList.add('hidden');
    paywall.classList.remove('flex');
    controlsWrap.classList.remove('hidden');
    updateStageUi();
  }

  function showUnavailable() {
    unavailUi = true;
    hideError();
    cancelCountdown();
    hidePaywall();
    if (d.watch_url) {
      unavLink.href = d.watch_url;
      unavLink.classList.remove('hidden');
    } else {
      unavLink.classList.add('hidden');
    }
    unavail.classList.remove('hidden');
    unavail.classList.add('flex');
    controlsWrap.classList.add('hidden');
    updateStageUi();
  }

  function hideUnavailable() {
    if (!unavailUi) return;
    unavailUi = false;
    unavail.classList.add('hidden');
    unavail.classList.remove('flex');
    unavLink.classList.add('hidden');
    controlsWrap.classList.remove('hidden');
    updateStageUi();
  }

  // Append the webm/mp4 pair for an extensionless clip URL. The WebM source
  // stays FIRST: browsers without H.264 (the check runner among them) only
  // decode VP8/VP9, and source order is the browser's trial order. Each
  // source carries its own error listener — with <source> children the
  // browser fires `error` on the sources, not on the video, and only the
  // last failure leaves the element in NETWORK_NO_SOURCE.
  function appendSources(base) {
    for (const s of [
      { url: base + '.webm', type: 'video/webm' },
      { url: base + '.mp4', type: 'video/mp4' },
    ]) {
      const source = document.createElement('source');
      source.setAttribute('src', s.url);
      source.setAttribute('type', s.type);
      source.addEventListener('error', () => {
        if (video.networkState === 3) showError(); // NETWORK_NO_SOURCE
      });
      video.appendChild(source);
    }
  }

  function loadEp(n, { autoplay = false, keepTime = null } = {}) {
    cancelCountdown();
    hideError();
    currentEp = n;
    const src = eps.find((e) => e.num === n);
    // Tear down the previous episode's playback context.
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    video.removeAttribute('src');
    video.querySelectorAll('source').forEach((s) => s.remove());
    video.querySelectorAll('track').forEach((tr) => tr.remove());
    // Subtitle tracks for the sample video.
    for (const tr of subtitleTracks()) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = tr.label;
      track.srclang = tr.lang;
      track.src = '/subtitles/' + tr.lang + '.vtt';
      video.appendChild(track);
    }
    currentSub = 'off';
    applySubMode();
    if (keepTime !== null) video.currentTime = keepTime;
    resuming = !!(progress && progress.ep === n && progress.seconds > 15);
    epLabel.textContent = 'EP ' + n + ' · ' + d.title;
    meta.textContent = 'EP ' + n + ' / ' + eps[eps.length - 1].num + ' · ' + eps.find((e) => e.num === n).durationMin + ' ' + t('time.min');
    updateNext();
    endedBox.classList.add('hidden');
    endedBox.classList.remove('flex');
    endedActions.innerHTML = '';
    // Keep the demo flag in the address so a reload of this episode stays a
    // demo load.
    history.replaceState({}, '', '/watch/' + d.id + '/' + n + demoQ);

    // A locked episode carries no video URL from the server; the paywall
    // is the stage. Episode rows and badges still navigate here on purpose.
    if (src.locked) { hideUnavailable(); showPaywall(); return; }
    hidePaywall();
    // An unlocked episode with no video URL: no authorized source exists,
    // so the stage says so instead of pretending to play (never a sample
    // clip standing in for a real show).
    if (!src.videoUrl) { showUnavailable(); return; }
    hideUnavailable();

    if (isHlsUrl(src.videoUrl)) {
      attachHls(src, autoplay);
    } else {
      appendSources(src.videoUrl);
      video.load();
      setSpinner(true); // buffering while the new episode loads
      if (autoplay) play();
    }
    updateStageUi();
  }

  // .m3u8 episodes: Safari plays HLS natively; elsewhere hls.js is lazily
  // injected and attached, and any fatal failure falls back to the
  // episode's same-origin clip.
  function attachHls(src, autoplay) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src.videoUrl;
      video.load();
      setSpinner(true);
      if (autoplay) play();
      updateStageUi();
      return;
    }
    if (window.Hls && window.Hls.isSupported()) {
      startHls(src, autoplay);
      return;
    }
    setSpinner(true);
    updateStageUi();
    loadHlsScript()
      .then(() => { if (!dead && currentEp === src.num) startHls(src, autoplay); })
      .catch(() => { if (!dead && currentEp === src.num) useFallback(src, autoplay); });
  }

  function startHls(src, autoplay) {
    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) { useFallback(src, autoplay); return; }
    hls = new Hls({ enableWorker: true });
    hls.on(Hls.Events.ERROR, (_evt, hlsData) => {
      if (hlsData && hlsData.fatal) {
        try { hls.destroy(); } catch {}
        hls = null;
        if (!dead && currentEp === src.num) useFallback(src, autoplay);
      }
    });
    hls.loadSource(src.videoUrl);
    hls.attachMedia(video);
    if (autoplay) play();
  }

  function useFallback(src, autoplay) {
    if (!src.fallbackUrl) { showError(); return; }
    video.removeAttribute('src');
    video.querySelectorAll('source').forEach((s) => s.remove());
    appendSources(src.fallbackUrl);
    video.load();
    setSpinner(true);
    if (autoplay) play();
    updateStageUi();
  }

  function updateNext() {
    const hasNext = eps.some((e) => e.num === currentEp + 1);
    nextBtn.disabled = !hasNext;
    nextBtn.classList.toggle('opacity-50', !hasNext);
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

  // Plain ended state: manual controls, no countdown (after Stay, or the
  // last episode).
  function endedIdle() {
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
      updateStageUi();
      play();
    });
    endedActions.appendChild(again);
  }

  function onEnded() {
    cancelCountdown();
    hideError();
    saveNow();
    updateStageUi();
    endedTitle.textContent = t('player.ended');
    endedBox.classList.remove('hidden');
    endedBox.classList.add('flex');
    endedActions.innerHTML = '';
    const hasNext = eps.some((e) => e.num === currentEp + 1);
    if (hasNext) {
      // Autoplay countdown: ticks every second, and any tap, scrub or back
      // cancels it into the plain ended state.
      let s = 5;
      const cdown = el('<p class="text-body text-white/90" data-countdown></p>');
      const nowBtn = el('<button type="button" class="btn-primary"></button>');
      const stayBtn = el('<button type="button" class="btn-secondary"></button>');
      const renderTick = () => {
        cdown.textContent = t('player.nextIn', { s: s });
        nowBtn.textContent = t('player.playNow', { n: currentEp + 1 });
      };
      renderTick();
      nowBtn.addEventListener('click', () => {
        cancelCountdown();
        switchEp(currentEp + 1, { autoplay: true });
      });
      stayBtn.addEventListener('click', () => {
        cancelCountdown();
        endedIdle();
      });
      countdownTimer = setInterval(() => {
        s -= 1;
        if (s <= 0) {
          cancelCountdown();
          switchEp(currentEp + 1, { autoplay: true });
          return;
        }
        renderTick();
      }, 1000);
      endedActions.appendChild(cdown);
      const row = el('<div class="flex flex-wrap justify-center gap-2"></div>');
      row.appendChild(nowBtn);
      row.appendChild(stayBtn);
      endedActions.appendChild(row);
    } else {
      endedIdle();
    }
  }

  function switchEp(n, { autoplay = false } = {}) {
    saveNow();
    loadEp(n, { autoplay });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  loadEp(currentEp);

  video.addEventListener('loadedmetadata', () => {
    if (!resuming) return;
    resuming = false;
    if (!video.duration || !isFinite(video.duration)) return;
    // Resume only into the last ten seconds' worth of margin: a stored
    // position at (or past) the end of the real clip restarts the episode.
    const gap = video.duration - progress.seconds;
    if (gap < 10) return;
    const at = Math.min(progress.seconds, Math.max(0, video.duration - 10));
    if (at > 0) {
      video.currentTime = at;
      toast(t('player.resumeFrom', { t: timeFmt(at) }));
    }
  });
  video.addEventListener('play', () => {
    // Playback started: any countdown is over and the ended overlay goes.
    cancelCountdown();
    endedBox.classList.add('hidden');
    endedBox.classList.remove('flex');
    updateStageUi();
  });
  video.addEventListener('pause', () => { updateStageUi(); saveNow(); });
  video.addEventListener('ended', onEnded);
  video.addEventListener('waiting', () => { if (video.readyState < 3) setSpinner(true); });
  video.addEventListener('stalled', () => { if (video.readyState < 3) setSpinner(true); });
  video.addEventListener('playing', () => setSpinner(false));
  video.addEventListener('canplay', () => setSpinner(false));
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
  // Direct-src failures (native HLS): the video element reports its own.
  video.addEventListener('error', () => showError());

  // Volume: mute toggle always available, slider on fine-pointer devices.
  function updateMuteUi() {
    const silenced = video.muted || video.volume === 0;
    muteBtn.innerHTML = icon(silenced ? 'volumeX' : 'volume');
    muteBtn.setAttribute('aria-label', silenced ? t('player.unmute') : t('player.mute'));
    if (volSlider) volSlider.value = String(Math.round(video.volume * 100));
    try {
      localStorage.setItem('hc:volume', JSON.stringify({ volume: video.volume, muted: video.muted }));
    } catch {}
  }
  video.addEventListener('volumechange', updateMuteUi);
  muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
  if (volSlider) {
    volSlider.addEventListener('input', () => {
      const v = Number(volSlider.value) / 100;
      video.volume = v;
      if (v > 0 && video.muted) video.muted = false;
    });
  }
  updateMuteUi();

  playBtn.addEventListener('click', () => { video.paused ? play() : video.pause(); });
  bigPlay.addEventListener('click', () => { play(); });
  stage.addEventListener('click', (e) => {
    // Tapping the video itself toggles playback (buttons handle their own);
    // with the ended overlay up, that same tap cancels the countdown and
    // replays the episode.
    if (e.target === video) { video.paused ? play() : video.pause(); }
  });
  endedBox.addEventListener('click', (e) => {
    if (e.target !== endedBox) return;
    cancelCountdown();
    endedIdle();
  });

  seek.addEventListener('input', () => {
    cancelCountdown();
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
        applySubMode();
        menu.close();
      });
      menu.appendChild(item);
    }
    const sheet = openSheet(menu, { label: t('player.subtitles') });
    menu.close = sheet.close;
  });

  // Episode switcher: locked rows still open, the player decides (paywall).
  epsBtn.addEventListener('click', () => {
    const menu = el('<div role="menu" aria-label="' + t('player.episodes') + '"><p class="section-label">' + t('detail.episodes') + '</p></div>');
    for (const e of eps) {
      const active = e.num === currentEp;
      const item = el(
        '<button type="button" role="menuitemradio" aria-checked="' + active + '" class="list-row w-full ' +
        (active ? 'text-accent' : 'text-fg') + '">' +
        '<span class="flex-1 text-left">' + t('detail.episode', { n: e.num }) + '</span>' +
        (e.access === 'vip' ? '<span class="chip chip-vip">' + icon('lock', 'h-3.5 w-3.5') + 'VIP</span>' : '') +
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
    cancelCountdown();
    saveNow();
    navigate('/drama/' + d.id + demoQ);
  });
  stage.querySelector('[data-paywall-back]').addEventListener('click', () => {
    navigate('/drama/' + d.id + demoQ);
  });
  stage.querySelector('[data-unavail-back]').addEventListener('click', () => {
    navigate('/drama/' + d.id + demoQ);
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
    cancelCountdown();
    saveNow();
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('fullscreenchange', onFsChange);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
}

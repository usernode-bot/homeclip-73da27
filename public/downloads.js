/* The downloads view and the download itself: VIP members save an
 * episode's video (and its subtitles) in the browser's IndexedDB and can
 * watch it with no connection. Nothing is stored server-side and no video
 * bytes ever reach the app's database; only the episode's own URLs already
 * in the server do.
 *
 * app.js loads this module only when the Downloads view opens (or the
 * player's Download button is tapped); watch.js calls HCDownloads.lookup
 * for offline playback, and HCDownloads.start from the player's button.
 */
(function () {
  'use strict';

  var HC = window.HC;
  var i18n = window.i18n;
  var $ = function (id) { return document.getElementById(id); };
  var esc = HC.esc;

  // In-flight downloads, by episode id: { pct, received, total, error, ac }.
  var active = {};
  // Whether the persistent-storage prompt has been asked once.
  var askedPersist = false;

  window.HCDownloads = {
    show: show,
    start: start,
    lookup: lookup,
  };

  // ── IndexedDB: two stores, meta rows and file blobs ─────────────────────

  function dbName() { return 'hc-downloads:' + (HC.viewerId() || 'anon'); }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(dbName(), 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'episodeId' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'episodeId' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var out = fn(s);
        t.oncomplete = function () { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }

  function getAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rows = [];
        var t = db.transaction('meta');
        var req = t.objectStore('meta').openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (c) { rows.push(c.value); c.continue(); }
        };
        t.oncomplete = function () { db.close(); resolve(rows); };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }

  function putMeta(meta) { return tx('meta', 'readwrite', function (s) { s.put(meta); }); }
  function putFile(episodeId, files) {
    return tx('files', 'readwrite', function (s) { s.put(Object.assign({ episodeId: episodeId }, files)); });
  }
  function delBoth(episodeId) {
    return tx('meta', 'readwrite', function (s) { s.delete(episodeId); })
      .then(function () { return tx('files', 'readwrite', function (s) { s.delete(episodeId); }); });
  }

  // watch.js asks for a downloaded episode to play offline: object URLs for
  // its video blob and its subtitle text, or null when it is not here.
  function lookup(episodeId) {
    episodeId = Number(episodeId);
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = {};
        var t = db.transaction(['meta', 'files']);
        t.objectStore('meta').get(episodeId).onsuccess = function (e) { out.meta = e.target.result; };
        t.objectStore('files').get(episodeId).onsuccess = function (e) { out.files = e.target.result; };
        t.oncomplete = function () {
          db.close();
          if (!out.meta || !out.files || !out.files.video) { resolve(null); return; }
          resolve({
            meta: out.meta,
            videoUrl: URL.createObjectURL(out.files.video),
            subtitleText: out.files.subtitle || null,
            subtitleUrl: out.files.subtitle
              ? URL.createObjectURL(new Blob([out.files.subtitle], { type: 'text/vtt' }))
              : null,
          });
        };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }

  // ── The view ────────────────────────────────────────────────────────────

  function show() {
    $('dl-body').hidden = true;
    $('dl-state').hidden = false;
    $('dl-state').innerHTML =
      '<div class="skeleton" style="height:12px;width:40%;margin-bottom:12px"></div>' +
      '<ul class="list"><li class="list-row"><div class="skeleton" style="width:48px;height:68px;border-radius:6px;flex:none"></div>' +
      '<div class="grow" style="display:flex;flex-direction:column;gap:6px"><div class="skeleton" style="height:12px;width:55%"></div><div class="skeleton" style="height:12px;width:35%"></div></div></li></ul>';

    var viewer = HC.viewer();
    if (viewer.guest || !viewer.id) {
      $('dl-state').hidden = true;
      $('dl-body').hidden = true;
      renderGuestState();
      return;
    }

    getAll().then(function (rows) {
      $('dl-state').hidden = true;
      $('dl-body').hidden = false;
      renderList(rows, viewer);
    }).catch(function () {
      $('dl-state').hidden = false;
      $('dl-state').innerHTML =
        '<div class="state-error"><div class="text-body font-semibold">' + esc(i18n.t('dl_error_title')) + '</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('state_error_body')) + '</p>' +
        '<button id="retry-dl" class="btn-secondary">' + esc(i18n.t('retry')) + '</button></div>';
      $('retry-dl').addEventListener('click', show);
    });
  }

  function renderGuestState() {
    $('dl-state').hidden = false;
    $('dl-state').innerHTML =
      '<div class="state-empty"><div class="text-heading">' + esc(i18n.t('downloads_vip_title')) + '</div>' +
      '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('account_needed_title')) + '</p>' +
      '<button id="dl-account" class="btn-primary">' + esc(i18n.t('account_needed_title')) + '</button></div>';
    $('dl-account').addEventListener('click', function () {
      try { window.usernode.askForAccount({ action: i18n.t('downloads').toLowerCase() }); } catch (e) {}
    });
  }

  function renderList(rows, viewer) {
    var list = $('dl-list');
    var total = $('dl-total');
    var sizeSum = rows.reduce(function (a, r) { return a + (r.sizeBytes || 0); }, 0);

    var upsell = '';
    if (!viewer.vip) {
      upsell = '<li class="dl-upsell"><div class="text-body font-semibold">' + esc(i18n.t('downloads_vip_title')) + '</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('downloads_vip_body')) + '</p>' +
        '<button id="become-vip" class="btn-primary">' + esc(i18n.t('become_vip')) + '</button>' +
        '<p id="vip-note" class="sm muted" style="margin-top:8px" hidden>' + esc(i18n.t('payments_note')) + '</p></li>';
    }

    // Anything downloading now renders as its own row, with its progress.
    var inflight = Object.keys(active).map(function (id) { return Number(id); });
    var doneIds = new Set(rows.map(function (r) { return Number(r.episodeId); }));

    list.innerHTML = upsell + rows.map(function (r) { return rowHtml(r); }).join('') +
      inflight.filter(function (id) { return !doneIds.has(id); }).map(function (id) { return progressRowHtml(id); }).join('');

    if (!rows.length && !inflight.length && viewer.vip) {
      $('dl-body').hidden = true;
      $('dl-state').hidden = false;
      $('dl-state').innerHTML =
        '<div class="state-empty"><div class="text-heading">' + esc(i18n.t('no_downloads_title')) + '</div>' +
        '<p class="text-small" style="color:rgb(var(--muted))">' + esc(i18n.t('no_downloads_body')) + '</p></div>';
      total.textContent = '';
      return;
    }
    $('dl-body').hidden = false;
    $('dl-state').hidden = true;
    total.textContent = sizeSum ? i18n.t('saved_on_device', { size: fmtBytes(sizeSum) }) : '';

    var vip = $('become-vip');
    if (vip) {
      vip.addEventListener('click', function () {
        HC.track('subscription_intent', { screen: 'downloads' });
        $('vip-note').hidden = false;
      });
    }
    Array.prototype.forEach.call(list.querySelectorAll('[data-dl-play]'), function (b) {
      b.addEventListener('click', function () {
        location.hash = '#/watch/' + b.getAttribute('data-dl-play');
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-dl-del]'), function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-dl-del'));
        delBoth(id).then(function () {
          HC.track('download_deleted', { episode_id: id });
          show();
        });
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-dl-cancel]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-dl-cancel');
        if (active[id] && active[id].ac) active[id].ac.abort();
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-dl-retry]'), function (b) {
      b.addEventListener('click', function () {
        var job = active[b.getAttribute('data-dl-retry')];
        if (job && job.episode) beginDownload(job.episode, job.drama);
      });
    });
  }

  function rowHtml(r) {
    var meta = i18n.t('episode_full', { s: r.season, n: r.number, title: r.title });
    var sub = (r.drama && r.drama.title ? esc(r.drama.title) + ' · ' : '') + fmtBytes(r.sizeBytes);
    return '<li class="list-row"><div class="dl-tile"><svg viewBox="0 0 24 24"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 20h14"/></svg></div>' +
      '<div class="grow"><div style="font-weight:600">' + esc(r.title) + '</div>' +
      '<div class="sm muted">' + esc(meta) + '</div>' +
      '<div class="sm muted">' + sub + '</div></div>' +
      '<button class="btn-secondary" data-dl-play="' + r.episodeId + '">' + esc(i18n.t('watch')) + '</button>' +
      '<button class="icon-btn" data-dl-del="' + r.episodeId + '" aria-label="' + esc(i18n.t('delete')) + '"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button></li>';
  }

  function progressRowHtml(id) {
    var job = active[id];
    var pct = job.total ? Math.round((job.received / job.total) * 100) : null;
    var line = pct !== null
      ? i18n.t('size_of', { pct: pct, size: fmtBytes(job.total) })
      : fmtBytes(job.received);
    var inner;
    if (job.error) {
      inner = '<div class="grow"><div style="font-weight:600">' + esc(i18n.t('dl_error_title')) + '</div>' +
        '<div class="sm muted">' + esc(i18n.t('dl_error_body')) + '</div></div>' +
        '<button class="btn-secondary" data-dl-retry="' + id + '">' + esc(i18n.t('retry')) + '</button>' +
        '<button class="icon-btn" data-dl-cancel="' + id + '" aria-label="' + esc(i18n.t('cancel')) + '"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    } else {
      inner = '<div class="grow"><div style="font-weight:600">' + esc(job.episode.title) + '</div>' +
        '<div class="bar" style="margin-top:6px"><i style="width:' + (pct !== null ? pct : 4) + '%"></i></div>' +
        '<div class="sm muted">' + esc(line) + '</div></div>' +
        '<button class="btn-secondary" data-dl-cancel="' + id + '">' + esc(i18n.t('cancel')) + '</button>';
    }
    return '<li class="list-row"><div class="dl-tile"><svg viewBox="0 0 24 24"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 20h14"/></svg></div>' + inner + '</li>';
  }

  // ── Starting a download (the player's Download button) ──────────────────

  function start(episode, drama) {
    var viewer = HC.viewer();
    if (viewer.guest || !viewer.id) {
      try { window.usernode.askForAccount({ action: i18n.t('download').toLowerCase() }); } catch (e) {}
      return;
    }
    if (!viewer.vip) {
      // Non-VIP: the Downloads view shows the upsell with the note about
      // payments; from the player, send them there.
      location.hash = '#/downloads';
      return;
    }
    beginDownload(episode, drama);
    // The progress row lives in the Downloads view; going there is the
    // tap's answer, the same way the non-VIP path answers.
    location.hash = '#/downloads';
  }

  function beginDownload(episode, drama) {
    var id = Number(episode.id);
    if (active[id] && !active[id].error) return;
    HC.track('download_started', { episode_id: id });
    askPersistentStorageOnce();
    var ac = new AbortController();
    active[id] = { pct: 0, received: 0, total: 0, ac: ac, episode: episode, drama: drama };
    show();

    var videoP = fetchBlob(episode.media_url, ac.signal, function (received, total) {
      var job = active[id];
      if (!job) return;
      job.received = received;
      job.total = total;
      renderProgressRow(id);
    });
    var subP = episode.subtitle_url
      ? fetchText(episode.subtitle_url, ac.signal).catch(function () { return null; })
      : Promise.resolve(null);

    Promise.all([videoP, subP]).then(function (results) {
      var blob = results[0];
      var sub = results[1];
      var meta = {
        episodeId: id,
        season: episode.season,
        number: episode.number,
        title: episode.title,
        minutes: episode.minutes || null,
        media_url: episode.media_url,
        subtitle_url: episode.subtitle_url || null,
        drama: drama ? { id: drama.id, title: drama.title } : null,
        sizeBytes: blob.size,
        savedAt: Date.now(),
      };
      return putFile(id, { video: blob, subtitle: sub }).then(function () {
        return putMeta(meta);
      }).then(function () {
        delete active[id];
        HC.track('download_completed', { episode_id: id, size: blob.size });
        show();
      });
    }).catch(function (err) {
      var job = active[id];
      if (!job) return; // cancelled
      if (err && err.name === 'AbortError') {
        delete active[id];
        show();
        return;
      }
      job.error = true;
      renderProgressRow(id);
    });
  }

  function renderProgressRow(id) {
    // Only the downloading row updates in place; the rest of the list is
    // redrawn when the download settles.
    var cancelBtn = document.querySelector('[data-dl-cancel="' + id + '"]');
    if (!cancelBtn) return;
    var rowEl = cancelBtn.closest('li');
    if (!rowEl) return;
    var tmp = document.createElement('ul');
    tmp.innerHTML = progressRowHtml(id);
    rowEl.replaceWith(tmp.firstElementChild);
    // Rebind just this row's buttons.
    var freshCancel = document.querySelector('[data-dl-cancel="' + id + '"]');
    if (freshCancel) {
      freshCancel.addEventListener('click', function () {
        if (active[id] && active[id].ac) active[id].ac.abort();
      });
    }
    var retryBtn = document.querySelector('[data-dl-retry="' + id + '"]');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        var job = active[id];
        if (job && job.episode) beginDownload(job.episode, job.drama);
      });
    }
  }

  function askPersistentStorageOnce() {
    if (askedPersist) return;
    askedPersist = true;
    if (navigator.storage && navigator.storage.persist && !navigator.storage.persisted) {
      try {
        navigator.storage.persist().catch(function () {});
      } catch (e) {}
    }
  }

  // ── Fetching ────────────────────────────────────────────────────────────

  function fetchBlob(url, signal, onProgress) {
    return fetch(url, { signal: signal }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var total = Number(res.headers.get('content-length')) || 0;
      if (!res.body || !res.body.getReader) {
        return res.blob().then(function (b) { onProgress(b.size, b.size); return b; });
      }
      var reader = res.body.getReader();
      var chunks = [];
      var received = 0;
      function step() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value);
          received += r.value.length;
          onProgress(received, total);
          return step();
        });
      }
      return step().then(function () { return new Blob(chunks); });
    });
  }

  function fetchText(url, signal) {
    return fetch(url, { signal: signal }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
  }

  function fmtBytes(n) {
    if (!n || n < 1) return '0 MB';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
})();

// HC boot. Order matters:
//   1. Resolve identity (HC.api.boot) — this is the "protected route" gate:
//      nothing renders until we know who is watching, from the network or
//      from the identity remembered on this device. An offline boot has no
//      token, so the remembered identity is what keeps the app on the same
//      person's data.
//   2. Replay writes queued while offline (in order, oldest first).
//   3. Start the router, which draws the first screen.
// Header chip and offline banner follow identity and connectivity from
// here on.

(function () {
  const api = HC.api;

  const banner = document.createElement('div');
  banner.className = 'mx-auto w-full max-w-2xl px-4 pt-2';
  banner.hidden = true;
  banner.innerHTML = '<p class="rounded-lg border border-line bg-raised px-3 py-2 text-small text-muted" data-banner-text></p>';
  document.querySelector('header').after(banner);

  function setBanner() {
    const st = api.state;
    const queued = api.state.account
      ? HC.store.pending(st.account.id + ':' + (st.activeProfileId || '-')).length
      : 0;
    let text = '';
    if (st.offline || !navigator.onLine) {
      text = 'You are offline. Reading saved pages; changes you make are kept on this device and sent later.';
    } else if (queued > 0) {
      text = 'Sending ' + queued + ' saved change' + (queued > 1 ? 's' : '') + '…';
    }
    banner.hidden = !text;
    if (text) banner.querySelector('[data-banner-text]').textContent = text;
  }

  api.on('me', function () {
    HC.router.updateChip();
    setBanner();
  });
  api.on('profile', function () {
    HC.router.updateChip();
    setBanner();
  });
  api.on('queued', setBanner);
  api.on('synced', function () { setBanner(); HC.screens.toast('Saved changes are now synced.'); });
  api.on('guest-blocked', function () { /* the bridge shows the account sheet; nothing to add */ });

  window.addEventListener('online', function () {
    api.state.offline = false;
    setBanner();
    api.flush().then(setBanner).catch(function () { setBanner(); });
  });
  window.addEventListener('offline', function () {
    api.state.offline = true;
    setBanner();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      // Back in the frame: refresh the chip (the profile may have been
      // edited elsewhere) and push anything still queued.
      api.flush().then(setBanner).catch(function () {});
    }
  });

  api.boot().then(function () {
    setBanner();
    return api.flush();
  }).then(function () {
    setBanner();
    HC.router.start();
  }).catch(function (err) {
    console.error('boot failed', err);
    // Boot never rejects today, but if it ever does, still render: the
    // screens each carry their own error states.
    HC.router.start();
  });
})();

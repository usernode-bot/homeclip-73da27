// HC.api — identity and profile context, the fetch wrapper, and the offline
// write path.
//
// Identity comes from the platform: the shell injects ?token= on the first
// iframe load; the app forwards it as x-usernode-token afterwards (the
// platform's edge also adds it to same-origin requests at the app's own
// address). The token and the last-known identity are remembered in
// localStorage so an offline boot — which carries no token — still knows who
// was signed in and keeps their cache and queued writes intact.
//
// "Protected routes" here means: the app renders nothing until it knows who
// is signed in (from the network, or from the remembered identity when
// offline). Guests (no Homeroom account) may browse; every write they make
// is answered 401 account_required, which the bridge turns into the
// platform's make-an-account sheet.

window.HC = window.HC || {};

HC.api = (function () {
  const S = HC.store;
  const listeners = {};

  const state = {
    booted: false,
    guest: true,        // true until /api/me proves an account (offline: remembered identity wins)
    account: null,      // { id, username, locale }
    profiles: [],       // the account's profiles
    activeProfileId: null,
    offline: false,     // last known connectivity
    degraded: !HC.store.durable, // storage refused: caching and queueing unavailable
  };

  function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  function emit(name) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  // ── Token ────────────────────────────────────────────────────────────────
  let token = null;
  try { token = new URLSearchParams(location.search).get('token'); } catch (e) {}
  if (token) {
    try { localStorage.setItem('hc:token', token); } catch (e) {}
    // Take it out of the address bar: fetches carry it in a header, and the
    // URL is the one thing a user might copy and paste.
    try {
      const url = new URL(location.href);
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {}
  } else {
    try { token = localStorage.getItem('hc:token'); } catch (e) {}
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  function raw(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-usernode-token'] = token;
    if (state.activeProfileId) headers['x-homeclip-profile'] = String(state.activeProfileId);
    return fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function rawJson(method, path, body) {
    let res;
    try {
      res = await raw(method, path, body);
    } catch (e) {
      state.offline = true;
      const err = new Error('network'); err.offline = true; throw err;
    }
    state.offline = false;
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('http_' + res.status));
      err.status = res.status;
      err.code = data && data.error;
      if (res.status === 401 && err.code === 'account_required') err.guestWrite = true;
      throw err;
    }
    return data;
  }

  // ── Cache namespacing ────────────────────────────────────────────────────
  function ns() {
    return (state.account ? state.account.id : 'anon') + ':' + (state.activeProfileId || '-');
  }
  function cacheKey(key) { return ns() + ':' + key; }
  function cacheGet(key) { return S.cacheGet(ns(), key); }
  function cachePut(key, data) { S.cachePut(ns(), key, data); }
  function cacheDrop(key) { S.cacheDrop(ns(), key); }

  // GET with stale-while-revalidate semantics: callers render the cached
  // value first (if any) and re-render when the network answers.
  async function fresh(key, path) {
    const data = await rawJson('GET', path);
    cachePut(key, data);
    return data;
  }

  // ── Identity boot ────────────────────────────────────────────────────────
  function pickActive() {
    if (!state.profiles.length) return null;
    let wanted = null;
    try { wanted = localStorage.getItem('hc:ap:' + state.account.id); } catch (e) {}
    if (wanted) {
      const found = state.profiles.find(function (p) { return String(p.id) === String(wanted); });
      if (found) return found.id;
    }
    return state.profiles[0].id;
  }

  async function boot() {
    // Trust the remembered identity immediately, then refresh in the
    // background: an offline boot has no token, and the app must still open
    // on the same person's data.
    const remembered = S.readJSON('hc:me');
    if (remembered && remembered.account) {
      state.guest = false;
      state.account = remembered.account;
      state.profiles = remembered.profiles || [];
      state.activeProfileId = pickActive();
    }
    try {
      const me = await rawJson('GET', '/api/me');
      if (me.guest) {
        state.guest = true;
        state.account = null;
        state.profiles = [];
        state.activeProfileId = null;
      } else {
        state.guest = false;
        state.account = me.account;
        state.profiles = me.profiles;
        S.writeJSON('hc:me', me);
        state.activeProfileId = pickActive();
      }
    } catch (err) {
      if (err.offline) state.offline = true;
      // A stale token (offline or the platform re-keyed): keep the
      // remembered identity and keep working from cache.
      if (!state.account) state.guest = true;
    }
    state.booted = true;
    emit('me');
  }

  function setActiveProfile(id) {
    state.activeProfileId = id;
    try { localStorage.setItem('hc:ap:' + state.account.id, String(id)); } catch (e) {}
    // Different profile, different viewer state: drop this account's cached
    // reads and let screens re-render.
    if (state.account) S.cacheClearPrefix(state.account.id + ':');
    emit('profile');
  }

  function profile() {
    return state.profiles.find(function (p) { return p.id === state.activeProfileId; }) || null;
  }
  function hasProfile() { return !state.guest && Boolean(state.activeProfileId); }

  // ── Writes, with the offline queue ───────────────────────────────────────
  // A write that cannot reach the network is queued durably and replayed in
  // order when the connection returns. The caller gets { queued: true } so
  // the UI can say "Saved on this device — will sync" instead of pretending
  // the server has it.
  async function mutate(method, path, body, opts) {
    opts = opts || {};
    if (state.guest || !state.activeProfileId) {
      // Guests cannot write. Try anyway so the platform's edge answers with
      // its own account_required and the bridge offers the account sheet.
      try { return await rawJson(method, path, body); } catch (err) {
        if (err.guestWrite) { emit('guest-blocked'); }
        throw err;
      }
    }
    if (state.offline || !navigator.onLine) {
      return queueWrite(method, path, body, opts);
    }
    try {
      const out = await rawJson(method, path, body);
      flush(); // anything queued earlier can go now
      return out;
    } catch (err) {
      if (err.offline) return queueWrite(method, path, body, opts);
      if (err.status === 403 && err.code === 'unknown_profile') {
        // The active profile disappeared (deleted elsewhere): fall back to
        // the account's first profile and try once more.
        state.activeProfileId = state.profiles.length ? state.profiles[0].id : null;
        emit('profile');
        if (state.activeProfileId) return mutate(method, path, body, opts);
      }
      throw err;
    }
  }

  function queueWrite(method, path, body, opts) {
    const nsKey = ns();
    const queued = S.enqueue(nsKey, {
      path: path, method: method, body: body, dedupe: opts.dedupe,
    });
    emit('queued');
    return { queued: queued, degraded: !queued };
  }

  async function flush() {
    if (state.guest) return;
    const nsKey = ns();
    const list = S.pending(nsKey);
    if (!list.length) return;
    let stop = list.length; // index of the first op that must stay queued
    for (let i = 0; i < list.length; i++) {
      const op = list[i];
      try {
        await rawJson(op.method, op.path, op.body);
      } catch (err) {
        if (err.offline) { stop = i; break; } // unreachable: stop, keep order
        // A real rejection (4xx): drop the op — replaying cannot fix it.
        console.warn('queued write rejected, dropped: ' + op.method + ' ' + op.path);
      }
    }
    // Everything before `stop` was either sent or deliberately dropped; the
    // tail from `stop` on stays queued, in order.
    S.setPending(nsKey, list.slice(stop));
    if (stop === 0) emit('synced');
  }

  return {
    state: state,
    on: on,
    emit: emit,
    boot: boot,
    profile: profile,
    hasProfile: hasProfile,
    setActiveProfile: setActiveProfile,
    fresh: fresh,
    cacheGet: cacheGet,
    cachePut: cachePut,
    cacheDrop: cacheDrop,
    cacheClearPrefix: function () { if (state.account) S.cacheClearPrefix(state.account.id + ':'); },
    rawJson: rawJson,
    mutate: mutate,
    flush: flush,
  };
})();

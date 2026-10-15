// HC.store — the app's data store: a localStorage-backed cache (the vanilla
// equivalent of React Query's query cache) and a durable queue for writes
// made while offline.
//
// Cache keys are namespaced hc:cache:<accountId>:<profileId>:<key> so two
// profiles on one account — or two accounts on one device — never share
// cached viewer state. The namespace is NEVER cleared when the platform
// token is absent (an offline boot has no token): the remembered identity is
// what keys the cache, and destroying it would delete the user's data (see
// "Offline — apps that open with no connection" in the platform
// conventions).
//
// If the device refuses durable storage (some WebViews do), the store
// degrades to an in-memory Map for the session and says so — the UI shows
// "won't be saved" instead of promising a sync that cannot happen.

window.HC = window.HC || {};

HC.store = (function () {
  let durable = true;
  try {
    localStorage.setItem('hc:probe', '1');
    localStorage.removeItem('hc:probe');
  } catch (e) {
    durable = false;
  }
  const mem = new Map(); // session fallback when localStorage is refused

  function readJSON(key) {
    if (!durable) return mem.get(key) || null;
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return mem.get(key) || null;
    }
  }

  function writeJSON(key, value) {
    if (!durable) { mem.set(key, value); return; }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      mem.set(key, value);
    }
  }

  function remove(key) {
    mem.delete(key);
    try { localStorage.removeItem(key); } catch (e) {}
  }

  // ── Read cache ───────────────────────────────────────────────────────────
  function cacheKey(ns, key) { return 'hc:cache:' + ns + ':' + key; }

  function cacheGet(ns, key) {
    const wrapped = readJSON(cacheKey(ns, key));
    return wrapped ? wrapped.data : null;
  }

  function cachePut(ns, key, data) {
    writeJSON(cacheKey(ns, key), { data: data, savedAt: Date.now() });
  }

  function cacheDrop(ns, key) { remove(cacheKey(ns, key)); }

  function cacheClearPrefix(nsPrefix) {
    const prefix = 'hc:cache:' + nsPrefix;
    if (durable) {
      try {
        const drop = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(prefix) === 0) drop.push(k);
        }
        drop.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
    }
    for (const k of Array.from(mem.keys())) {
      if (k.indexOf(prefix) === 0) mem.delete(k);
    }
  }

  // ── Offline write queue ──────────────────────────────────────────────────
  // Ops: { path, method, body, dedupe?, at }. `dedupe` merges repeat ops of
  // the same thing (a resume position updated five times offline replays
  // once, with the last body). Every Phase 2 write endpoint is an idempotent
  // upsert, so replaying in order is always safe.
  function queueKey(ns) { return 'hc:queue:' + ns; }

  function enqueue(ns, op) {
    if (!durable) return false; // caller says "won't be saved" honestly
    const list = readJSON(queueKey(ns)) || [];
    const sig = op.dedupe || (op.method + ' ' + op.path);
    const kept = list.filter(function (o) {
      return (o.dedupe || (o.method + ' ' + o.path)) !== sig;
    });
    op.at = Date.now();
    kept.push(op);
    writeJSON(queueKey(ns), kept);
    return true;
  }

  function pending(ns) {
    return readJSON(queueKey(ns)) || [];
  }

  function setPending(ns, list) {
    writeJSON(queueKey(ns), list);
  }

  return {
    durable: durable,
    readJSON: readJSON,
    writeJSON: writeJSON,
    remove: remove,
    cacheGet: cacheGet,
    cachePut: cachePut,
    cacheDrop: cacheDrop,
    cacheClearPrefix: cacheClearPrefix,
    enqueue: enqueue,
    pending: pending,
    setPending: setPending,
  };
})();

// HC.router — a small history-API router. All internal links carry
// data-nav and are intercepted here so navigation stays inside the iframe
// (a plain href reload would drop the whole app). Routes:
//
//   /                      Home
//   /dramas/:slug          Drama detail
//   /watch/:episodeId      Player (a protected route: nothing renders until
//                          HC.api.boot() has resolved who is watching)
//   /search                Search
//   /profiles              Who's watching?
//   /profiles/new          Add a profile
//   /profiles/:id/edit     Edit profile
//   /settings              Settings
//   /add                   Add a drama

window.HC = window.HC || {};

HC.router = (function () {
  const routes = [
    { pattern: /^\/$/, screen: 'home' },
    { pattern: /^\/dramas\/([^/]+)$/, screen: 'drama', params: ['slug'] },
    { pattern: /^\/watch\/(\d+)$/, screen: 'watch', params: ['id'] },
    { pattern: /^\/search$/, screen: 'search' },
    { pattern: /^\/profiles$/, screen: 'profiles' },
    { pattern: /^\/profiles\/new$/, screen: 'profileEdit', params: [] },
    { pattern: /^\/profiles\/(\d+)\/edit$/, screen: 'profileEdit', params: ['id'] },
    { pattern: /^\/settings$/, screen: 'settings' },
    { pattern: /^\/add$/, screen: 'add' },
  ];

  let view = null;
  let currentPath = null;
  let renderSeq = 0;

  function resolve(path) {
    const clean = path.replace(/\/+$/, '') || '/';
    for (const r of routes) {
      const m = clean.match(r.pattern);
      if (!m) continue;
      const params = {};
      (r.params || []).forEach(function (name, i) { params[name] = decodeURIComponent(m[i + 1]); });
      return { screen: r.screen, params: params };
    }
    return null;
  }

  function go(path, replace) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    render();
  }

  function render() {
    const path = location.pathname + location.search;
    if (path === currentPath) return;
    currentPath = path;
    const match = resolve(location.pathname) || { screen: 'home', params: {} };
    const seq = ++renderSeq;

    HC.player.teardown();
    view.scrollTop = 0;
    window.scrollTo(0, 0);

    try {
      HC.screens[match.screen](view, match.params);
    } catch (e) {
      console.error('screen failed: ' + match.screen, e);
      view.innerHTML = '<div class="state-error"><p class="text-body font-medium">Something went wrong drawing this screen.</p>' +
        '<button type="button" class="btn-secondary" data-reload>Reload</button></div>';
      view.querySelector('[data-reload]').addEventListener('click', function () { render(); });
    }
    updateChip();
    void seq; // screens replace themselves; the seq guards nothing async here
  }

  // The header chip: the active profile's avatar and name, updated on every
  // navigation and whenever identity or the active profile changes.
  function updateChip() {
    const chip = document.getElementById('profile-chip');
    if (!chip) return;
    const st = HC.api.state;
    const p = HC.api.profile();
    const avatarEl = chip.querySelector('[data-chip-avatar]');
    const nameEl = chip.querySelector('[data-chip-name]');
    if (st.guest || !p) {
      avatarEl.textContent = st.guest ? '?' : '+';
      nameEl.textContent = st.guest ? 'Guest' : 'Set up';
      return;
    }
    if (p.avatar_url) {
      avatarEl.innerHTML = '<img src="' + HC.screens.esc(p.avatar_url) + '" alt="" class="h-full w-full rounded-full object-cover">';
    } else {
      avatarEl.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
    }
    nameEl.textContent = p.name;
  }

  function start() {
    view = document.getElementById('view');
    if (!view) { console.error('router: no #view element'); return; }
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest('a[data-nav]');
      if (!a || a.target === '_blank') return;
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      e.preventDefault();
      go(href);
    });
    window.addEventListener('popstate', function () {
      currentPath = null; // back/forward always re-renders
      render();
    });
    render();
  }

  return {
    start: start,
    go: go,
    render: render,
    updateChip: updateChip,
  };
})();

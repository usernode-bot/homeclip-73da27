// HomeClip API wrapper. Forwards the iframe token (when the app was loaded
// with ?token=) and the preview "now" header; turns guest-write refusals
// into the bridge's "make an account" sheet.

// The shell injects ?token= on the initial iframe load; capture it once.
const params = new URLSearchParams(location.search);
let TOKEN = params.get('token') || null;
if (TOKEN) {
  try { sessionStorage.setItem('hc:token', TOKEN); } catch {}
} else {
  try { TOKEN = sessionStorage.getItem('hc:token'); } catch {}
}

export function getToken() {
  return TOKEN;
}

export function askForAccount(action) {
  try {
    if (window.usernode && window.usernode.askForAccount) {
      window.usernode.askForAccount(action ? { action } : {});
      return true;
    }
  } catch {}
  return false;
}

export async function api(path, opts = {}) {
  const headers = opts.headers ? { ...opts.headers } : {};
  if (TOKEN) headers['x-usernode-token'] = TOKEN;
  // A staging preview opened at a chosen moment tells the server which
  // "now" to use (see the platform's time-dependent-features rules).
  try {
    if (window.usernode && window.usernode.previewNow && window.usernode.now) {
      headers['x-usernode-now'] = window.usernode.now().toISOString();
    }
  } catch {}

  const init = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    const err = new Error('network');
    err.code = 'network';
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || 'http_' + res.status);
    err.code = data && data.error ? data.error : 'http_' + res.status;
    err.status = res.status;
    // Guests trying to write: the bridge turns account_required into the
    // sign-in sheet, so surface it rather than a generic failure.
    if (err.code === 'account_required') askForAccount(opts.action);
    throw err;
  }
  return data;
}

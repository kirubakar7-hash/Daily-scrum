const BASE = '/api';

function getToken() {
  return localStorage.getItem('dsm_token');
}

export function setToken(token) {
  if (token) localStorage.setItem('dsm_token', token);
  else localStorage.removeItem('dsm_token');
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // A 401 from /auth/login itself isn't a stale session to clear — there was no session yet — it's the
  // login attempt failing (wrong password, unknown/inactive account), and the real reason (from the JSON
  // body below) is exactly what the sign-in form needs to show, not the generic "session expired" text.
  if (res.status === 401 && path !== '/auth/login') {
    const hadToken = !!token;
    setToken(null);
    // ?expired=1 lets Login.jsx tell "your session ran out" apart from a fresh, first-time sign-in —
    // getting silently bounced to a blank login form with no explanation is confusing on its own.
    if (hadToken && window.location.pathname !== '/login') {
      window.location.href = '/login?expired=1';
    }
    throw new Error('Not logged in.');
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) throw new Error('Request failed.');
    return res;
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

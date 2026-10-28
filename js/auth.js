// ─────────────────────────────────────────────────────────────────────────────
// Sign-in and cloud sync (Supabase Auth + Postgres via REST, no SDK needed).
// Sign-up is invite-only: a Postgres "before user created" hook rejects emails
// that aren't in public.invited_emails. Progress lives in public.progress
// (one row per user per exam), protected by row-level security.
// ─────────────────────────────────────────────────────────────────────────────
export const SB_URL = 'https://rbywonfaduuhsnzxrmgr.supabase.co';
const SB_KEY = 'sb_publishable_SeSN5dU6RLpAYOc7o60CJA_ePJMgEOq'; // public by design; RLS protects data

// OAuth providers switched on in the Supabase dashboard (Authentication → Sign In / Providers).
// Email magic links always work.
export const PROVIDERS = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'azure', label: 'Continue with Microsoft', scopes: 'email' },
];

// Flip to true once the Supabase dashboard setup is done (hook, URLs, email).
export const AUTH_ENABLED = true;

const SESSION_KEY = 'examsim:session';
const DATA_PREFIX = 'examsim:';

let session = null;

const readSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };
const writeSession = (s) => {
  session = s;
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
};
const fromTokenResponse = (t) => ({
  access_token: t.access_token,
  refresh_token: t.refresh_token,
  expires_at: t.expires_at ? Number(t.expires_at) : Math.floor(Date.now() / 1000) + Number(t.expires_in || 3600),
  user: t.user ? { id: t.user.id, email: t.user.email } : null,
});

async function api(path, { method = 'GET', body, auth = true, headers = {}, keepalive = false } = {}) {
  const h = { apikey: SB_KEY, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth && session) h.Authorization = `Bearer ${session.access_token}`;
  const res = await fetch(SB_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), keepalive });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.msg || data?.message || data?.error_description || data?.error || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

// Tokens come back in the URL fragment after an OAuth or magic-link redirect.
function takeRedirect() {
  if (!location.hash || location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('access_token') && !p.has('error') && !p.has('error_description')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('error') || p.get('error_description')) {
    return { error: (p.get('error_description') || p.get('error')).replace(/\+/g, ' ') };
  }
  writeSession(fromTokenResponse(Object.fromEntries(p)));
  return { ok: true };
}

async function refresh() {
  const t = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: session.refresh_token } });
  writeSession(fromTokenResponse(t));
}

// Returns { signedIn, user, error }. Works offline with a previously saved session.
export async function initAuth() {
  session = readSession();
  const redirect = takeRedirect();
  if (redirect?.error) return { signedIn: !!session, user: session?.user, error: friendlyError(redirect.error) };
  if (!session) return { signedIn: false };
  try {
    if (!session.user) session.user = await api('/auth/v1/user').then((u) => ({ id: u.id, email: u.email }));
    if (session.expires_at - Date.now() / 1000 < 120) await refresh();
    writeSession(session);
  } catch (err) {
    // Expired/revoked session → sign in again. Network failure → keep working offline.
    if (err.status === 400 || err.status === 401 || err.status === 403) { writeSession(null); return { signedIn: false }; }
  }
  return { signedIn: !!session, user: session?.user };
}

async function ensureFresh() {
  if (session && session.expires_at - Date.now() / 1000 < 120) await refresh();
}

function friendlyError(msg = '') {
  if (/not been invited|not invited/i.test(msg)) return "That email hasn't been invited yet. Ask the site owner for an invite.";
  if (/signups not allowed|sign ?ups? .*disabled/i.test(msg)) return "That account hasn't been invited yet.";
  if (/rate limit|too many/i.test(msg)) return 'Too many sign-in emails were requested. Please wait a few minutes and try again.';
  if (/expired|invalid/i.test(msg)) return 'That sign-in link has expired or was already used. Request a new one.';
  return msg;
}

const redirectTarget = () => location.origin + location.pathname;

export function signInWith(provider) {
  const p = PROVIDERS.find((x) => x.id === provider);
  const q = new URLSearchParams({ provider, redirect_to: redirectTarget() });
  if (p?.scopes) q.set('scopes', p.scopes);
  location.assign(`${SB_URL}/auth/v1/authorize?${q}`);
}

export async function sendMagicLink(email) {
  try {
    await api(`/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTarget())}`, {
      method: 'POST', auth: false, body: { email: email.trim().toLowerCase(), create_user: true },
    });
  } catch (err) { throw new Error(friendlyError(err.message)); }
}

export async function signOut() {
  try { await ensureFresh(); await api('/auth/v1/logout', { method: 'POST' }); } catch { /* sign out locally anyway */ }
  writeSession(null);
  // Don't leave this person's progress on a shared device.
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(DATA_PREFIX) || k === 'az104-sim:v2').forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

export const currentUser = () => session?.user || null;

// ── Guest mode ───────────────────────────────────────────────────────────────
// Guests skip sign-in. Nothing is synced, and progress lives in sessionStorage,
// so it disappears when the tab closes and never mixes with an account's data.
const GUEST_KEY = 'examsim:guest';
export const isGuest = () => { try { return !session && sessionStorage.getItem(GUEST_KEY) === '1'; } catch { return false; } };
export function startGuest() { try { sessionStorage.setItem(GUEST_KEY, '1'); } catch { /* ignore */ } }
export function endGuest() {
  try { Object.keys(sessionStorage).filter((k) => k.startsWith(DATA_PREFIX)).forEach((k) => sessionStorage.removeItem(k)); } catch { /* ignore */ }
}

// ── Progress sync ────────────────────────────────────────────────────────────
// Each exam's state is one JSON document with an updatedAt timestamp; the newer copy wins.
export async function pullAll(readLocal, writeLocal, slugs) {
  if (!session) return;
  await ensureFresh();
  const rows = await api('/rest/v1/progress?select=exam,data');
  const remote = new Map(rows.map((r) => [r.exam, r.data]));
  const uploads = [];
  for (const slug of new Set([...slugs, ...remote.keys()])) {
    const local = readLocal(slug);
    const cloud = remote.get(slug);
    const lt = local?.updatedAt || 0, ct = cloud?.updatedAt || 0;
    if (cloud && (!local || ct > lt)) writeLocal(slug, cloud);
    else if (local && (!cloud || lt > ct)) uploads.push(push(slug, local));
  }
  await Promise.allSettled(uploads);
}

export async function push(slug, data, { keepalive = false } = {}) {
  if (!session) return;
  await ensureFresh();
  await api('/rest/v1/progress?on_conflict=user_id,exam', {
    method: 'POST', keepalive,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { exam: slug, data, updated_at: new Date(data.updatedAt || Date.now()).toISOString() },
  });
}

// ── Invites (admins only; RLS returns nothing to everyone else) ──────────────
export async function listInvites() {
  await ensureFresh();
  return api('/rest/v1/invited_emails?select=email,is_admin,note,added_at&order=added_at.asc');
}
export async function addInvite(email, note) {
  await ensureFresh();
  return api('/rest/v1/invited_emails', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: { email: email.trim().toLowerCase(), note: note || null },
  });
}
export async function removeInvite(email) {
  await ensureFresh();
  return api(`/rest/v1/invited_emails?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
}

// ── Question reports ─────────────────────────────────────────────────────────
// Anyone signed in can file a report; admins can list and resolve them (RLS).
export async function reportQuestion({ exam, questionId, reason, details, questionText }) {
  await ensureFresh();
  return api('/rest/v1/question_reports', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: {
      exam, question_id: questionId, reason,
      details: (details || '').slice(0, 2000) || null,
      question_text: (questionText || '').slice(0, 2000) || null,
    },
  });
}
export async function listOpenReports() {
  await ensureFresh();
  return api('/rest/v1/question_reports?select=id,exam,question_id,reason,details,reporter_email,created_at,user_id&status=eq.open&order=created_at.desc&limit=100');
}
export async function resolveReport(id) {
  await ensureFresh();
  return api(`/rest/v1/question_reports?id=eq.${Number(id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: { status: 'resolved', resolved_at: new Date().toISOString() },
  });
}

// ── Popularity (anonymous view counts for the home page "Most popular" folder) ──
// Rows hold only the exam slug and a timestamp; users can insert but not read them.
export async function recordView(exam) {
  if (!session) return;
  await ensureFresh();
  return api('/rest/v1/exam_views', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: { exam } });
}
export async function popularExams(days = 30, limit = 6) {
  await ensureFresh(); // guests call it with the public key only
  return api('/rest/v1/rpc/popular_exams', { method: 'POST', body: { days, max_rows: limit } });
}

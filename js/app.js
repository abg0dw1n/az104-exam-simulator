import * as Auth from './auth.js';
import * as Learn from './learn.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
// Everything exam-specific comes from exams/<slug>/exam.json, so adding a certification
// means adding a folder, not changing code.
let EXAM = null;                   // exam settings (exam.json)
let DOMAINS = {};
let QUESTIONS = [];                // exams/<slug>/questions.json
let BY_ID = new Map();
const storageKey = (slug) => `examsim:${slug}:v1`;
const examMinutes = (n) => Math.max(5, Math.round(n * (EXAM.minutesPerQuestion || 2)));
const passMark = () => EXAM.scoring.pass;
const scaleScore = (correct, total) =>
  Math.round(EXAM.scoring.min + (correct / total) * (EXAM.scoring.max - EXAM.scoring.min));
const LETTERS = 'ABCDEF';
const KEYS_LETTER = 'abcdef';
const KEYS_NUMBER = '123456';

// ─────────────────────────────────────────────────────────────────────────────
// State (persisted to localStorage so a refresh never loses progress)
// ─────────────────────────────────────────────────────────────────────────────
const defaultState = () => ({
  mode: 'practice',          // 'practice' | 'exam' | 'review' | 'learn'
  practice: {
    answers: {}, flagged: [], optionOrder: {}, index: 0,
    domain: 'ALL', status: 'all', shuffle: true,
    order: 'shuffled',       // 'shuffled' | 'ordered' | 'weak' (spaced repetition)
    list: null,              // frozen question order for the current practice round
    label: null,             // e.g. 'Retrying 12 missed questions'
  },
  exam: null,                // { order, optionOrder, answers, flagged, endsAt, index, result }
  review: null,              // { ids, index, source }
  history: [],               // [{ at, score, correct, total, passed }]
  examSize: null,
  seen: {},                  // id -> times served in an exam (to rotate through big banks)
  mastery: {},               // id -> { box, seen, wrong, last } for spaced repetition
});

let state = null;
let timerHandle = null;
let LEARN = null;           // learn.json for this exam, if it has training content

// Reads an exam's saved progress; legacyKey covers data saved before multi-exam support.
function readSaved(slug, legacyKey) {
  try {
    const raw = localStorage.getItem(storageKey(slug)) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function load() {
  try {
    const saved = readSaved(EXAM.slug, EXAM.legacyStorageKey);
    if (saved && saved.practice) {
      const d = defaultState();
      // Merge one level deep so settings added in newer versions get their defaults.
      return { ...d, ...saved, practice: { ...d.practice, ...saved.practice } };
    }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return defaultState();
}

const writeSaved = (slug, data) => {
  try { localStorage.setItem(storageKey(slug), JSON.stringify(data)); } catch { /* ignore quota/private mode */ }
};

let saveQueued = false;
function save() {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    state.updatedAt = Date.now();
    writeSaved(EXAM.slug, state);
    scheduleUpload();
  });
}

// Cloud sync: upload a few seconds after the last change, and when the page is hidden.
let uploadTimer = null;
function scheduleUpload() {
  if (!Auth.currentUser()) return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(flushUpload, 2500);
}
function flushUpload(opts) {
  if (!uploadTimer || !EXAM) return;
  clearTimeout(uploadTimer); uploadTimer = null;
  Auth.push(EXAM.slug, state, opts).catch(() => { /* offline: the next save or visit retries */ });
}
window.addEventListener('pagehide', () => flushUpload({ keepalive: true }));
document.addEventListener('visibilitychange', () => { if (document.hidden) flushUpload({ keepalive: true }); });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function optionOrderFor(store, q) {
  if (!store.optionOrder[q.id]) store.optionOrder[q.id] = shuffle(q.options.map((_, i) => i));
  return store.optionOrder[q.id];
}

const isCorrect = (q, answer) => answer === q.answer;

// ── Spaced repetition (Leitner boxes) ────────────────────────────────────────
// A correct answer moves a question up a box; a wrong one sends it back to box 0.
// Each box waits longer before the question is due again.
const BOX_DAYS = [0, 1, 3, 7, 16, 35];
const DAY = 24 * 60 * 60 * 1000;

function recordResult(id, correct, at = Date.now()) {
  const m = state.mastery[id] || { box: 0, seen: 0, wrong: 0, last: 0 };
  m.seen++;
  if (correct) m.box = Math.min(m.box + 1, BOX_DAYS.length - 1);
  else { m.box = 0; m.wrong++; }
  m.last = at;
  state.mastery[id] = m;
}

// 0 = missed last time, 1 = due for review, 2 = never seen, 3 = not due yet.
function weakPriority(id, now = Date.now()) {
  const m = state.mastery[id];
  if (!m) return 2;
  if (m.box === 0) return 0;
  return now >= m.last + BOX_DAYS[m.box] * DAY ? 1 : 3;
}

function weakOrder(ids) {
  const now = Date.now();
  const groups = [[], [], [], []];
  for (const id of shuffle(ids)) groups[weakPriority(id, now)].push(id);
  // Within "due", the most overdue first; within "not due", the soonest due first.
  const dueAt = (id) => state.mastery[id].last + BOX_DAYS[state.mastery[id].box] * DAY;
  groups[1].sort((a, b) => dueAt(a) - dueAt(b));
  groups[3].sort((a, b) => dueAt(a) - dueAt(b));
  return groups.flat();
}

const weakIds = (ids) => ids.filter((id) => weakPriority(id) <= 1);

// Seeds history from answers saved before spaced repetition existed.
function seedMastery() {
  if (Object.keys(state.mastery).length) re}y�-�G����ƭy�join('')}</ul>`
      : '<p class="muted small">No open reports. People you invite can report a question from its Report button.</p>'}`;
  container.appendChild(panel);
  panel.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await Auth.resolveReport(b.dataset.resolve); renderReports(container); toast('Marked as resolved.'); }
    catch (err) { b.disabled = false; toast(`Couldn't resolve: ${err.message}`); }
  }));
}

const escapeHtml = (t = '') => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Pull cloud progress before showing anything (bounded, so a slow network doesn't block practice).
async function syncFromCloud() {
  if (!Auth.currentUser()) return;
  let exams = [];
  try { exams = await fetchJson('/exams/index.json'); } catch { /* offline */ }
  const legacy = Object.fromEntries(exams.map((e) => [e.slug, e.legacyStorageKey]));
  const slugs = exams.map((e) => e.slug);
  const work = Auth.pullAll((slug) => readSaved(slug, legacy[slug]), writeSaved, slugs);
  await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
}

async function init() {
  if (Auth.AUTH_ENABLED) {
    const auth = await Auth.initAuth();
    renderAccount();
    if (!auth.signedIn) return renderSignIn(auth.error);
    if (auth.error) toast(auth.error);
    await syncFromCloud();
  }
  const slug = currentSlug();
  if (!slug) return renderHome();
  if (slug === 'account') return renderAccountPage();
  try {
    await loadBank(slug);
  } catch (err) {
    $('main').innerHTML = `<div class="panel empty"><p>Couldn't load the "${slug}" exam (${err.message}).</p>
      <a class="btn btn-primary" href="/">All exams</a></div>`;
    $('navigator').hidden = true;
    return;
  }
  document.title = `${EXAM.code} Exam Simulator`;
  document.body.dataset.vendor = vendorKey(EXAM.vendor);
  $('brand-title').textContent = `${EXAM.code} Exam Simulator`;
  $('brand-sub').textContent = `${EXAM.name} · ${QUESTIONS.length} questions`;
  LEARN = await Learn.loadLearn(slug);
  $('btn-mode-learn').hidden = !LEARN;
  $('mode-tabs').hidden = false;
  $('btn-drawer').hidden = false;
  $('domain-filter').innerHTML = `<option value="ALL">All domains (${QUESTIONS.length})</option>` +
    Object.entries(DOMAINS).map(([k, d], i) => {
      const n = QUESTIONS.filter((q) => q.domain === k).length;
      return `<option value="${k}">${i + 1}. ${d.name} (${n})</option>`;
    }).join('');
  syncFilterControls();

  for (const id of ['domain-filter', 'status-filter', 'order-filter']) $(id).addEventListener('change', applyPracticeFilters);
  $('btn-reset-practice').addEventListener('click', resetPractice);
  $('btn-reshuffle').addEventListener('click', reshufflePractice);
  $('practice-stats').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="retry-missed"]')) retryMissed();
    if (e.target.closest('[data-action="weak-round"]')) startWeakRound();
  });
  document.querySelector('.segmented').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('btn-drawer').addEventListener('click', () => {
    const nav = $('navigator');
    if (nav.hidden) return toast('The navigator is available while answering questions.');
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const visible = mobile ? nav.classList.toggle('open') : !nav.classList.toggle('collapsed');
    $('btn-drawer').setAttribute('aria-expanded', String(visible));
  });
  $('question-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-jump]');
    if (b) jump(Number(b.dataset.jump));
  });

  $('main').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-option]');
    if (opt && !opt.disabled) return choose(Number(opt.dataset.option));
    const size = e.target.closest('[data-size]');
    if (size) { state.examSize = Number(size.dataset.size); save(); return render(); }
    const act = e.target.closest('[data-action]');
    if (!act || act.disabled) return;
    switch (act.dataset.action) {
      case 'prev': return go(-1);
      case 'next': return go(1);
      case 'flag': return toggleFlag();
      case 'submit': return confirmSubmit();
      case 'start-exam': return startExam();
      case 'quit-exam': return quitExam();
      case 'new-exam': return newExamSetup();
      case 'review-missed': return startReview('missed');
      case 'review-all': return startReview('all');
      case 'back-to-results': state.mode = 'exam'; save(); return render();
      case 'retry-question': return retryQuestion();
      case 'report': return reportCurrentQuestion();
      case 'practice-domain': return practiceDomain(act.dataset.domain);
      case 'clear-filters':
        state.practice.domain = 'ALL'; state.practice.status = 'all';
        syncFilterControls(); buildPracticeList(); save(); return render();
    }
  });

  $('main').addEventListener('change', (e) => {
    if (e.target.id !== 'exam-size') return;
    const n = Math.round(Number(e.target.value));
    state.examSize = Number.isFinite(n) && n > 0 ? Math.min(n, QUESTIONS.length) : EXAM.defaultSize;
    save(); render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || $('modal').open) return;
    if (e.target.closest('select, input, textarea')) return;
    const quiz = document.querySelector('.qcard');
    if (!quiz) return;
    const key = e.key.toLowerCase();
    if (key === 'arrowright') { e.preventDefault(); go(1); }
    else if (key === 'arrowleft') { e.preventDefault(); go(-1); }
    else if (key === 'f') toggleFlag();
    else {
      const pos = Math.max(KEYS_LETTER.indexOf(key), KEYS_NUMBER.indexOf(key));
      if (pos >= 0) quiz.querySelectorAll('[data-option]')[pos]?.click();
      else if (key === 'r' && state.mode === 'practice' && quiz.querySelector('[data-action="retry-question"]')) retryQuestion();
    }
  });

  // Re-check the timer when the tab becomes visible again (background tabs throttle intervals).
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderTimer(); });

  seedMastery();

  // /<exam>?q=123 opens a single question (used by the admin reports list).
  const linked = Number(new URLSearchParams(location.search).get('q'));
  if (linked && BY_ID.has(linked)) {
    const p = state.practice;
    state.mode = 'practice';
    delete p.answers[linked];
    p.list = [linked]; p.index = 0; p.label = `Question #${linked}`;
    history.replaceState(null, '', location.pathname);
  }

  // An exam that expired while the page was closed is submitted on load.
  if (state.exam && !state.exam.result && Date.now() >= state.exam.endsAt) {
    finishExam(true);
    toast('Your previous exam ran out of time and was submitted.');
  }
  render();
  save(); // persist anything created on first render (e.g. a new practice round)
}

init();

// Offline support: cache the app so practice works without a connection.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

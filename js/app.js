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
  if (Object.keys(state.mastery).length) return;
  const at = state.updatedAt || Date.now();
  for (const [id, a] of Object.entries(state.practice.answers)) {
    const q = BY_ID.get(Number(id));
    if (q) recordResult(q.id, isCorrect(q, a), at);
  }
}
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// The active "session" the quiz screen is showing: list of ids + where answers live.
function session() {
  if (state.mode === 'exam') {
    const ex = state.exam;
    return { ids: ex.order, store: ex, locked: false, reveal: false };
  }
  if (state.mode === 'review') {
    const ex = state.exam;
    return { ids: state.review.ids, store: ex, locked: true, reveal: true, holder: state.review };
  }
  if (!state.practice.list) buildPracticeList();
  return { ids: state.practice.list, store: state.practice, locked: false, reveal: true, holder: state.practice };
}

// Builds the practice round from the filters. The list stays fixed while you answer, so
// questions don't vanish from 'Unanswered'/'Incorrect' views before you read the explanation.
function buildPracticeList() {
  const p = state.practice;
  const flagged = new Set(p.flagged);
  const ids = QUESTIONS.filter((q) => {
    if (p.domain !== 'ALL' && q.domain !== p.domain) return false;
    const a = p.answers[q.id];
    switch (p.status) {
      case 'unanswered': return a === undefined;
      case 'incorrect': return a !== undefined && !isCorrect(q, a);
      case 'flagged': return flagged.has(q.id);
      default: return true;
    }
  }).map((q) => q.id);
  const order = p.order || (p.shuffle ? 'shuffled' : 'ordered');
  if (order === 'weak') {
    // Missed and due questions come back unanswered so they can be practiced again.
    const again = weakIds(ids);
    for (const id of again) delete p.answers[id];
    reshuffleOptions(again);
    p.list = weakOrder(ids);
  } else {
    p.list = order === 'shuffled' ? shuffle(ids) : ids;
  }
  p.index = 0;
  p.label = null;
}

// A round of only the questions you missed or that are due for review.
function startWeakRound() {
  const p = state.practice;
  const pool = QUESTIONS.filter((q) => p.domain === 'ALL' || q.domain === p.domain).map((q) => q.id);
  const ids = weakIds(pool);
  if (!ids.length) return toast('Nothing to review right now. Nice work!');
  for (const id of ids) delete p.answers[id];
  reshuffleOptions(ids);
  p.list = weakOrder(ids);
  p.index = 0;
  p.label = `Reviewing ${ids.length} weak spot${ids.length > 1 ? 's' : ''}`;
  save(); render();
}

// New letter order for questions you haven't answered yet (or for the given ids).
function reshuffleOptions(ids) {
  const p = state.practice;
  const targets = ids || Object.keys(p.optionOrder).map(Number).filter((id) => p.answers[id] === undefined);
  for (const id of targets) delete p.optionOrder[id];
}

function currentHolder(s) { return s.holder || s.store; }

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  if (state.mode === 'learn' && !LEARN) state.mode = 'practice';
  renderModeTabs();
  renderTimer();

  const main = $('main');
  if (state.mode === 'learn') {
    $('navigator').hidden = true;
    return Learn.renderLearn(main, { exam: EXAM, state, save, practiceDomain });
  }
  Learn.stopLearn();
  $('practice-filters').hidden = state.mode !== 'practice';
  $('practice-stats').hidden = state.mode !== 'practice';
  $('btn-reset-practice').hidden = state.mode !== 'practice';

  if (!QUESTIONS.length) {
    renderGridEmpty();
    main.innerHTML = `<div class="panel empty"><p>This exam doesn't have any questions yet.</p><a class="btn btn-ghost" href="/">All exams</a></div>`;
    return;
  }
  if (state.mode === 'exam' && !state.exam) return renderExamIntro(main);
  if (state.mode === 'exam' && state.exam.result) return renderResults(main);

  const s = session();
  if (state.mode === 'practice') renderPracticeStats();
  if (s.ids.length === 0) {
    renderGrid(s);
    main.innerHTML = `<div class="panel empty"><p>No questions match this filter.</p>
      <button class="btn btn-ghost" data-action="clear-filters">Show all questions</button></div>`;
    return;
  }
  const holder = currentHolder(s);
  holder.index = Math.min(Math.max(holder.index || 0, 0), s.ids.length - 1);
  renderGrid(s);
  renderQuestion(main, s, holder.index);
}

function renderModeTabs() {
  const examTab = state.mode === 'exam' || state.mode === 'review';
  $('btn-mode-practice').setAttribute('aria-selected', String(state.mode === 'practice'));
  $('btn-mode-exam').setAttribute('aria-selected', String(examTab));
  $('btn-mode-learn').setAttribute('aria-selected', String(state.mode === 'learn'));
}

let gridKey = '';
function renderGrid(s) {
  $('navigator').hidden = false;
  const grid = $('question-grid');
  const holder = currentHolder(s);
  const flagged = new Set(s.store.flagged);
  // Rebuild the buttons only when the list itself changes; otherwise just update classes.
  const key = `${state.mode}:${s.ids.join(',')}`;
  if (key !== gridKey) {
    grid.innerHTML = s.ids.map((_, i) => `<button class="qbtn" data-jump="${i}">${i + 1}</button>`).join('');
    gridKey = key;
  }
  let answered = 0;
  const buttons = grid.children;
  s.ids.forEach((id, i) => {
    const a = s.store.answers[id];
    const isAnswered = a !== undefined;
    if (isAnswered) answered++;
    const status = !isAnswered ? '' : s.reveal ? (isCorrect(BY_ID.get(id), a) ? ' correct' : ' wrong') : ' answered';
    const current = i === holder.index;
    const cls = `qbtn${status}${flagged.has(id) ? ' flagged' : ''}${current ? ' current' : ''}`;
    const b = buttons[i];
    if (b.className !== cls) {
      b.className = cls;
      b.setAttribute('aria-label', `Question ${i + 1}${isAnswered ? ', answered' : ''}${flagged.has(id) ? ', flagged' : ''}`);
      if (current) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  });
  // Keep the current button visible inside the grid's own scroll area (never scrolls the page).
  const cur = buttons[holder.index];
  if (cur && grid.scrollHeight > grid.clientHeight) {
    const top = cur.offsetTop - grid.offsetTop;
    if (top < grid.scrollTop) grid.scrollTop = top - 4;
    else if (top + cur.offsetHeight > grid.scrollTop + grid.clientHeight) grid.scrollTop = top + cur.offsetHeight - grid.clientHeight + 4;
  }
  $('progress-text').textContent = `${answered} / ${s.ids.length}`;

  const nFlagged = s.store.flagged.length;
  $('flag-badge').hidden = nFlagged === 0;
  $('flag-badge').textContent = nFlagged;
}

function renderPracticeStats() {
  const p = state.practice;
  const answeredIds = Object.keys(p.answers).map(Number);
  const correct = answeredIds.filter((id) => isCorrect(BY_ID.get(id), p.answers[id])).length;
  const pct = answeredIds.length ? Math.round((correct / answeredIds.length) * 100) : 0;
  $('practice-stats').innerHTML = `
    <div><b>${answeredIds.length}</b><span class="muted">answered</span></div>
    <div><b class="good">${correct}</b><span class="muted">correct</span></div>
    <div><b class="${pct >= 70 ? 'good' : answeredIds.length ? 'weak' : ''}">${pct}%</b><span class="muted">accuracy</span></div>
    ${answeredIds.length - correct ? `<button class="btn btn-ghost btn-sm stats-wide" data-action="retry-missed">${icon('redo')}Retry ${answeredIds.length - correct} missed</button>` : ''}
    ${masterySummary()}`;
}

function masterySummary() {
  const pool = QUESTIONS.filter((q) => state.practice.domain === 'ALL' || q.domain === state.practice.domain).map((q) => q.id);
  const weak = weakIds(pool).length;
  const mastered = pool.filter((id) => (state.mastery[id]?.box || 0) >= 3).length;
  const pct = pool.length ? Math.round((mastered / pool.length) * 100) : 0;
  return `<div class="stats-wide mastery" title="Questions answered correctly several times in a row, spaced out over days">
      <div class="mastery-top"><span>Mastered</span><b>${mastered} / ${pool.length}</b></div>
      <div class="bar"><i class="good" style="width:${pct}%"></i></div>
    </div>
    ${weak ? `<button class="btn btn-ghost btn-sm stats-wide" data-action="weak-round">${icon('bulb')}Review ${weak} weak spot${weak > 1 ? 's' : ''}</button>` : ''}`;
}

function renderQuestion(main, s, index) {
  const id = s.ids[index];
  const q = BY_ID.get(id);
  const order = optionOrderFor(s.store, q);
  const answer = s.store.answers[id];
  const answered = answer !== undefined;
  const showResult = s.reveal && (answered || s.locked);
  const flagged = s.store.flagged.includes(id);
  const isLast = index === s.ids.length - 1;

  const options = order.map((origIdx, pos) => {
    const opt = q.options[origIdx];
    const cls = ['option'];
    let status = '';
    if (showResult) {
      if (origIdx === q.answer) { cls.push('is-correct'); status = icon('check', 'icon ostatus'); }
      else if (origIdx === answer) { cls.push('is-wrong'); status = icon('x', 'icon ostatus'); }
      else cls.push('dim');
    } else if (origIdx === answer) cls.push('selected');
    const note = showResult && opt.note && (origIdx === answer || origIdx !== q.answer)
      ? `<span class="onote">${opt.note}</span>` : '';
    return `<button class="${cls.join(' ')}" role="radio" aria-checked="${origIdx === answer}" data-option="${origIdx}" ${showResult ? 'disabled' : ''}>
      <span class="letter">${LETTERS[pos]}</span>
      <span class="otext">${opt.text}${note}</span>${status}
    </button>`;
  }).join('');

  let explain = '';
  if (showResult) {
    const right = isCorrect(q, answer);
    const correctLetter = LETTERS[order.indexOf(q.answer)];
    const head = !answered
      ? `${icon('bulb')} Not answered — correct answer: ${correctLetter}`
      : right ? `${icon('check')} Correct` : `${icon('x')} Incorrect — correct answer: ${correctLetter}`;
    explain = `<div class="explain ${!answered ? '' : right ? 'ok' : 'bad'}" role="status">
      <h4>${head}</h4><p>${q.explanation}</p></div>`;
  }

  const modeChip = state.mode === 'review'
    ? `<span class="chip chip-review">Review · ${state.review.source === 'missed' ? 'missed questions' : 'all questions'}</span>`
    : state.mode === 'practice' && state.practice.label ? `<span class="chip chip-review">${state.practice.label}</span>` : '';

  const primary = state.mode === 'exam'
    ? `<button class="btn btn-success" data-action="submit">${icon('check')}Submit exam</button>`
    : state.mode === 'review'
      ? `<button class="btn btn-ghost" data-action="back-to-results">Back to results</button>`
      : answered ? `<button class="btn btn-ghost" data-action="retry-question" title="Clear your answer and reshuffle the options">${icon('redo')}<span class="hide-sm">Try again</span></button>` : '';

  main.innerHTML = `
    <article class="panel qcard">
      <div class="qhead">
        <div class="chips">
          <span class="chip chip-azure">Question ${index + 1} of ${s.ids.length}</span>
          ${state.mode !== 'exam' ? `<span class="chip">${DOMAINS[q.domain].name}</span>` : ''}
          ${modeChip}
        </div>
        <div class="qhead-actions">
          ${state.mode === 'exam' ? `<button class="btn btn-ghost btn-sm" data-action="quit-exam" title="Stop this exam without scoring it">${icon('x')}<span class="hide-sm">Quit exam</span></button>` : ''}
          ${state.mode !== 'exam' && Auth.currentUser() ? `<button class="btn btn-ghost btn-sm" data-action="report" title="Report a problem with this question">${icon('alert')}<span class="hide-sm">Report</span></button>` : ''}
          ${s.locked ? '' : `<button class="btn btn-ghost btn-sm ${flagged ? 'active' : ''}" data-action="flag" aria-pressed="${flagged}">
            ${icon('flag')}${flagged ? 'Flagged' : 'Flag for review'}</button>`}
        </div>
      </div>
      <div class="qbody">
        <div class="scenario">${q.scenario}</div>
        ${q.code ? `<pre class="codeblock"></pre>` : ''}
        <p class="prompt-label">Select the best answer</p>
        <div class="options" role="radiogroup" aria-label="Answer options">${options}</div>
        ${explain}
      </div>
      <div class="qfoot">
        <button class="btn btn-ghost" data-action="prev" ${index === 0 ? 'disabled' : ''}>${icon('left')}Previous</button>
        <div class="right">
          ${primary}
          <button class="btn btn-primary" data-action="next" ${isLast ? 'disabled' : ''}>Next${icon('right')}</button>
        </div>
      </div>
      <div class="kbd-hint"><kbd>A</kbd>–<kbd>D</kbd> answer · <kbd>←</kbd> <kbd>→</kbd> navigate · <kbd>F</kbd> flag${state.mode === 'practice' ? ' · <kbd>R</kbd> try again' : ''}</div>
    </article>`;

  // Code is set via textContent so it is never parsed as HTML.
  if (q.code) main.querySelector('.codeblock').textContent = q.code;
}

function renderExamIntro(main) {
  renderGridEmpty();
  const last = state.history[0];
  main.innerHTML = `
    <section class="panel card-pad stack intro">
      <div class="stack" style="gap:8px">
        <h2>Timed exam · ${EXAM.code}</h2>
        <p class="muted">A full-length run under exam conditions. Questions and answer options are shuffled, and answers are only revealed after you submit.</p>
      </div>
      <div class="facts">
        <div class="fact"><b>${QUESTIONS.length}</b><span class="muted small">questions in the bank</span></div>
        <div class="fact"><b id="exam-minutes">${examMinutes(examSize())} min</b><span class="muted small">time limit</span></div>
        <div class="fact"><b>${passMark()}</b><span class="muted small">passing score (${EXAM.scoring.min}–${EXAM.scoring.max})</span></div>
        ${last ? `<div class="fact"><b class="${last.passed ? 'good' : 'weak'}">${last.score}</b><span class="muted small">last attempt</span></div>` : ''}
      </div>
      <ul class="rules">
        ${EXAM.realExamNote ? `<li>${EXAM.realExamNote}</li>` : ''}
        <li>The timer keeps running if you refresh or close the tab.</li>
        <li>Flag questions to come back to them from the navigator.</li>
        <li>The exam submits automatically when time runs out.</li>
      </ul>
      <div class="exam-size">
        <label for="exam-size">Number of questions</label>
        <div class="size-row">
          ${(EXAM.sizeOptions || [20, 40, 50, 60]).filter((n) => n <= QUESTIONS.length).map((n) =>
            `<button class="btn btn-ghost btn-sm ${n === examSize() ? 'active-size' : ''}" data-size="${n}">${n}</button>`).join('')}
          <input id="exam-size" type="number" min="1" max="${QUESTIONS.length}" value="${examSize()}" inputmode="numeric">
          <span class="muted small">of ${QUESTIONS.length} · ${EXAM.minutesPerQuestion} min per question</span>
        </div>
        <p class="muted small">Questions are picked in proportion to the ${EXAM.code} domain weights, favoring ones you've seen least.</p>
      </div>
      <div><button class="btn btn-primary" data-action="start-exam">${icon('play')}Start exam</button></div>
      ${historyTable()}
    </section>`;
}

function renderGridEmpty() {
  $('navigator').hidden = true;
  $('question-grid').innerHTML = '';
  gridKey = '';
  $('progress-text').textContent = `0 / ${QUESTIONS.length}`;
  $('flag-badge').hidden = true;
}

function renderResults(main) {
  renderGridEmpty();
  const r = state.exam.result;
  const domainRows = Object.entries(r.domains).filter(([, d]) => d.total > 0).map(([key, d]) => {
    const pct = d.total ? Math.round((d.correct / d.total) * 100) : 0;
    const tone = pct >= 70 ? 'good' : 'weak';
    return `<div class="domain-row">
      <div class="top"><span>${DOMAINS[key].name} <span class="muted small">(${DOMAINS[key].weight})</span></span>
        <span class="pct ${tone}">${pct}% · ${d.correct}/${d.total}</span></div>
      <div class="bar"><i class="${tone}" style="width:${pct}%"></i></div>
      ${pct < 70 ? `<button class="btn btn-ghost btn-sm" data-action="practice-domain" data-domain="${key}">Practice this domain</button>` : ''}</div>`;
  }).join('');
  const missed = r.total - r.correct;

  main.innerHTML = `
    <section class="panel card-pad stack">
      <div class="score-banner ${r.passed ? 'pass' : 'fail'}">
        <span class="status-pill">${r.passed ? 'PASSED' : 'NOT PASSED'}</span>
        <h2>${r.score} / ${EXAM.scoring.max}</h2>
        <p class="muted">${r.correct} of ${r.total} correct · ${r.timedOut ? 'time expired' : `finished in ${fmtTime(r.elapsed)}`}</p>
        <p class="small muted">Score is your percentage correct mapped onto the ${EXAM.scoring.min}–${EXAM.scoring.max} scale. ${EXAM.scoreNote || ''}</p>
      </div>
      <div class="stack" style="gap:10px">
        <h3 class="section-title">Domain breakdown</h3>
        ${domainRows}
      </div>
      ${historyTable()}
      <div class="actions">
        <div class="group">
          <button class="btn btn-warn" data-action="review-missed" ${missed ? '' : 'disabled'}>${icon('alert')}Review missed (${missed})</button>
          <button class="btn btn-ghost" data-action="review-all">Review all</button>
        </div>
        <button class="btn btn-primary" data-action="new-exam">${icon('redo')}New exam</button>
      </div>
    </section>`;
}

function historyTable() {
  if (!state.history.length) return '';
  const rows = state.history.slice(0, 8).map((h) => `<tr>
      <td>${new Date(h.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td class="num ${h.passed ? 'good' : 'weak'}">${h.score}</td>
      <td class="num">${h.correct}/${h.total}</td></tr>`).join('');
  return `<div class="stack" style="gap:8px"><h3 class="section-title">Recent attempts</h3>
    <table class="history"><thead><tr><th>Date</th><th>Score</th><th>Correct</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timer — derived from an absolute end time, so it is accurate even when the
// tab is throttled in the background or the page is reloaded.
// ─────────────────────────────────────────────────────────────────────────────
function remainingSeconds() {
  return Math.max(0, Math.round((state.exam.endsAt - Date.now()) / 1000));
}

function renderTimer() {
  const running = state.mode === 'exam' && state.exam && !state.exam.result;
  $('timer').hidden = !running;
  if (!running) { stopTimer(); return; }
  tick();
  if (!timerHandle) timerHandle = setInterval(tick, 1000);
}

function tick() {
  if (!state.exam || state.exam.result) return stopTimer();
  const left = remainingSeconds();
  const el = $('timer');
  $('timer-display').textContent = fmtTime(left);
  el.classList.toggle('low', left <= 600 && left > 120);
  el.classList.toggle('critical', left <= 120);
  if (left === 0) {
    stopTimer();
    finishExam(true);
    toast("Time's up — your exam was submitted.");
  }
}

function stopTimer() { clearInterval(timerHandle); timerHandle = null; }

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────
function go(delta) {
  const s = session();
  const h = currentHolder(s);
  const next = h.index + delta;
  if (next < 0 || next >= s.ids.length) return;
  h.index = next;
  save(); render(); scrollTopOnMobile();
}

function jump(i) {
  const s = session();
  currentHolder(s).index = i;
  if (window.matchMedia('(max-width: 900px)').matches) $('navigator').classList.remove('open');
  save(); render(); scrollTopOnMobile();
}

function scrollTopOnMobile() {
  if (window.scrollY > 120) $('main').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function choose(origIdx) {
  const s = session();
  if (s.locked) return;
  const id = s.ids[currentHolder(s).index];
  if (state.mode === 'practice' && s.store.answers[id] !== undefined) return; // practice answers lock once revealed
  s.store.answers[id] = origIdx;
  if (state.mode === 'practice') recordResult(id, isCorrect(BY_ID.get(id), origIdx));
  save(); render();
}

function toggleFlag() {
  const s = session();
  if (s.locked) return;
  const id = s.ids[currentHolder(s).index];
  const f = s.store.flagged;
  const i = f.indexOf(id);
  if (i >= 0) f.splice(i, 1); else f.push(id);
  save(); render();
}

function setMode(mode) {
  if (mode === 'learn' && state.mode === 'learn' && state.learn?.view?.module) {
    state.learn.view.module = null; save(); return render(); // clicking Learn again returns to the module list
  }
  if (mode !== 'exam' && state.mode === 'exam' && state.exam && !state.exam.result) {
    // The exam keeps running in the background; just switch the view.
    toast('Your exam is still running — switch back to Exam to continue.');
  }
  if (mode === 'exam' && state.mode === 'review') { state.mode = 'exam'; save(); return render(); }
  state.mode = mode;
  save(); render();
}

function examSize() {
  return Math.min(Math.max(1, state.examSize || EXAM.defaultSize || 50), QUESTIONS.length);
}

// Pick `count` questions: allocate slots per domain by exam weight (largest-remainder),
// then inside each domain prefer the least-seen questions, random among ties.
function pickQuestions(count) {
  const pools = {};
  for (const q of QUESTIONS) (pools[q.domain] ||= []).push(q.id);
  const keys = Object.keys(pools);
  const weightSum = keys.reduce((s, k) => s + (DOMAINS[k]?.pct || 1), 0);
  const alloc = Object.fromEntries(keys.map((k) => [k, 0]));
  const exact = keys.map((k) => ({ k, v: (count * (DOMAINS[k]?.pct || 1)) / weightSum }));
  for (const e of exact) alloc[e.k] = Math.min(Math.floor(e.v), pools[e.k].length);
  // Hand out remaining slots by largest remainder, skipping domains that ran out of questions.
  let left = count - Object.values(alloc).reduce((a, b) => a + b, 0);
  const byRemainder = [...exact].sort((a, b) => (b.v % 1) - (a.v % 1));
  while (left > 0) {
    let gave = false;
    for (const { k } of byRemainder) {
      if (left > 0 && alloc[k] < pools[k].length) { alloc[k]++; left--; gave = true; }
    }
    if (!gave) break;
  }
  const seen = state.seen || {};
  const picked = keys.flatMap((k) =>
    shuffle(pools[k]).sort((a, b) => (seen[a] || 0) - (seen[b] || 0)).slice(0, alloc[k]));
  return shuffle(picked);
}

function startExam() {
  const count = examSize();
  const order = pickQuestions(count);
  for (const id of order) state.seen[id] = (state.seen[id] || 0) + 1;
  state.exam = {
    order, optionOrder: {}, answers: {}, flagged: [], index: 0, minutes: examMinutes(order.length),
    startedAt: Date.now(), endsAt: Date.now() + examMinutes(order.length) * 60 * 1000, result: null,
  };
  state.review = null;
  state.mode = 'exam';
  save(); render();
  window.scrollTo({ top: 0 });
}

// Leaves the exam unscored and goes back to the setup screen (question count, start).
async function quitExam() {
  const ex = state.exam;
  if (!ex || ex.result) return newExamSetup();
  const answered = Object.keys(ex.answers).length;
  const ok = await confirmModal('Quit this exam?',
    `You've answered <b>${answered}</b> of <b>${ex.order.length}</b> questions. Quitting discards this attempt without a score, and you can start a new exam with any number of questions.`,
    'Quit exam', 'Keep going');
  if (!ok) return;
  newExamSetup();
  toast('Exam discarded. Choose a size and start again whenever you\'re ready.');
}

function newExamSetup() {
  stopTimer();
  state.exam = null;
  state.review = null;
  state.mode = 'exam';
  save(); render();
  window.scrollTo({ top: 0 });
}

async function confirmSubmit() {
  const ex = state.exam;
  const answered = Object.keys(ex.answers).length;
  const unanswered = ex.order.length - answered;
  const flagged = ex.flagged.length;
  let body = `You've answered <b>${answered}</b> of <b>${ex.order.length}</b> questions.`;
  if (unanswered) body += `<br><span style="color:var(--warn-text)">${unanswered} unanswered question${unanswered > 1 ? 's' : ''} will be marked wrong.</span>`;
  if (flagged) body += `<br>${flagged} question${flagged > 1 ? 's are' : ' is'} still flagged for review.`;
  const ok = await confirmModal('Submit exam?', body, 'Submit', 'Keep working');
  if (ok) finishExam(false);
}

function finishExam(timedOut) {
  const ex = state.exam;
  if (!ex || ex.result) return;
  const domains = Object.fromEntries(Object.keys(DOMAINS).map((k) => [k, { correct: 0, total: 0 }]));
  let correct = 0;
  for (const id of ex.order) {
    const q = BY_ID.get(id);
    domains[q.domain].total++;
    const right = isCorrect(q, ex.answers[id]);
    if (right) { correct++; domains[q.domain].correct++; }
    recordResult(id, right);
  }
  const total = ex.order.length;
  const score = scaleScore(correct, total);
  const passed = score >= passMark();
  const elapsed = Math.min((ex.minutes || 100) * 60, Math.round((Date.now() - ex.startedAt) / 1000));
  ex.result = { correct, total, score, passed, domains, timedOut, elapsed };
  state.history.unshift({ at: Date.now(), score, correct, total, passed });
  state.history = state.history.slice(0, 20);
  state.mode = 'exam';
  stopTimer();
  save(); render();
  window.scrollTo({ top: 0 });
}

function practiceDomain(domain) {
  const p = state.practice;
  p.domain = domain;
  p.status = 'all';
  buildPracticeList();
  state.mode = 'practice';
  syncFilterControls();
  save(); render();
  window.scrollTo({ top: 0 });
}

function startReview(source) {
  const ex = state.exam;
  const ids = source === 'missed' ? ex.order.filter((id) => !isCorrect(BY_ID.get(id), ex.answers[id])) : [...ex.order];
  if (!ids.length) return;
  state.review = { ids, index: 0, source };
  state.mode = 'review';
  save(); render();
  window.scrollTo({ top: 0 });
}

async function resetPractice() {
  const ok = await confirmModal('Reset practice progress?', 'This clears your practice answers and flags, and reshuffles every question. Exam history is kept.', 'Reset', 'Cancel');
  if (!ok) return;
  const keep = { shuffle: state.practice.shuffle, order: state.practice.order };
  state.practice = { ...defaultState().practice, ...keep };
  buildPracticeList();
  syncFilterControls();
  save(); render();
}

function reshufflePractice() {
  reshuffleOptions();
  const p = state.practice;
  const label = p.label;
  p.shuffle = true;
  if (p.order === 'ordered') p.order = 'shuffled';
  p.list = shuffle(p.list || []);
  p.index = 0;
  p.label = label;
  syncFilterControls();
  save(); render();
  toast('Questions and answer letters reshuffled.');
}

function retryQuestion() {
  const p = state.practice;
  const id = p.list[p.index];
  delete p.answers[id];
  reshuffleOptions([id]);
  save(); render();
}

function retryMissed() {
  const p = state.practice;
  const missed = Object.keys(p.answers).map(Number).filter((id) => BY_ID.has(id) && !isCorrect(BY_ID.get(id), p.answers[id]));
  if (!missed.length) return;
  for (const id of missed) delete p.answers[id];
  reshuffleOptions(missed);
  p.list = shuffle(missed);
  p.index = 0;
  p.label = `Retrying ${missed.length} missed question${missed.length > 1 ? 's' : ''}`;
  save(); render();
}

function applyPracticeFilters() {
  const p = state.practice;
  p.domain = $('domain-filter').value;
  p.status = $('status-filter').value;
  p.order = $('order-filter').value;
  p.shuffle = p.order !== 'ordered';
  buildPracticeList();
  save(); render();
}

const REPORT_REASONS = {
  'wrong-answer': 'The marked answer is wrong',
  explanation: 'The explanation is wrong or misleading',
  unclear: 'The question is unclear or has two right answers',
  outdated: "It's outdated (product or exam changed)",
  typo: 'Typo or formatting problem',
  other: 'Something else',
};

async function reportCurrentQuestion() {
  const s = session();
  const id = s.ids[currentHolder(s).index];
  const q = BY_ID.get(id);
  const body = `<div class="report-form">
      <p class="small">Question #${id} · ${escapeHtml(DOMAINS[q.domain].name)}</p>
      <label class="small">What's wrong?
        <select id="report-reason">${Object.entries(REPORT_REASONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </label>
      <label class="small">Details (optional)
        <textarea id="report-details" rows="4" maxlength="2000" placeholder="For example: the correct answer should be B because…"></textarea>
      </label>
    </div>`;
  if (!(await confirmModal('Report a problem', body, 'Send report'))) return;
  try {
    await Auth.reportQuestion({
      exam: EXAM.slug, questionId: id, reason: $('report-reason').value,
      details: $('report-details').value.trim(), questionText: q.scenario.replace(/<[^>]+>/g, ''),
    });
    toast('Thanks — your report was sent.');
  } catch (err) {
    toast(`Couldn't send the report: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal & toast (replace blocking alert()/confirm())
// ─────────────────────────────────────────────────────────────────────────────
function confirmModal(title, bodyHtml, okLabel = 'OK', cancelLabel = 'Cancel') {
  const dlg = $('modal');
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-ok').textContent = okLabel;
  $('modal-cancel').textContent = cancelLabel;
  dlg.returnValue = '';
  dlg.showModal();
  ($('modal-body').querySelector('select, textarea, input') || $('modal-ok')).focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring (event delegation: one listener instead of one per button)
// ─────────────────────────────────────────────────────────────────────────────
function syncFilterControls() {
  $('domain-filter').value = state.practice.domain;
  $('status-filter').value = state.practice.status;
  $('order-filter').value = state.practice.order || (state.practice.shuffle ? 'shuffled' : 'ordered');
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// The exam catalog is needed by the home page, cloud sync and the reports panel; fetch it once.
let indexRequest = null;
const fetchIndex = () => (indexRequest ||= fetchJson('/exams/index.json').catch((err) => { indexRequest = null; throw err; }));

const fetchBank = (slug) => Promise.all([fetchJson(`/exams/${slug}/exam.json`), fetchJson(`/exams/${slug}/questions.json`)]);

// `files` is an in-flight fetchBank() started early in init(), so downloads overlap sign-in.
async function loadBank(slug, files = fetchBank(slug)) {
  [EXAM, QUESTIONS] = await files;
  DOMAINS = EXAM.domains;
  state = load();
  BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));
  // Drop saved references to questions that no longer exist in the bank.
  const valid = (id) => BY_ID.has(Number(id));
  for (const store of [state.practice, state.exam].filter(Boolean)) {
    store.answers = Object.fromEntries(Object.entries(store.answers).filter(([id]) => valid(id)));
    store.flagged = store.flagged.filter(valid);
  }
  if (state.exam) state.exam.order = state.exam.order.filter(valid);
  if (state.exam && !state.exam.order.length) state.exam = null;
  if (state.review) state.review.ids = state.review.ids.filter(valid);
  if (state.practice.list) state.practice.list = state.practice.list.filter(valid);
  if (state.practice.list && !state.practice.list.length) state.practice.list = null;
  if (state.mode === 'review' && !state.review?.ids.length) state.mode = 'exam';
}

// Feeds the home page "Most popular" folder. Throttled so refreshes don't inflate counts.
function logView(slug) {
  if (!Auth.currentUser()) return;
  const KEY = 'examsim:views';
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* ignore */ }
  if (Date.now() - (seen[slug] || 0) < 60 * 60 * 1000) return;
  seen[slug] = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch { /* ignore */ }
  Auth.recordView(slug).catch(() => { /* best effort */ });
}

// /az-104 or /network-plus selects an exam; / shows the exam picker.
function currentSlug() {
  const fromQuery = new URLSearchParams(location.search).get('exam');
  const fromPath = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  const slug = (fromQuery || fromPath || '').toLowerCase();
  return /^[a-z0-9-]+$/.test(slug) && slug !== 'index.html' ? slug : '';
}

const vendorKey = (v = '') => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const levelRank = (l) => (LEVELS.includes(l) ? LEVELS.indexOf(l) : LEVELS.length);
const levelMeter = (l) => {
  if (!LEVELS.includes(l)) return '';
  const n = LEVELS.indexOf(l) + 1;
  const label = l[0].toUpperCase() + l.slice(1);
  return `<span class="level-meter" data-level="${l}" title="Difficulty: ${label} (${n} of 3)">
    <span class="level-bars" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>
    <span class="sr-only">Difficulty: </span>${label}</span>`;
};

// What this person has done in an exam, or null if they haven't started it.
function recentActivity(e, saved) {
  if (!saved) return null;
  const answered = Object.keys(saved.practice?.answers || {}).length;
  const modules = Object.values(saved.learn?.progress || {});
  const parts = modules.reduce((n, p) => n + ['guide', 'slides', 'video'].filter((k) => p?.[k]).length, 0);
  const examRunning = !!(saved.exam && !saved.exam.result);
  const last = saved.history?.[0];
  const openedModule = !!saved.learn?.view?.module; // reading a module counts as started
  if (!answered && !parts && !examRunning && !last && !openedModule) return null;
  return { answered, parts, totalParts: (e.learningModules || 0) * 3, examRunning, last, openedModule, mode: saved.mode };
}

function recentCard({ e, activity: a }) {
  const pct = (n, total) => (total ? Math.min(100, Math.round((n / total) * 100)) : 0);
  const rows = [];
  if (e.learning && (a.parts || a.openedModule)) {
    rows.push(`<span class="recent-row"><span>Learning</span><b>${a.totalParts ? `${a.parts} / ${a.totalParts} parts` : `${a.parts} parts`}</b></span>
      <span class="recent-bar"><i style="width:${pct(a.parts, a.totalParts)}%"></i></span>`);
  }
  if (a.answered || !rows.length) {
    rows.push(`<span class="recent-row"><span>Practice</span><b>${a.answered}${e.questions ? ` / ${e.questions}` : ''} answered</b></span>
      <span class="recent-bar"><i style="width:${pct(a.answered, e.questions)}%"></i></span>`);
  }
  if (a.examRunning) rows.push('<span class="recent-row"><span>Timed exam</span><b class="running">In progress</b></span>');
  else if (a.last) rows.push(`<span class="recent-row"><span>Last exam</span><b class="${a.last.passed ? 'good' : 'weak'}">${a.last.score}</b></span>`);
  const learnFirst = a.mode === 'learn' && e.learning;
  const action = a.examRunning ? 'Resume exam' : learnFirst ? 'Continue learning' : 'Continue practice';
  return `<a class="panel learning-path-card recent-card" href="/${e.slug}${learnFirst ? '?mode=learn' : ''}" data-vendor="${vendorKey(e.vendor)}">
      <span class="learning-path-eyebrow">${escapeHtml(e.vendor.toUpperCase())} · ${escapeHtml(e.code)}</span>
      <h3>${escapeHtml(e.name)}</h3>
      <span class="recent-rows">${rows.join('')}</span>
      <span class="learning-path-action">${action} ${icon('right', 'icon')}</span>
    </a>`;
}

async function renderHome() {
  document.body.classList.add('home');
  $('navigator').hidden = true;
  let exams = [];
  const popularRequest = Auth.currentUser() ? Auth.popularExams(30, 6).catch(() => []) : Promise.resolve([]);
  try { exams = await fetchIndex(); } catch { /* offline with nothing cached */ }
  const cards = await Promise.all(exams.map(async (e) => {
    // Counts are kept in index.json by scripts/stamp-updated.mjs; fall back to the bank if missing.
    let count = e.questions ?? 0;
    if (e.questions == null) try { count = (await fetchJson(`/exams/${e.slug}/questions.json`)).length; } catch { /* ignore */ }
    const saved = readSaved(e.slug, e.legacyStorageKey);
    const last = saved?.history?.[0];
    const answered = saved ? Object.keys(saved.practice?.answers || {}).length : 0;
    const vendor = vendorKey(e.vendor);
    return `<a class="panel exam-card" href="/${e.slug}" data-vendor="${vendor}" data-name="${escapeHtml(`${e.name} ${e.code} ${e.vendor}`.toLowerCase())}">
      <span class="exam-card-code">${escapeHtml(e.code)}</span>
      <h2>${escapeHtml(e.name)}</h2>
      <span class="exam-card-meta"><span>${count} questions</span>${levelMeter(e.level)}</span>
      ${e.learning ? '<span class="exam-learning-badge">Study guide · slides · lessons</span>' : ''}
      ${answered || last ? `<span class="exam-card-progress">${answered ? `${answered} practiced` : ''}${answered && last ? ' · ' : ''}${last ? `Last score <b class="${last.passed ? 'good' : 'weak'}">${last.score}</b>` : ''}</span>` : ''}
      <span class="exam-card-action">Open exam ${icon('right', 'icon')}</span>
    </a>`;
  }));
  const cardFor = Object.fromEntries(exams.map((e, i) => [e.slug, cards[i]]));

  // ── Recents: exams this person has studied or practiced, most recently opened first.
  const recents = exams.map((e) => ({ e, saved: readSaved(e.slug, e.legacyStorageKey) }))
    .map(({ e, saved }) => ({ e, saved, activity: recentActivity(e, saved) }))
    .filter((r) => r.activity)
    .sort((a, b) => (b.saved.updatedAt || 0) - (a.saved.updatedAt || 0))
    .slice(0, 6);
  const learningExams = exams.filter((e) => e.learning);
  const learningCards = learningExams.map((e) => `
    <a class="panel learning-path-card" href="/${e.slug}?mode=learn" data-vendor="${vendorKey(e.vendor)}">
      <span class="learning-path-eyebrow">LEARNING PATH · ${escapeHtml(e.code)}</span>
      <h3>${escapeHtml(e.name)}</h3>
      <p>${escapeHtml(e.learningDescription || `Structured study materials for ${e.name}, organized by exam domain.`)}</p>
      <span class="learning-path-meta"><span>One module per exam domain</span><span>Guides · slides · video</span></span>
      <span class="learning-path-action">Start learning ${icon('right', 'icon')}</span>
    </a>`).join('');
  const recentsBody = recents.length
    ? `<div class="learning-path-grid">${recents.map(recentCard).join('')}</div>`
    : learningCards
      ? `<p class="recents-empty">Nothing in progress yet. Start with a learning path, or open any practice exam below.</p>
         <div class="learning-path-grid">${learningCards}</div>`
      : '<p class="recents-empty">Courses and exams you start will appear here.</p>';

  // ── Most popular: an open folder of the most-viewed exams (all users, last 30 days).
  const popular = ((await popularRequest) || []).filter((p) => cardFor[p?.exam]);
  const popularFolder = popular.length ? `<details class="vendor-folder popular-folder" data-provider-group="popular" open>
      <summary>
        ${icon('trend', 'icon folder-icon')}
        <span class="folder-name">Most popular</span>
        <span class="folder-count">Last 30 days</span>
      </summary>
      <div class="exam-grid">${popular.map((p) => cardFor[p.exam]).join('')}</div>
    </details>` : '';

  const providers = [...new Set(exams.map((e) => e.vendor))];
  const examGroups = popularFolder + providers.map((provider) => {
    const key = vendorKey(provider);
    const entries = exams.map((exam, index) => ({ exam, card: cards[index] }))
      .filter(({ exam }) => exam.vendor === provider)
      .sort((a, b) => levelRank(a.exam.level) - levelRank(b.exam.level)
        || a.exam.code.localeCompare(b.exam.code, undefined, { numeric: true }));
    const preview = entries.slice(0, 5).map(({ exam }) =>
      `<span class="folder-code" data-level="${exam.level || ''}">${escapeHtml(exam.code)}</span>`).join('');
    return `<details class="vendor-folder" data-provider-group="${key}" data-vendor="${key}">
      <summary>
        ${icon('folder', 'icon folder-icon')}
        <span class="folder-name">${escapeHtml(provider)}</span>
        <span class="folder-preview">${preview}</span>
        <span class="folder-count">${entries.length} exam${entries.length === 1 ? '' : 's'}</span>
      </summary>
      <div class="exam-grid">${entries.map(({ card }) => card).join('')}</div>
    </details>`;
  }).join('');
  const providerControls = ['All providers', ...providers].map((provider, index) => {
    const key = index === 0 ? 'all' : vendorKey(provider);
    const count = index === 0 ? exams.length : exams.filter((e) => e.vendor === provider).length;
    return `<button type="button" class="provider-filter${index === 0 ? ' active' : ''}" data-provider-filter="${key}" aria-pressed="${index === 0}">${escapeHtml(provider)} <span>${count}</span></button>`;
  }).join('');
  $('main').innerHTML = `<section class="catalog stack">
    <section class="home-hero">
      <div class="home-hero-copy">
        <span class="eyebrow">YOUR CERTIFICATION STUDY SPACE</span>
        <h2>Learn the concepts.<br><span>Practice with confidence.</span></h2>
        <p>Start with a guided learning path, sharpen your skills with practice questions, and see how ready you are for exam day.</p>
        <div class="home-hero-actions">
          <a class="btn btn-primary" href="#recents">${icon('learn')}${recents.length ? 'Continue where you left off' : 'Explore learning'}</a>
          <a class="btn btn-ghost" href="#practice">Browse practice exams</a>
        </div>
      </div>
      <div class="home-hero-steps" aria-label="A flexible path to exam readiness">
        <div><span class="hero-step-icon">01</span><span><b>Learn</b><small>Guides, slides, and lessons</small></span></div>
        <div><span class="hero-step-icon">02</span><span><b>Practice</b><small>Questions with explanations</small></span></div>
        <div><span class="hero-step-icon">03</span><span><b>Get exam-ready</b><small>Timed tests and progress</small></span></div>
      </div>
    </section>
    <section class="learning-section" id="recents" aria-labelledby="recents-title">
      <div class="section-heading">
        <div><span class="eyebrow">RECENTS</span><h2 id="recents-title">${recents.length ? 'Pick up where you left off' : 'Start learning'}</h2>
          <p class="muted">${recents.length ? 'Your in-progress courses and practice exams, most recent first.' : 'Courses and exams you start will appear here.'}</p></div>
        ${recents.length ? `<span class="learning-count">${recents.length} in progress</span>` : ''}
      </div>
      ${recentsBody}
    </section>
    <section class="practice-section" id="practice" aria-labelledby="practice-title">
    <div class="catalog-heading">
      <div class="stack" style="gap:6px"><span class="eyebrow">CERTIFICATION LIBRARY</span><h2 class="home-title" id="practice-title">Choose a certification to practice</h2>
        <p class="muted">Work through question banks at your pace or take a timed exam.</p></div>
      <div class="catalog-summary"><strong>${exams.length}</strong> exams <span>·</span> <strong>${providers.length}</strong> providers</div>
    </div>
    <div class="catalog-tools">
      <label class="catalog-search"><span class="sr-only">Search certifications</span><input id="exam-search" type="search" placeholder="Search exams or codes" autocomplete="off"></label>
      <div class="provider-filters" role="group" aria-label="Filter exams by provider">${providerControls}</div>
    </div>
    <div class="catalog-results-head"><div><h3>All practice exams</h3><p class="muted small">Search by certification or filter by provider to find your next practice session.</p></div><span id="exam-result-count" class="muted small">${exams.length} exams</span></div>
    <div id="exam-grid" class="folder-list">${examGroups}</div>
    <p id="exam-empty" class="panel catalog-empty" hidden>No certifications match your search. Try a different term or provider.</p>
    </section>
    <section class="request-section" aria-labelledby="request-title">
      <div class="request-copy">
        <span class="eyebrow">HELP SHAPE WHAT COMES NEXT</span>
        <h2 id="request-title">Request a course or exam</h2>
        <p>Tell us which certification you’re studying for and what learning materials would help. Requests help us prioritize future additions.</p>
      </div>
      <div class="request-action">
        <a class="btn btn-primary" href="https://github.com/abg0dw1n/az104-exam-simulator/issues/new?template=course-exam-request.yml" target="_blank" rel="noopener noreferrer">Submit a request ${icon("right","icon")}</a>
        <p>Requests are public on GitHub. A GitHub account is required. Please don’t include personal or sensitive information.</p>
      </div>
    </section>
  </section>`;
  const grid = $('exam-grid');
  const search = $('exam-search');
  let activeProvider = 'all';
  const applyFilters = () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    const filtering = !!query || activeProvider !== 'all';
    grid.querySelectorAll('.vendor-folder').forEach((group) => {
      const isPopular = group.dataset.providerGroup === 'popular';
      const providerMatch = activeProvider === 'all' || group.dataset.providerGroup === activeProvider;
      let groupVisible = 0;
      group.querySelectorAll('.exam-card').forEach((card) => {
        const match = !query || card.dataset.name.includes(query);
        card.hidden = !match;
        if (match) groupVisible++;
      });
      // "Most popular" repeats exams from the vendor folders, so hide it while filtering.
      group.hidden = isPopular ? filtering : !providerMatch || groupVisible === 0;
      if (isPopular) return;
      // Vendor folders start collapsed; open the ones with matches while searching or filtering.
      group.open = filtering && !group.hidden;
      group.querySelector('.folder-count').textContent = `${groupVisible} exam${groupVisible === 1 ? '' : 's'}`;
      visible += groupVisible;
    });
    $('exam-result-count').textContent = `${visible} exam${visible === 1 ? '' : 's'}`;
    $('exam-empty').hidden = visible > 0;
  };
  search.addEventListener('input', applyFilters);
  $('main').querySelectorAll('[data-provider-filter]').forEach((button) => button.addEventListener('click', () => {
    activeProvider = button.dataset.providerFilter;
    $('main').querySelectorAll('[data-provider-filter]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    applyFilters();
  }));
}

// ── Sign-in screen ───────────────────────────────────────────────────────────
function renderSignIn(error) {
  document.body.classList.add('home', 'signed-out');
  $('navigator').hidden = true;
  const providers = Auth.PROVIDERS.map((p) =>
    `<button class="btn btn-ghost full" data-provider="${p.id}">${p.label}</button>`).join('');
  $('main').innerHTML = `<section class="panel card-pad signin">
      <h2>Sign in</h2>
      <p class="muted">This exam simulator is invite-only. Sign in to practice and keep your progress in sync across devices.</p>
      ${error ? `<p class="signin-msg bad-msg" role="alert">${escapeHtml(error)}</p>` : ''}
      ${providers ? `<div class="stack" style="gap:10px">${providers}</div><div class="or"><span>or</span></div>` : ''}
      <form id="magic-form" class="stack" style="gap:10px">
        <label for="magic-email" class="small muted">Email address</label>
        <input id="magic-email" type="email" autocomplete="email" required placeholder="you@example.com">
        <button class="btn btn-primary full" type="submit">Email me a sign-in link</button>
      </form>
      <p id="magic-status" class="signin-msg" role="status" hidden></p>
      <p class="signin-foot"><a href="/privacy">Privacy policy</a></p>
    </section>`;
  $('main').querySelectorAll('[data-provider]').forEach((b) => b.addEventListener('click', () => Auth.signInWith(b.dataset.provider)));
  $('magic-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); const status = $('magic-status');
    btn.disabled = true; status.hidden = false; status.className = 'signin-msg'; status.textContent = 'Sending…';
    try {
      await Auth.sendMagicLink($('magic-email').value);
      status.classList.add('ok-msg');
      status.textContent = 'Check your email for a sign-in link. You can close this tab; the link opens the site signed in.';
    } catch (err) {
      status.classList.add('bad-msg'); status.textContent = err.message;
    } finally { btn.disabled = false; }
  });
}

function renderAccount() {
  const user = Auth.currentUser();
  const link = $('account');
  link.hidden = !user;
  if (user) link.title = `Signed in as ${user.email || 'you'}`;
}

// ── Account page (/account): profile, sign out, and admin tools ──────────────
async function renderAccountPage() {
  document.body.classList.add('home', 'account-page');
  document.title = 'Account · IT Learn & Practice';
  $('navigator').hidden = true;
  $('account').classList.add('active');
  const user = Auth.currentUser();
  $('main').innerHTML = `<section class="stack">
      <div class="stack" style="gap:6px"><h2 class="home-title">Account</h2>
      <p class="muted">Your sign-in details and account settings.</p></div>
      <div class="panel card-pad account-card">
        <div class="account-avatar" aria-hidden="true">${escapeHtml((user?.email || '?')[0].toUpperCase())}</div>
        <div class="account-who"><span class="muted small">Signed in as</span><b>${escapeHtml(user?.email || 'Guest')}</b>
          <span class="muted small">Your practice progress and exam history sync to this account.</span></div>
        <div class="account-actions"><a class="btn btn-ghost btn-sm" href="/privacy">Privacy policy</a>
          ${user ? '<button id="btn-signout" class="btn btn-ghost btn-sm">Sign out</button>' : ''}</div>
      </div>
      <div id="invites" class="stack"></div>
    </section>`;
  $('btn-signout')?.addEventListener('click', async () => {
    if (!(await confirmModal('Sign out?', 'Your progress is saved to your account and removed from this device.', 'Sign out'))) return;
    flushUpload();
    await Auth.signOut();
    location.assign('/');
  });
  renderInvites();
}

// ── Invites (shown to admins only) ───────────────────────────────────────────
async function renderInvites() {
  const box = $('invites');
  if (!box || !Auth.currentUser()) return;
  let rows;
  try { rows = await Auth.listInvites(); } catch { return; }
  if (!rows?.length) return; // not an admin
  box.innerHTML = `<div class="panel card-pad stack" style="gap:14px">
      <div><h2 class="section-title">Invite people</h2>
      <p class="muted small" style="margin-top:8px">Invited people can sign in with that email address (email link${Auth.PROVIDERS.length ? ', ' + Auth.PROVIDERS.map((p) => p.label.replace('Continue with ', '')).join(', ') : ''}). Each person gets their own progress.</p></div>
      <form id="invite-form" class="invite-row">
        <input id="invite-email" type="email" required placeholder="friend@example.com" aria-label="Email to invite">
        <input id="invite-note" type="text" placeholder="Name (optional)" aria-label="Name">
        <button class="btn btn-primary" type="submit">Invite</button>
      </form>
      <ul class="invite-list">${rows.map((r) => `<li><span><b>${escapeHtml(r.email)}</b>${r.note ? ` <span class="muted">· ${escapeHtml(r.note)}</span>` : ''}</span>
        ${r.is_admin ? '<span class="chip">admin</span>' : `<button class="btn btn-ghost btn-sm" data-uninvite="${escapeHtml(r.email)}">Remove</button>`}</li>`).join('')}</ul>
    </div>`;
  $('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    if (btn.disabled) return; // ignore double submits
    btn.disabled = true;
    try { await Auth.addInvite($('invite-email').value, $('invite-note').value); toast('Invited. They can now sign in with that email.'); }
    catch (err) { toast(/duplicate|already/i.test(err.message) ? 'That email is already invited.' : `Couldn't invite: ${err.message}`); }
    finally { renderInvites(); } // always show the current list
  });
  renderReports(box);
  box.querySelectorAll('[data-uninvite]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('Remove invite?', `${escapeHtml(b.dataset.uninvite)} won't be able to create an account. If they already have one, it stays until you delete the user in Supabase.`, 'Remove'))) return;
    try { await Auth.removeInvite(b.dataset.uninvite); renderInvites(); } catch (err) { toast(`Couldn't remove: ${err.message}`); }
  }));
}

async function renderReports(container) {
  let rows = [];
  try { rows = await Auth.listOpenReports(); } catch { return; }
  let exams = [];
  try { exams = await fetchIndex(); } catch { /* ignore */ }
  const codes = Object.fromEntries(exams.map((e) => [e.slug, e.code]));
  container.querySelector('.reports-panel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'panel card-pad stack reports-panel';
  panel.style.gap = '14px';
  panel.innerHTML = `<h2 class="section-title">Reported questions ${rows.length ? `<span class="chip chip-review">${rows.length} open</span>` : ''}</h2>
    ${rows.length ? `<ul class="invite-list">${rows.map((r) => `<li class="report-item">
      <span><b>${escapeHtml(codes[r.exam] || r.exam)} · #${r.question_id}</b> — ${escapeHtml(REPORT_REASONS[r.reason] || r.reason)}
        ${r.details ? `<br><span class="small">${escapeHtml(r.details)}</span>` : ''}
        <br><span class="muted small">${escapeHtml(r.reporter_email || '')} · ${new Date(r.created_at).toLocaleDateString()}</span></span>
      <span class="report-actions"><a class="btn btn-ghost btn-sm" href="/${encodeURIComponent(r.exam)}?q=${r.question_id}">Open</a>
      <button class="btn btn-ghost btn-sm" data-resolve="${r.id}">Resolve</button></span></li>`).join('')}</ul>`
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
  try { exams = await fetchIndex(); } catch { /* offline */ }
  const legacy = Object.fromEntries(exams.map((e) => [e.slug, e.legacyStorageKey]));
  const slugs = exams.map((e) => e.slug);
  const work = Auth.pullAll((slug) => readSaved(slug, legacy[slug]), writeSaved, slugs);
  await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
}

async function init() {
  const initialSlug = currentSlug();
  const initialMode = new URLSearchParams(location.search).get('mode');
  const loadingMessage = initialSlug === 'account'
    ? 'Loading your account…'
    : initialSlug
      ? initialMode === 'learn' ? 'Loading learning materials…' : 'Loading exam…'
      : 'Loading the learning and practice library…';
  $('main').innerHTML = `<div class="panel empty" role="status"><p>${loadingMessage}</p></div>`;
  // Exam content is public, so start downloading it now instead of after sign-in and sync.
  const examPage = initialSlug && initialSlug !== 'account';
  const bankFiles = examPage ? fetchBank(initialSlug) : null;
  bankFiles?.catch(() => { /* reported by loadBank below */ });
  const learnFiles = examPage ? Learn.loadLearn(initialSlug) : null;
  if (!examPage) fetchIndex().catch(() => {});
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
    await loadBank(slug, slug === initialSlug ? bankFiles : undefined);
  } catch (err) {
    $('main').innerHTML = `<div class="panel empty"><p>Couldn't load the "${slug}" exam (${err.message}).</p>
      <a class="btn btn-primary" href="/">All exams</a></div>`;
    $('navigator').hidden = true;
    return;
  }
  logView(slug);
  document.title = `${EXAM.code} · IT Learn & Practice`;
  document.body.dataset.vendor = vendorKey(EXAM.vendor);
  $('brand-title').textContent = 'IT Learn & Practice';
  $('brand-sub').textContent = `${EXAM.code} · ${EXAM.name}`;
  LEARN = await (slug === initialSlug ? learnFiles : Learn.loadLearn(slug));
  if (initialMode === 'learn' && LEARN) state.mode = 'learn';
  $('btn-mode-learn').hidden = !LEARN;
  $('mode-tabs').hidden = false;
  $('btn-drawer').hidden = false;
  const perDomain = {};
  for (const q of QUESTIONS) perDomain[q.domain] = (perDomain[q.domain] || 0) + 1;
  $('domain-filter').innerHTML = `<option value="ALL">All domains (${QUESTIONS.length})</option>` +
    Object.entries(DOMAINS).map(([k, d], i) => `<option value="${k}">${i + 1}. ${d.name} (${perDomain[k] || 0})</option>`).join('');
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

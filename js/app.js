import { DOMAINS } from './domains.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const MINUTES_PER_QUESTION = 2;   // the real exam is ~100 min for 40–60 questions
const DEFAULT_EXAM_SIZE = 50;
const PASS_MARK = 700;
const STORAGE_KEY = 'az104-sim:v2';
let QUESTIONS = [];                // loaded from data/questions.json
let BY_ID = new Map();
const examMinutes = (n) => Math.max(5, Math.round(n * MINUTES_PER_QUESTION));
const LETTERS = 'ABCDEFGH';

// ─────────────────────────────────────────────────────────────────────────────
// State (persisted to localStorage so a refresh never loses progress)
// ─────────────────────────────────────────────────────────────────────────────
const defaultState = () => ({
  mode: 'practice',          // 'practice' | 'exam' | 'review'
  practice: { answers: {}, flagged: [], optionOrder: {}, domain: 'ALL', status: 'all', index: 0 },
  exam: null,                // { order, optionOrder, answers, flagged, endsAt, index, result }
  review: null,              // { ids, index, source }
  history: [],               // [{ at, score, correct, total, passed }]
  examSize: DEFAULT_EXAM_SIZE,
  seen: {},                  // id -> times served in an exam (to rotate through big banks)
});

let state = load();
let timerHandle = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.practice) return { ...defaultState(), ...saved };
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return defaultState();
}

let saveQueued = false;
function save() {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore quota/private mode */ }
  });
}

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
  return { ids: practiceIds(), store: state.practice, locked: false, reveal: true, holder: state.practice };
}

function practiceIds() {
  const p = state.practice;
  return QUESTIONS.filter((q) => {
    if (p.domain !== 'ALL' && q.domain !== p.domain) return false;
    const a = p.answers[q.id];
    switch (p.status) {
      case 'unanswered': return a === undefined;
      case 'incorrect': return a !== undefined && !isCorrect(q, a);
      case 'flagged': return p.flagged.includes(q.id);
      default: return true;
    }
  }).map((q) => q.id);
}

function currentHolder(s) { return s.holder || s.store; }

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  renderModeTabs();
  renderTimer();

  const main = $('main');
  $('practice-filters').hidden = state.mode !== 'practice';
  $('practice-stats').hidden = state.mode !== 'practice';
  $('btn-reset-practice').hidden = state.mode !== 'practice';

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
  $('btn-mode-practice').setAttribute('aria-selected', String(!examTab));
  $('btn-mode-exam').setAttribute('aria-selected', String(examTab));
  $('bank-size').textContent = QUESTIONS.length;
}

function renderGrid(s) {
  $('navigator').hidden = false;
  const holder = currentHolder(s);
  const flagged = new Set(s.store.flagged);
  let answered = 0;
  const html = s.ids.map((id, i) => {
    const q = BY_ID.get(id);
    const a = s.store.answers[id];
    const cls = ['qbtn'];
    if (a !== undefined) {
      answered++;
      if (s.reveal) cls.push(isCorrect(q, a) ? 'correct' : 'wrong');
      else cls.push('answered');
    }
    if (flagged.has(id)) cls.push('flagged');
    if (i === holder.index) cls.push('current');
    const label = `Question ${i + 1}${a !== undefined ? ', answered' : ''}${flagged.has(id) ? ', flagged' : ''}`;
    return `<button class="${cls.join(' ')}" data-jump="${i}" aria-label="${label}"${i === holder.index ? ' aria-current="true"' : ''}>${i + 1}</button>`;
  }).join('');
  $('question-grid').innerHTML = html;
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
    <div><b class="${pct >= 70 ? 'good' : answeredIds.length ? 'weak' : ''}">${pct}%</b><span class="muted">accuracy</span></div>`;
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
    ? `<span class="chip chip-review">Review · ${state.review.source === 'missed' ? 'missed questions' : 'all questions'}</span>` : '';

  const primary = state.mode === 'exam'
    ? `<button class="btn btn-success" data-action="submit">${icon('check')}Submit exam</button>`
    : state.mode === 'review'
      ? `<button class="btn btn-ghost" data-action="back-to-results">Back to results</button>` : '';

  main.innerHTML = `
    <article class="panel qcard">
      <div class="qhead">
        <div class="chips">
          <span class="chip chip-azure">Question ${index + 1} of ${s.ids.length}</span>
          ${state.mode !== 'exam' ? `<span class="chip">${DOMAINS[q.domain].name}</span>` : ''}
          ${modeChip}
        </div>
        ${s.locked ? '' : `<button class="btn btn-ghost btn-sm ${flagged ? 'active' : ''}" data-action="flag" aria-pressed="${flagged}">
          ${icon('flag')}${flagged ? 'Flagged' : 'Flag for review'}</button>`}
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
      <div class="kbd-hint"><kbd>A</kbd>–<kbd>D</kbd> answer · <kbd>←</kbd> <kbd>→</kbd> navigate · <kbd>F</kbd> flag</div>
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
        <h2>Timed exam</h2>
        <p class="muted">A full-length run under exam conditions. Questions and answer options are shuffled, and answers are only revealed after you submit.</p>
      </div>
      <div class="facts">
        <div class="fact"><b>${QUESTIONS.length}</b><span class="muted small">questions in the bank</span></div>
        <div class="fact"><b id="exam-minutes">${examMinutes(examSize())} min</b><span class="muted small">time limit</span></div>
        <div class="fact"><b>${PASS_MARK}</b><span class="muted small">passing score (of 1000)</span></div>
        ${last ? `<div class="fact"><b class="${last.passed ? 'good' : 'weak'}">${last.score}</b><span class="muted small">last attempt</span></div>` : ''}
      </div>
      <ul class="rules">
        <li>The real exam has 40–60 questions in 100 minutes; 50 questions here gets you the same pace.</li>
        <li>The timer keeps running if you refresh or close the tab.</li>
        <li>Flag questions to come back to them from the navigator.</li>
        <li>The exam submits automatically when time runs out.</li>
      </ul>
      <div class="exam-size">
        <label for="exam-size">Number of questions</label>
        <div class="size-row">
          ${[20, 40, 50, 60].filter((n) => n <= QUESTIONS.length).map((n) =>
            `<button class="btn btn-ghost btn-sm ${n === examSize() ? 'active-size' : ''}" data-size="${n}">${n}</button>`).join('')}
          <input id="exam-size" type="number" min="1" max="${QUESTIONS.length}" value="${examSize()}" inputmode="numeric">
          <span class="muted small">of ${QUESTIONS.length} · ${MINUTES_PER_QUESTION} min per question</span>
        </div>
        <p class="muted small">Questions are picked in proportion to the AZ-104 domain weights, favoring ones you've seen least.</p>
      </div>
      <div><button class="btn btn-primary" data-action="start-exam">${icon('play')}Start exam</button></div>
      ${historyTable()}
    </section>`;
}

function renderGridEmpty() {
  $('navigator').hidden = true;
  $('question-grid').innerHTML = '';
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
      <div class="bar"><i class="${tone}" style="width:${pct}%"></i></div></div>`;
  }).join('');
  const missed = r.total - r.correct;

  main.innerHTML = `
    <section class="panel card-pad stack">
      <div class="score-banner ${r.passed ? 'pass' : 'fail'}">
        <span class="status-pill">${r.passed ? 'PASSED' : 'NOT PASSED'}</span>
        <h2>${r.score} / 1000</h2>
        <p class="muted">${r.correct} of ${r.total} correct · ${r.timedOut ? 'time expired' : `finished in ${fmtTime(r.elapsed)}`}</p>
        <p class="small muted">Score is a straight percentage scaled to 1000. Microsoft's real scoring is scaled differently, so treat ${PASS_MARK}+ as a readiness signal, not a guarantee.</p>
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
        <button class="btn btn-primary" data-action="start-exam">${icon('redo')}Retake exam</button>
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
  if (mode === 'practice' && state.mode === 'exam' && state.exam && !state.exam.result) {
    // The exam keeps running in the background; just switch the view.
    toast('Your exam is still running — switch back to Exam to continue.');
  }
  if (mode === 'exam' && state.mode === 'review') { state.mode = 'exam'; save(); return render(); }
  state.mode = mode;
  save(); render();
}

function examSize() {
  return Math.min(Math.max(1, state.examSize || DEFAULT_EXAM_SIZE), QUESTIONS.length);
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
    if (isCorrect(q, ex.answers[id])) { correct++; domains[q.domain].correct++; }
  }
  const total = ex.order.length;
  const score = Math.round((correct / total) * 1000);
  const elapsed = Math.min((ex.minutes || 100) * 60, Math.round((Date.now() - ex.startedAt) / 1000));
  ex.result = { correct, total, score, passed: score >= PASS_MARK, domains, timedOut, elapsed };
  state.history.unshift({ at: Date.now(), score, correct, total, passed: score >= PASS_MARK });
  state.history = state.history.slice(0, 20);
  state.mode = 'exam';
  stopTimer();
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
  const ok = await confirmModal('Reset practice progress?', 'This clears your practice answers and flags. Exam history is kept.', 'Reset', 'Cancel');
  if (!ok) return;
  state.practice = defaultState().practice;
  syncFilterControls();
  save(); render();
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
  $('modal-ok').focus();
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
}

async function loadBank() {
  const res = await fetch('/data/questions.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  QUESTIONS = await res.json();
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
  if (state.mode === 'review' && !state.review?.ids.length) state.mode = 'exam';
}

async function init() {
  try {
    await loadBank();
  } catch (err) {
    $('main').innerHTML = `<div class="panel empty"><p>Couldn't load the question bank (${err.message}).</p>
      <button class="btn btn-primary" id="btn-retry">Retry</button></div>`;
    $('btn-retry').addEventListener('click', () => location.reload());
    return;
  }
  $('domain-filter').innerHTML = `<option value="ALL">All domains (${QUESTIONS.length})</option>` +
    Object.entries(DOMAINS).map(([k, d], i) => {
      const n = QUESTIONS.filter((q) => q.domain === k).length;
      return `<option value="${k}">${i + 1}. ${d.name} (${n})</option>`;
    }).join('');
  syncFilterControls();

  $('domain-filter').addEventListener('change', (e) => { state.practice.domain = e.target.value; state.practice.index = 0; save(); render(); });
  $('status-filter').addEventListener('change', (e) => { state.practice.status = e.target.value; state.practice.index = 0; save(); render(); });
  $('btn-reset-practice').addEventListener('click', resetPractice);
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
      case 'review-missed': return startReview('missed');
      case 'review-all': return startReview('all');
      case 'back-to-results': state.mode = 'exam'; save(); return render();
      case 'clear-filters':
        state.practice.domain = 'ALL'; state.practice.status = 'all';
        syncFilterControls(); save(); return render();
    }
  });

  $('main').addEventListener('change', (e) => {
    if (e.target.id !== 'exam-size') return;
    const n = Math.round(Number(e.target.value));
    state.examSize = Number.isFinite(n) && n > 0 ? Math.min(n, QUESTIONS.length) : DEFAULT_EXAM_SIZE;
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
      const pos = 'abcd'.indexOf(key) >= 0 ? 'abcd'.indexOf(key) : '1234'.indexOf(key);
      if (pos >= 0) quiz.querySelectorAll('[data-option]')[pos]?.click();
    }
  });

  // Re-check the timer when the tab becomes visible again (background tabs throttle intervals).
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderTimer(); });

  // An exam that expired while the page was closed is submitted on load.
  if (state.exam && !state.exam.result && Date.now() >= state.exam.endsAt) {
    finishExam(true);
    toast('Your previous exam ran out of time and was submitted.');
  }
  render();
}

init();

// Learn tab: per-domain modules with a study guide, a slideshow and a narrated video lesson.
// Content comes from /exams/<slug>/learn.json. AZ-104 uses prerecorded narration;
// other courses can use browser speech synthesis until recordings are available.

const $ = (id) => document.getElementById(id);
const esc = (t = '') => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let ctx = null;      // { exam, state, save, practiceDomain }
let data = null;     // learn.json
let learnSlug = null;
let player = null;   // active video player
let keyHandler = null;

export async function loadLearn(slug) {
  learnSlug = slug;
  try {
    const res = await fetch(`/exams/${slug}/learn.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    data = await res.json();
    return data?.modules?.length ? data : null;
  } catch { return null; }
}

const view = () => (ctx.state.learn ||= { progress: {}, view: { module: null, tab: 'guide', slide: 0 } });
const progressOf = (id) => (view().progress[id] ||= {});
const moduleById = (id) => data.modules.find((m) => m.id === id);
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const scriptOf = (slide) => slide.script || [];
const minutesOf = (m) => Math.max(1, Math.round(m.slides.reduce((n, s) => n + words(scriptOf(s).join(' ')), 0) / 150));

function mark(id, part) {
  const p = progressOf(id);
  if (p[part]) return;
  p[part] = Date.now();
  ctx.save();
}

export function stopLearn() {
  player?.destroy(); player = null;
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
}

export function renderLearn(main, context) {
  ctx = context;
  stopLearn();
  const v = view().view;
  if (v.module && !moduleById(v.module)) v.module = null;
  if (!v.module) return renderIndex(main);
  return renderModule(main, moduleById(v.module));
}

function open(moduleId, tab = 'guide') {
  const v = view().view;
  v.module = moduleId; v.tab = tab; v.slide = 0;
  ctx.save();
  renderLearn($('main'), ctx);
  window.scrollTo({ top: 0 });
}

function studySupport() {
  const resources = [...(data.resources || []), ...(data.sources || [])];
  const unique = [...new Map(resources.filter((r) => r?.url && r?.title).map((r) => [r.url, r])).values()];
  return `<aside class="learn-study-support" aria-label="Study scope and free supplemental resources">
    <div class="learn-study-disclaimer">
      <span class="learn-support-label">Study scope</span>
      <p>These materials provide a basic introduction across every published exam domain, but they are not exhaustive and do not guarantee exam readiness. Use the current official objectives, the free resources below, and hands-on practice where applicable.</p>
    </div>
    ${unique.length ? `<div class="learn-support-resources">
      <h3>Free supplemental resources</h3>
      <ul>${unique.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a><span>${esc(r.note || 'Free')}</span></li>`).join('')}</ul>
    </div>` : ''}
  </aside>`;
}

// ── Module list ──────────────────────────────────────────────────────────────
function renderIndex(main) {
  const done = (p) => ['guide', 'slides', 'video'].filter((k) => p[k]).length;
  const cards = data.modules.map((m, i) => {
    const p = progressOf(m.id); const n = done(p);
    const dom = ctx.exam.domains?.[m.id];
    return `<article class="panel learn-card">
      <div class="learn-card-head"><span class="learn-num">${i + 1}</span>
        <div><h3>${esc(m.title)}</h3>${dom ? `<span class="muted small">${esc(dom.weight)} of the exam</span>` : ''}</div></div>
      <p class="muted">${esc(m.summary)}</p>
      <div class="learn-parts">
        ${part(m.id, 'guide', 'book', 'Study guide', `${Math.max(1, Math.round(words(m.guide.map((s) => s.html.replace(/<[^>]+>/g, ' ')).join(' ')) / 200))} min read`, p.guide)}
        ${part(m.id, 'slides', 'grid', 'Slides', `${m.slides.length} slides`, p.slides)}
        ${part(m.id, 'video', 'play', 'Video lesson', `~${minutesOf(m)} min`, p.video)}
      </div>
      <div class="learn-meter" title="${n} of 3 complete"><i style="width:${(n / 3) * 100}%"></i></div>
    </article>`;
  }).join('');
  main.innerHTML = `<section class="stack learn">
      <div class="stack" style="gap:6px"><h2 class="home-title">Learn ${esc(ctx.exam.code)}</h2>
      <p class="muted">${esc(data.intro || 'Work through each domain: read the study guide, flip through the slides, then watch the video lesson.')}</p></div>
      ${studySupport()}
      <div class="learn-grid">${cards}</div>
    </section>`;
  main.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => open(b.dataset.open, b.dataset.tab)));
}

const part = (id, tab, ic, label, meta, isDone) =>
  `<button class="learn-part ${isDone ? 'done' : ''}" data-open="${id}" data-tab="${tab}">
    ${icon(isDone ? 'check' : ic)}<span><b>${label}</b><span class="muted small">${meta}</span></span></button>`;

// ── Module view ──────────────────────────────────────────────────────────────
function renderModule(main, m) {
  const v = view().view;
  const idx = data.modules.indexOf(m);
  const p = progressOf(m.id);
  const tabs = [['guide', 'Study guide', 'book'], ['slides', 'Slides', 'grid'], ['video', 'Video lesson', 'play']];
  main.innerHTML = `<section class="stack learn">
      <div class="learn-crumbs"><button class="btn btn-ghost btn-sm" data-back>${icon('left')}All modules</button>
        <span class="muted small">Module ${idx + 1} of ${data.modules.length}</span></div>
      <div class="stack" style="gap:6px"><h2 class="home-title">${esc(m.title)}</h2><p class="muted">${esc(m.summary)}</p></div>
      ${studySupport()}
      <div class="learn-tabs" role="tablist">${tabs.map(([k, label, ic]) =>
        `<button role="tab" aria-selected="${v.tab === k}" data-tab="${k}">${icon(p[k] ? 'check' : ic)}<span>${label}</span></button>`).join('')}</div>
      <div id="learn-body"></div>
      <div class="learn-next">
        ${idx > 0 ? `<button class="btn btn-ghost" data-goto="${data.modules[idx - 1].id}">${icon('left')}${esc(data.modules[idx - 1].short || 'Previous module')}</button>` : '<span></span>'}
        ${idx < data.modules.length - 1 ? `<button class="btn btn-ghost" data-goto="${data.modules[idx + 1].id}">${esc(data.modules[idx + 1].short || 'Next module')}${icon('right')}</button>` : ''}
      </div>
    </section>`;
  main.querySelector('[data-back]').addEventListener('click', () => { stopLearn(); v.module = null; ctx.save(); renderLearn(main, ctx); });
  main.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => open(b.dataset.goto, v.tab)));
  main.querySelectorAll('.learn-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
    stopLearn(); v.tab = b.dataset.tab; ctx.save(); renderModule(main, m);
  }));
  const body = $('learn-body');
  if (v.tab === 'slides') renderSlides(body, m);
  else if (v.tab === 'video') renderVideo(body, m);
  else renderGuide(body, m);
}

// ── Study guide ──────────────────────────────────────────────────────────────
function renderGuide(body, m) {
  const p = progressOf(m.id);
  const slug = (t, i) => `g-${m.id}-${i}`;
  body.innerHTML = `<div class="guide-layout">
      <nav class="panel guide-toc" aria-label="Contents"><b class="small">Contents</b>
        <ol>${m.guide.map((s, i) => `<li><a href="#${slug(s.h, i)}">${esc(s.h)}</a></li>`).join('')}</ol></nav>
      <article class="panel card-pad guide">
        ${m.guide.map((s, i) => `<section id="${slug(s.h, i)}"><h3>${esc(s.h)}</h3>${s.html}</section>`).join('')}
        ${m.tips?.length ? `<section class="guide-tips"><h3>${icon('bulb')}Exam tips</h3><ul>${m.tips.map((t) => `<li>${t}</li>`).join('')}</ul></section>` : ''}
        ${m.terms?.length ? `<section><h3>Key terms</h3><dl class="guide-terms">${m.terms.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${d}</dd>`).join('')}</dl></section>` : ''}
        <div class="guide-actions">
          <button class="btn ${p.guide ? 'btn-ghost' : 'btn-primary'}" data-done>${icon('check')}${p.guide ? 'Completed' : 'Mark as complete'}</button>
          <button class="btn btn-ghost" data-practice>${icon('book')}Practice ${esc(m.short || 'this domain')} questions</button>
        </div>
      </article></div>`;
  body.querySelector('[data-done]').addEventListener('click', (e) => {
    mark(m.id, 'guide'); e.currentTarget.className = 'btn btn-ghost'; e.currentTarget.innerHTML = `${icon('check')}Completed`;
  });
  body.querySelector('[data-practice]').addEventListener('click', () => { stopLearn(); ctx.practiceDomain(m.id); });
  body.querySelectorAll('.guide-toc a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// ── Slide rendering (shared by the slideshow and the video) ──────────────────
function visual(v) {
  if (!v) return '';
  switch (v.type) {
    case 'flow':
      return `<div class="vis vis-flow">${v.steps.map((s, i) => `${i ? '<span class="vis-arrow" aria-hidden="true">→</span>' : ''}
        <div class="vis-box"><b>${esc(s.t)}</b>${s.d ? `<span>${esc(s.d)}</span>` : ''}</div>`).join('')}</div>`;
    case 'tree':
      return `<div class="vis vis-tree">${v.levels.map((row, i) => `<div class="vis-row">${row.map((t) =>
        `<div class="vis-box ${i === 0 ? 'root' : ''}">${esc(t)}</div>`).join('')}</div>`).join('<div class="vis-link" aria-hidden="true"></div>')}</div>`;
    case 'cards':
      return `<div class="vis vis-cards">${v.items.map((s) => `<div class="vis-box"><b>${esc(s.t)}</b>${s.d ? `<span>${esc(s.d)}</span>` : ''}</div>`).join('')}</div>`;
    case 'table':
      return `<div class="vis vis-table"><table><thead><tr>${v.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${v.rows.map((r) => `<tr>${r.map((c, i) => i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    case 'code':
      return `<div class="vis vis-code"><span class="vis-lang">${esc(v.lang || '')}</span><pre><code>${esc(v.text)}</code></pre></div>`;
    case 'layers':
      return `<div class="vis vis-layers">${v.items.map((s) => `<div class="vis-box"><b>${esc(s.t)}</b>${s.d ? `<span>${esc(s.d)}</span>` : ''}</div>`).join('')}</div>`;
    default: return '';
  }
}

function slideHtml(m, s, i, revealUpTo = Infinity) {
  const isTitle = s.layout === 'title';
  return `<div class="slide ${isTitle ? 'slide-title' : ''} ${s.visual ? 'has-visual' : ''}">
      <div class="slide-head"><span class="slide-kicker">${esc(s.kicker || (isTitle ? ctx.exam.code : m.short || ''))}</span>
        <h3>${esc(s.title)}</h3></div>
      <div class="slide-body">
        ${s.bullets?.length ? `<ul class="slide-bullets">${s.bullets.map((b, j) => `<li class="${j < revealUpTo ? 'in' : ''}">${b}</li>`).join('')}</ul>` : ''}
        ${visual(s.visual)}
      </div>
      <span class="slide-foot">${esc(ctx.exam.code)} · ${esc(m.short || m.title)}<span>${i + 1}</span></span>
    </div>`;
}

// ── Slideshow ────────────────────────────────────────────────────────────────
function renderSlides(body, m) {
  const v = view().view;
  v.slide = Math.min(Math.max(v.slide || 0, 0), m.slides.length - 1);
  const draw = () => {
    const i = v.slide; const s = m.slides[i];
    body.innerHTML = `<div class="deck">
        <div class="stage" id="deck-stage">${slideHtml(m, s, i)}</div>
        <div class="deck-bar">
          <button class="icon-btn" data-prev aria-label="Previous slide" ${i === 0 ? 'disabled' : ''}>${icon('left')}</button>
          <span class="mono small">${i + 1} / ${m.slides.length}</span>
          <button class="icon-btn" data-next aria-label="Next slide" ${i === m.slides.length - 1 ? 'disabled' : ''}>${icon('right')}</button>
          <span class="deck-spacer"></span>
          <button class="btn btn-ghost btn-sm" data-notes aria-pressed="${!!v.notes}">Speaker notes</button>
          <button class="btn btn-ghost btn-sm" data-full>Full screen</button>
        </div>
        <div class="deck-dots">${m.slides.map((_, j) => `<button class="${j === i ? 'on' : ''}" data-dot="${j}" aria-label="Slide ${j + 1}"></button>`).join('')}</div>
        ${v.notes ? `<div class="panel card-pad deck-notes small">${scriptOf(s).map(esc).join(' ') || '<span class="muted">No notes for this slide.</span>'}</div>` : ''}
        <p class="muted small">Use ← and → to move between slides.</p>
      </div>`;
    if (i === m.slides.length - 1) mark(m.id, 'slides');
    body.querySelector('[data-prev]').onclick = () => go(-1);
    body.querySelector('[data-next]').onclick = () => go(1);
    body.querySelector('[data-notes]').onclick = () => { v.notes = !v.notes; ctx.save(); draw(); };
    body.querySelector('[data-full]').onclick = () => fullscreen($('deck-stage'));
    body.querySelectorAll('[data-dot]').forEach((b) => (b.onclick = () => { v.slide = Number(b.dataset.dot); ctx.save(); draw(); }));
  };
  const go = (d) => {
    const n = Math.min(Math.max(v.slide + d, 0), m.slides.length - 1);
    if (n !== v.slide) { v.slide = n; ctx.save(); draw(); }
  };
  keyHandler = (e) => {
    if (e.target.closest('input, select, textarea') || $('modal').open) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
  };
  document.addEventListener('keydown', keyHandler);
  draw();
}

function fullscreen(el) {
  if (document.fullscreenElement) return document.exitFullscreen();
  el.requestFullscreen?.().catch(() => {});
}

// ── Video lesson (narrated) ──────────────────────────────────────────────────
const VOICE_KEY = 'examsim:voice';
const RATE_KEY = 'examsim:rate';
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, val) => { try { localStorage.setItem(k, val); } catch { /* ignore */ } };

function englishVoices() {
  const all = window.speechSynthesis?.getVoices?.() || [];
  const en = all.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const score = (v) => (/natural|neural|online/i.test(v.name) ? 3 : 0) + (/google|samantha|aria|jenny|guy|daniel/i.test(v.name) ? 2 : 0) + (/en-US/i.test(v.lang) ? 1 : 0);
  return en.sort((a, b) => score(b) - score(a));
}

function renderVideo(body, m) {
  const scenes = m.slides.map((s) => ({ slide: s, lines: scriptOf(s).length ? scriptOf(s) : [s.title] }));
  const total = scenes.reduce((n, s) => n + s.lines.length, 0);
  const prerecorded = learnSlug === 'az-104';
  const tts = !prerecorded && 'speechSynthesis' in window;
  body.innerHTML = `<div class="video">
      <div class="stage video-stage" id="video-stage">
        <div id="video-slide"></div>
        <div class="video-caption" id="video-caption" aria-live="polite"></div>
        <button class="video-big-play" id="video-big" aria-label="Play lesson">${icon('play')}</button>
      </div>
      <div class="video-progress" id="video-progress" role="slider" aria-label="Lesson position" tabindex="0">${scenes.map((s) =>
        `<span style="flex:${s.lines.length}"><i></i></span>`).join('')}</div>
      <div class="deck-bar">
        <button class="icon-btn" id="v-prev" aria-label="Previous scene">${icon('left')}</button>
        <button class="btn btn-primary btn-sm" id="v-play">${icon('play')}<span>Play</span></button>
        <button class="icon-btn" id="v-next" aria-label="Next scene">${icon('right')}</button>
        <span class="mono small" id="v-time"></span>
        <span class="deck-spacer"></span>
        <button class="btn btn-ghost btn-sm" id="v-cc" aria-pressed="true">CC</button>
        <label class="small muted v-ctl">Speed <select id="v-rate">${[0.8, 1, 1.15, 1.3, 1.5].map((r) => `<option value="${r}">${r}×</option>`).join('')}</select></label>
        ${tts ? '<label class="small muted v-ctl">Voice <select id="v-voice"></select></label>' : ''}
        <button class="btn btn-ghost btn-sm" id="v-full">Full screen</button>
      </div>
      ${prerecorded ? '<p class="muted small">Narration: Andrew (standard Neural). Captions follow the narration; use the timeline to move between slides.</p>' : tts ? '' : '<p class="muted small">Your browser can\'t read text aloud, so this lesson plays with captions only.</p>'}
    </div>`;

  const st = { scene: 0, line: 0, playing: false, token: 0, cc: true, rate: Number(pref(RATE_KEY, '1')) || 1 };
  const el = { slide: $('video-slide'), cap: $('video-caption'), prog: $('video-progress'), play: $('v-play'), big: $('video-big'), time: $('v-time') };
  const audio = prerecorded ? new Audio(`/exams/${learnSlug}/media/${encodeURIComponent(m.id)}.mp3`) : null;
  if (audio) audio.preload = 'metadata';
  $('v-rate').value = String(st.rate);
  let timer = null;

  const fillVoices = () => {
    const sel = $('v-voice'); if (!sel) return;
    const voices = englishVoices();
    const saved = pref(VOICE_KEY, '');
    sel.innerHTML = voices.length ? voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name.replace(/^Microsoft |^Google /, ''))}</option>`).join('') : '<option value="">Default</option>';
    if (saved && voices.some((v) => v.name === saved)) sel.value = saved;
  };
  if (tts) { fillVoices(); window.speechSynthesis.onvoiceschanged = fillVoices; }

  const pos = () => scenes.slice(0, st.scene).reduce((n, s) => n + s.lines.length, 0) + st.line;
  const segments = scenes.flatMap((scene, sceneIndex) => scene.lines.map((text, lineIndex) => ({
    scene: sceneIndex, line: lineIndex, text, weight: Math.max(1, words(text)),
  })));
  const totalWeight = segments.reduce((n, segment) => n + segment.weight, 0);
  const weightBeforeScene = (sceneIndex) => segments.filter((segment) => segment.scene < sceneIndex)
    .reduce((n, segment) => n + segment.weight, 0);
  const syncAudio = () => {
    if (!audio?.duration || !Number.isFinite(audio.duration)) return;
    const target = Math.min(totalWeight - 1, (audio.currentTime / audio.duration) * totalWeight);
    let elapsed = 0;
    const segment = segments.find((item) => {
      elapsed += item.weight;
      return target < elapsed;
    }) || segments[segments.length - 1];
    const changed = segment.scene !== st.scene || segment.line !== st.line;
    st.scene = segment.scene; st.line = segment.line;
    el.cap.textContent = segment.text;
    if (changed) drawSlide();
    drawChrome();
  };
  const drawSlide = () => {
    const sc = scenes[st.scene]; const b = sc.slide.bullets?.length || 0;
    const reveal = b ? Math.ceil(((st.line + 1) / sc.lines.length) * b) : 0;
    el.slide.innerHTML = slideHtml(m, sc.slide, st.scene, st.playing || st.line ? reveal : b);
  };
  const drawChrome = () => {
    const done = pos();
    el.prog.querySelectorAll('span').forEach((span, i) => {
      const n = scenes[i].lines.length;
      const fill = i < st.scene ? 1 : i > st.scene ? 0 : st.line / n;
      span.querySelector('i').style.width = `${fill * 100}%`;
      span.classList.toggle('current', i === st.scene);
    });
    el.time.textContent = `Scene ${st.scene + 1} / ${scenes.length}`;
    el.play.innerHTML = st.playing ? `${icon('pause')}<span>Pause</span>` : `${icon('play')}<span>${done >= total ? 'Replay' : done ? 'Resume' : 'Play'}</span>`;
    el.big.hidden = st.playing;
    el.cap.hidden = !st.cc || !el.cap.textContent;
  };
  const speakLine = () => {
    const token = ++st.token;
    const sc = scenes[st.scene]; const text = sc.lines[st.line];
    el.cap.textContent = text; drawSlide(); drawChrome();
    const t0 = Date.now();
    const expected = (words(text) / 2.6 / st.rate) * 1000;
    const after = () => { if (token === st.token && st.playing) advance(); };
    // If the engine finishes far too fast (no voice installed, muted engine), keep the
    // caption on screen for a readable length of time instead of racing ahead.
    const afterSpeech = () => {
      const rest = Math.max(2200, expected * 0.6) - (Date.now() - t0);
      if (rest > 0) { clearTimeout(timer); timer = setTimeout(after, rest); } else after();
    };
    if (tts && !st.silent) {
      const u = new SpeechSynthesisUtterance(text);
      const voice = englishVoices().find((v) => v.name === ($('v-voice')?.value || ''));
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
      u.rate = st.rate;
      u.onend = afterSpeech;
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        st.silent = true; // stop trying to speak; continue with captions only
        afterSpeech();
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      // Safety net: some engines never fire onend.
      clearTimeout(timer);
      timer = setTimeout(after, (words(text) / 2.2 / st.rate) * 1000 + 4000);
    } else {
      clearTimeout(timer);
      timer = setTimeout(after, Math.max(2200, expected));
    }
  };
  const advance = () => {
    clearTimeout(timer);
    const sc = scenes[st.scene];
    if (st.line < sc.lines.length - 1) st.line += 1;
    else if (st.scene < scenes.length - 1) { st.scene += 1; st.line = 0; }
    else { stop(); st.line = sc.lines.length; mark(m.id, 'video'); el.cap.textContent = ''; drawSlide(); drawChrome(); return; }
    speakLine();
  };
  const play = () => {
    if (audio) {
      if (audio.ended) audio.currentTime = 0;
      st.playing = true;
      audio.playbackRate = st.rate;
      audio.play().then(syncAudio).catch(() => {
        st.playing = false;
        el.cap.textContent = 'Narration audio could not be played. Check the MP3 file and reload the lesson.';
        drawChrome();
      });
      syncAudio(); drawChrome();
      return;
    }
    if (pos() >= total) { st.scene = 0; st.line = 0; }
    st.playing = true; speakLine();
  };
  const stop = () => {
    st.playing = false; st.token += 1; clearTimeout(timer);
    if (audio) audio.pause();
    else if (tts) window.speechSynthesis.cancel();
    drawChrome();
  };
  const seek = (scene) => {
    const was = st.playing; stop();
    st.scene = Math.min(Math.max(scene, 0), scenes.length - 1); st.line = 0;
    if (audio?.duration && Number.isFinite(audio.duration)) {
      audio.currentTime = (weightBeforeScene(st.scene) / totalWeight) * audio.duration;
      el.cap.textContent = scenes[st.scene].lines[0];
      if (was) play(); else { drawSlide(); drawChrome(); }
      return;
    }
    el.cap.textContent = scenes[st.scene].lines[0];
    if (was) play(); else { drawSlide(); drawChrome(); }
  };

  if (audio) {
    audio.addEventListener('timeupdate', syncAudio);
    audio.addEventListener('ended', () => {
      st.playing = false;
      st.scene = scenes.length - 1;
      st.line = scenes[scenes.length - 1].lines.length - 1;
      el.cap.textContent = '';
      mark(m.id, 'video'); drawSlide(); drawChrome();
    });
    audio.addEventListener('error', () => {
      st.playing = false;
      el.cap.textContent = 'Narration audio could not be loaded. Check the MP3 file and reload the lesson.';
      drawChrome();
    });
  }

  el.play.onclick = () => (st.playing ? stop() : play());
  el.big.onclick = play;
  $('v-prev').onclick = () => seek(st.scene - 1);
  $('v-next').onclick = () => seek(st.scene + 1);
  $('v-cc').onclick = (e) => { st.cc = !st.cc; e.currentTarget.setAttribute('aria-pressed', String(st.cc)); drawChrome(); };
  $('v-rate').onchange = (e) => {
    st.rate = Number(e.target.value); setPref(RATE_KEY, e.target.value);
    if (audio) audio.playbackRate = st.rate;
    else if (st.playing) speakLine();
  };
  $('v-voice')?.addEventListener('change', (e) => { setPref(VOICE_KEY, e.target.value); if (st.playing) speakLine(); });
  $('v-full').onclick = () => fullscreen($('video-stage'));
  el.prog.addEventListener('click', (e) => {
    const span = e.target.closest('span'); if (!span) return;
    seek([...el.prog.children].indexOf(span));
  });
  el.prog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') seek(st.scene + 1);
    if (e.key === 'ArrowLeft') seek(st.scene - 1);
  });
  keyHandler = (e) => {
    if (e.target.closest('input, select, textarea, button') || $('modal').open) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); el.play.click(); }
    if (e.key === 'ArrowRight') seek(st.scene + 1);
    if (e.key === 'ArrowLeft') seek(st.scene - 1);
  };
  document.addEventListener('keydown', keyHandler);

  player = { destroy: () => { stop(); if (tts) window.speechSynthesis.onvoiceschanged = null; } };
  drawSlide(); drawChrome();
}

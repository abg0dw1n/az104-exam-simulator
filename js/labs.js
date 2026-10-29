// Labs tab: hands-on simulations graded in the browser. Content comes from
// /exams/<slug>/labs.json. Three kinds:
//   cli    - simulated Cisco IOS devices and/or a Windows command prompt on a modeled network
//   tasks  - performance-based activities: match, order, fill-in, firewall rules
//   portal - a generic admin web console (home router, wireless controller, cloud console)
// Each lab lists tasks with machine-checkable conditions; "Check my work" grades the current state.
import { Net, newIos, canonIf, ip2n, isIp, maskBits, vlanSet } from './labs-net.js';
import { IosSession } from './labs-ios.js';
import { newWin, WinSession } from './labs-win.js';

const $ = (id) => document.getElementById(id);
const esc = (t = '') => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const KIND = { cli: ['Command line', 'terminal'], tasks: ['Configure and arrange', 'grid'], portal: ['Admin console', 'window'] };

let ctx = null;   // { exam, state, save, guest, guestCta }
let data = null;  // labs.json
let live = null;  // { lab, sessions, net, el } for the open lab

export async function loadLabs(slug) {
  try {
    const res = await fetch(`/exams/${slug}/labs.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    data = await res.json();
    return data?.labs?.length ? data : null;
  } catch { return null; }
}
export function stopLabs() { live = null; }

const store = () => (ctx.state.labs ||= { view: { lab: null }, results: {}, work: {} });
const labById = (id) => data.labs.find((l) => l.id === id);
export const labSummary = (saved, total) => {
  const r = saved?.labs?.results || {};
  return { done: Object.values(r).filter((x) => x.done).length, total, started: Object.keys(saved?.labs?.work || {}).length + Object.keys(r).length };
};

export function renderLabs(main, context) {
  ctx = context; live = null;
  if (ctx.guest) return renderLocked(main);
  const v = store().view;
  if (v.lab && !labById(v.lab)) v.lab = null;
  return v.lab ? renderLab(main, labById(v.lab)) : renderIndex(main);
}

function renderLocked(main) {
  main.innerHTML = `<section class="stack labs">
    <div class="stack" style="gap:6px"><h2 class="home-title">Labs for ${esc(ctx.exam.code)}</h2>
      <p class="muted">${esc(data.intro || '')}</p></div>
    <div class="panel card-pad labs-locked">
      ${icon('lock')}<div><h3>Labs are for signed-in members</h3>
      <p class="muted">There are ${data.labs.length} hands-on labs for this exam: simulated command lines, configuration tasks and admin consoles, graded as you go. Accounts are free.</p></div>
      <button class="btn btn-primary" data-guest-exit="signin">${icon('user')}Sign in to use labs</button>
    </div>
    <ul class="labs-preview">${data.labs.map((l) => `<li>${icon(KIND[l.kind][1])}<span><b>${esc(l.title)}</b><span class="muted small">${KIND[l.kind][0]} · ~${l.minutes} min</span></span></li>`).join('')}</ul>
  </section>`;
}

// ── Lab list ─────────────────────────────────────────────────────────────────
function renderIndex(main) {
  const res = store().results; const work = store().work;
  const done = data.labs.filter((l) => res[l.id]?.done).length;
  const cards = data.labs.map((l, i) => {
    const r = res[l.id]; const dom = ctx.exam.domains?.[l.domain];
    const status = r?.done ? `<span class="lab-status good">${icon('check')}Completed</span>`
      : r?.best ? `<span class="lab-status">Best so far: ${r.best}% of tasks</span>`
      : work[l.id] ? '<span class="lab-status">In progress</span>' : '<span class="lab-status muted">Not started</span>';
    return `<article class="panel lab-card">
      <div class="lab-card-head"><span class="learn-num">${i + 1}</span>
        <div><h3>${esc(l.title)}</h3>
        <span class="lab-meta">${icon(KIND[l.kind][1])}${KIND[l.kind][0]} · ${esc(l.level || 'intermediate')} · ~${l.minutes} min${dom ? ` · ${esc(dom.name)}` : ''}</span></div></div>
      <p class="muted">${esc(l.summary)}</p>
      <div class="lab-card-foot">${status}
        <button class="btn ${r?.done ? 'btn-ghost' : 'btn-primary'} btn-sm" data-open-lab="${l.id}">${r?.done ? 'Review lab' : work[l.id] || r ? 'Continue lab' : 'Start lab'}${icon('right')}</button></div>
    </article>`;
  }).join('');
  main.innerHTML = `<section class="stack labs">
      <div class="stack" style="gap:6px"><h2 class="home-title">Labs for ${esc(ctx.exam.code)}</h2>
      <p class="muted">${esc(data.intro || 'Hands-on simulations graded in your browser.')}</p>
      <p class="small muted">${done} of ${data.labs.length} completed</p></div>
      <div class="lab-grid">${cards}</div>
    </section>`;
  main.querySelectorAll('[data-open-lab]').forEach((b) => b.addEventListener('click', () => {
    store().view.lab = b.dataset.openLab; ctx.save(); renderLabs(main, ctx); window.scrollTo({ top: 0 });
  }));
}

// ── Lab workspace ────────────────────────────────────────────────────────────
function freshWork(lab) {
  const w = { devices: {}, log: {}, answers: {}, acts: {}, portal: null, startedAt: Date.now() };
  for (const d of lab.devices || []) {
    if (d.platform === 'ios') w.devices[d.name] = newIos(d);
    else if (d.platform === 'windows') w.devices[d.name] = newWin(d);
    else w.devices[d.name] = { ...d, platform: 'host' };
  }
  if (lab.portal) {
    const vals = {}; const tables = {};
    for (const pg of lab.portal.pages) {
      for (const s of pg.sections || []) for (const f of s.fields || []) vals[`${pg.id}.${f.id}`] = f.value ?? (f.type === 'toggle' ? false : '');
      for (const t of pg.tables || []) tables[`${pg.id}.${t.id}`] = (t.rows || []).map((r) => ({ ...r }));
    }
    w.portal = { page: lab.portal.pages[0].id, applied: { ...vals }, draft: { ...vals }, tables, tablesDraft: JSON.parse(JSON.stringify(tables)) };
  }
  return w;
}
const workFor = (lab) => (store().work[lab.id] ||= freshWork(lab));

function renderLab(main, lab) {
  const idx = data.labs.indexOf(lab);
  const w = workFor(lab);
  const consoles = (lab.devices || []).filter((d) => d.platform === 'ios' || d.platform === 'windows');
  live = { lab, w, sessions: {}, current: w.current && consoles.some((d) => d.name === w.current) ? w.current : consoles[0]?.name, checked: null };
  main.innerHTML = `<section class="stack labs lab-view">
    <div class="learn-crumbs"><button class="btn btn-ghost btn-sm" data-back>${icon('left')}All labs</button>
      <span class="muted small">Lab ${idx + 1} of ${data.labs.length} · ${KIND[lab.kind][0]} · ~${lab.minutes} min</span></div>
    <div class="stack" style="gap:6px"><h2 class="home-title">${esc(lab.title)}</h2></div>
    <div class="panel card-pad lab-scenario"><h3>Scenario</h3>${lab.scenario}
      ${lab.topology ? topologySvg(lab) : ''}</div>
    <div class="lab-layout">
      <div class="lab-work" id="lab-work"></div>
      <aside class="panel lab-side" id="lab-side" aria-label="Lab tasks"></aside>
    </div>
  </section>`;
  main.querySelector('[data-back]').addEventListener('click', () => { store().view.lab = null; ctx.save(); renderLabs(main, ctx); window.scrollTo({ top: 0 }); });
  const work = $('lab-work');
  if (lab.kind === 'cli') renderTerminal(work);
  else if (lab.kind === 'tasks') renderActivities(work);
  else if (lab.kind === 'portal') renderPortal(work);
  renderSide();
}

// ── Topology diagram (simple SVG from node grid positions) ──────────────────
function topologySvg(lab) {
  const nodes = lab.topology.nodes; const W = 130, H = 104, pad = 44;
  const pos = Object.fromEntries(nodes.map((n) => [n.name, { ...n, x: pad + n.x * W, y: pad + n.y * H }]));
  const maxX = Math.max(...nodes.map((n) => n.x)), maxY = Math.max(...nodes.map((n) => n.y));
  const links = (lab.links || []).map(([a, b]) => {
    const [an, ...ai] = a.split(/\s+/); const [bn, ...bi] = b.split(/\s+/);
    const A = pos[an], B = pos[bn]; if (!A || !B) return '';
    const lab1 = ai.join(''), lab2 = bi.join('');
    // Interface labels sit 30% along the link, nudged off the line so they don't collide with it.
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1; const nx = -(B.y - A.y) / len * 10, ny = (B.x - A.x) / len * 10;
    const at = (t, P, Q) => [P.x + (Q.x - P.x) * t + nx, P.y + (Q.y - P.y) * t + ny + 3];
    const [x1, y1] = at(0.3, A, B), [x2, y2] = at(0.7, A, B);
    return `<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>
      ${lab1 ? `<text class="if" x="${x1}" y="${y1}">${esc(lab1)}</text>` : ''}
      ${lab2 ? `<text class="if" x="${x2}" y="${y2}">${esc(lab2)}</text>` : ''}`;
  }).join('');
  const shape = (n) => {
    const { x, y } = n;
    if (n.type === 'router') return `<circle cx="${x}" cy="${y}" r="17"/><path d="M${x - 8} ${y}h16M${x} ${y - 8}v16" class="glyph"/>`;
    if (n.type === 'switch') return `<rect x="${x - 20}" y="${y - 12}" width="40" height="24" rx="4"/><path d="M${x - 10} ${y - 4}h20M${x - 10} ${y + 4}h20" class="glyph"/>`;
    if (n.type === 'cloud') return `<ellipse cx="${x}" cy="${y}" rx="24" ry="15"/>`;
    if (n.type === 'server') return `<rect x="${x - 12}" y="${y - 17}" width="24" height="34" rx="3"/><path d="M${x - 6} ${y - 8}h12M${x - 6} ${y}h12" class="glyph"/>`;
    return `<rect x="${x - 15}" y="${y - 12}" width="30" height="20" rx="3"/><path d="M${x - 7} ${y + 13}h14" class="glyph"/>`;
  };
  return `<figure class="lab-topology"><svg viewBox="0 0 ${pad * 2 + maxX * W} ${pad * 2 + maxY * H + 18}" role="img" aria-label="Network topology">
    <g class="links">${links}</g>
    ${Object.values(pos).map((n) => {
      // Put the name above a node whose links run downward, so it never sits on a cable.
      const down = (lab.links || []).some(([a, b]) => { const [x, y] = [a.split(/\s+/)[0], b.split(/\s+/)[0]]; const o = x === n.name ? pos[y] : y === n.name ? pos[x] : null; return o && o.y > n.y; });
      return `<g class="node ${n.type || 'host'}">${shape(n)}<text x="${n.x}" y="${down ? n.y - 26 : n.y + 32}">${esc(n.label || n.name)}</text></g>`;
    }).join('')}
  </svg></figure>`;
}

// ── Terminal ─────────────────────────────────────────────────────────────────
function netFor(w) { return new Net(w.devices, live.lab.links || []); }
function session(name) {
  if (live.sessions[name]) return live.sessions[name];
  const d = live.w.devices[name];
  const opts = { log: (m) => print(m), clear: () => { live.w.log[name] = []; drawLog(); } };
  const s = d.platform === 'windows' ? new WinSession(d, opts) : new IosSession(d, netFor(live.w), opts);
  s.history = live.w.history?.[name] || [];
  return (live.sessions[name] = s);
}
function print(text, cls = '') {
  const log = (live.w.log[live.current] ||= []);
  for (const line of String(text).split('\n')) log.push([cls, line]);
  if (log.length > 400) log.splice(0, log.length - 400);
}
function drawLog() {
  const out = $('term-out'); if (!out) return;
  const log = live.w.log[live.current] || [];
  out.innerHTML = log.map(([c, t]) => `<div class="${c}">${esc(t) || '&nbsp;'}</div>`).join('');
  out.scrollTop = out.scrollHeight;
}
function renderTerminal(el) {
  const consoles = live.lab.devices.filter((d) => d.platform === 'ios' || d.platform === 'windows');
  el.innerHTML = `<div class="terminal-wrap">
    ${consoles.length > 1 ? `<div class="term-tabs" role="tablist" aria-label="Device consoles">${consoles.map((d) =>
      `<button role="tab" data-dev="${esc(d.name)}" aria-selected="${d.name === live.current}">${icon(d.platform === 'windows' ? 'window' : 'terminal')}${esc(d.name)}</button>`).join('')}</div>` : ''}
    <div class="terminal" id="terminal">
      <div class="term-out" id="term-out" aria-live="polite"></div>
      <form class="term-line" id="term-form" autocomplete="off"><label class="term-prompt" id="term-prompt" for="term-in"></label>
        <input id="term-in" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Command"></form>
    </div>
    <p class="small muted term-help">${consoles.some((d) => d.platform === 'ios')
      ? 'Type commands as you would on the device. Abbreviations work (conf t, int g0/1, sh ip int br). Type ? for help, Tab to complete, ↑/↓ for history.'
      : 'Type Windows commands such as ipconfig /all, ping, tracert, nslookup and netsh. ↑/↓ for history.'}</p>
  </div>`;
  const input = $('term-in'); const form = $('term-form');
  let hpos = -1;
  const refresh = () => { $('term-prompt').textContent = session(live.current).prompt(); drawLog(); };
  for (const d of consoles) {
    const lg = (live.w.log[d.name] ||= []);
    if (!lg.length) {
      if (d.platform === 'windows') lg.push(['', 'Microsoft Windows [Version 10.0.22631.4317]'], ['', '(c) Microsoft Corporation. All rights reserved.'], ['', '']);
      else lg.push(['muted', `Connected to ${d.name} console. Press Enter to start.`]);
    }
  }
  el.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => {
    live.current = live.w.current = b.dataset.dev; ctx.save();
    el.querySelectorAll('[data-dev]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    refresh(); input.focus();
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = session(live.current); const line = input.value;
    const secret = s.pending?.secret;
    print(`${s.prompt()}${secret ? '' : line}`, 'cmd');
    let out = '';
    try { out = s.run(line); } catch (err) { out = `% Simulator error: ${err.message}`; }
    if (out) print(out);
    (live.w.history ||= {})[live.current] = s.history.slice(-50);
    input.value = ''; hpos = -1;
    ctx.save(); refresh(); renderSide(true);
  });
  input.addEventListener('keydown', (e) => {
    const s = session(live.current); const h = s.history;
    if (e.key === 'ArrowUp' && h.length) { e.preventDefault(); hpos = hpos < 0 ? h.length - 1 : Math.max(0, hpos - 1); input.value = h[hpos]; }
    else if (e.key === 'ArrowDown' && hpos >= 0) { e.preventDefault(); hpos += 1; input.value = hpos >= h.length ? '' : h[hpos]; if (hpos >= h.length) hpos = -1; }
    else if (e.key === 'Tab') { e.preventDefault(); input.value = s.complete(input.value); }
    else if (e.key === '?' && s instanceof IosSession) {
      e.preventDefault();
      print(`${s.prompt()}${input.value}?`, 'cmd'); print(s.help(`${input.value}?`)); refresh();
    }
  });
  $('terminal').addEventListener('click', () => { if (!getSelection().toString()) input.focus(); });
  refresh();
}

// ── Activities (tasks kind) ──────────────────────────────────────────────────
function shuffleOnce(key, n) {
  const st = live.w.acts[key] ||= {};
  if (!st.order) { st.order = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [st.order[i], st.order[j]] = [st.order[j], st.order[i]]; } }
  return st;
}
function renderActivities(el) {
  el.innerHTML = live.lab.activities.map((a, i) => `<section class="panel card-pad activity" data-act="${i}">
      <h3><span class="act-num">${i + 1}</span>${esc(a.title || '')}</h3><p class="muted">${a.prompt}</p><div class="act-body"></div></section>`).join('');
  live.lab.activities.forEach((a, i) => drawActivity(i));
}
function drawActivity(i) {
  const a = live.lab.activities[i]; const box = document.querySelector(`[data-act="${i}"] .act-body`);
  const st = live.w.acts[i] ||= {};
  const changed = () => { ctx.save(); renderSide(true); };
  if (a.type === 'match') {
    st.place ||= {};
    const bank = a.items.map((it, k) => k).filter((k) => st.place[k] == null);
    shuffleOnce(i, a.items.length);
    const chip = (k) => `<button type="button" class="drag-item ${st.sel === k ? 'selected' : ''}" draggable="true" data-item="${k}">${esc(a.items[k].text)}</button>`;
    box.innerHTML = `<p class="small muted">Drag each item to the right group, or tap an item and then tap a group. Tap a placed item to send it back.</p>
      <div class="drag-bank" data-zone="bank">${st.order.filter((k) => bank.includes(k)).map(chip).join('') || '<span class="small muted">All items placed.</span>'}</div>
      <div class="drop-grid">${a.categories.map((c, ci) => `<div class="drop-zone" data-zone="${ci}"><b>${esc(c)}</b>
        <div class="drop-items">${a.items.map((_, k) => k).filter((k) => st.place[k] === ci).map(chip).join('')}</div></div>`).join('')}</div>`;
    const place = (k, zone) => { if (zone === 'bank') delete st.place[k]; else st.place[k] = Number(zone); st.sel = null; drawActivity(i); changed(); };
    box.querySelectorAll('.drag-item').forEach((b) => {
      b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', b.dataset.item); e.dataTransfer.effectAllowed = 'move'; });
      b.addEventListener('click', (e) => {
        e.stopPropagation(); const k = Number(b.dataset.item);
        // With another item selected, tapping a placed item drops the selection into that group.
        if (st.sel != null && st.sel !== k && st.place[k] != null) return place(st.sel, String(st.place[k]));
        if (st.place[k] != null) return place(k, 'bank');
        st.sel = st.sel === k ? null : k; drawActivity(i);
      });
    });
    box.querySelectorAll('[data-zone]').forEach((z) => {
      z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
      z.addEventListener('dragleave', () => z.classList.remove('over'));
      z.addEventListener('drop', (e) => { e.preventDefault(); place(Number(e.dataTransfer.getData('text/plain')), z.dataset.zone); });
      z.addEventListener('click', () => { if (st.sel != null) place(st.sel, z.dataset.zone); });
    });
  } else if (a.type === 'order') {
    const s2 = shuffleOnce(i, a.items.length);
    box.innerHTML = `<p class="small muted">Drag to reorder, or use the arrows.</p><ol class="order-list">${s2.order.map((k, pos) =>
      `<li draggable="true" data-pos="${pos}"><span class="grip" aria-hidden="true">⋮⋮</span><span class="order-text">${esc(a.items[k])}</span>
        <span class="order-btns"><button type="button" class="icon-btn" data-move="-1" aria-label="Move up" ${pos === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-move="1" aria-label="Move down" ${pos === s2.order.length - 1 ? 'disabled' : ''}>↓</button></span></li>`).join('')}</ol>`;
    const move = (from, to) => { const [x] = s2.order.splice(from, 1); s2.order.splice(to, 0, x); drawActivity(i); changed(); };
    box.querySelectorAll('li').forEach((li) => {
      const pos = Number(li.dataset.pos);
      li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(pos)));
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => { e.preventDefault(); move(Number(e.dataTransfer.getData('text/plain')), pos); });
      li.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => move(pos, pos + Number(b.dataset.move))));
    });
  } else if (a.type === 'fill') {
    st.vals ||= {};
    box.innerHTML = `<div class="fill-grid">${a.rows.map((r, k) => `<label><span>${esc(r.label)}</span>
      <input class="fill-input" data-k="${k}" value="${esc(st.vals[k] || '')}" placeholder="${esc(r.placeholder || '')}" spellcheck="false" autocomplete="off"></label>`).join('')}</div>`;
    box.querySelectorAll('.fill-input').forEach((inp) => inp.addEventListener('input', () => { st.vals[inp.dataset.k] = inp.value; changed(); }));
  } else if (a.type === 'rules') {
    st.rules ||= (a.start || []).map((r) => ({ ...r }));
    const sel = (k, opts, v) => `<select data-f="${k}">${opts.map((o) => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    box.innerHTML = `<p class="small muted">Rules are checked top to bottom; the first match wins. Anything that matches no rule is denied.</p>
      <div class="rules-table" role="table">
        <div class="rules-row head" role="row"><span>#</span><span>Action</span><span>Protocol</span><span>Source</span><span>Destination</span><span>Port</span><span></span></div>
        ${st.rules.map((r, k) => `<div class="rules-row" role="row" data-r="${k}"><span>${k + 1}</span>
          ${sel('action', ['Allow', 'Deny'], r.action)}${sel('proto', ['TCP', 'UDP', 'ICMP', 'Any'], r.proto)}
          <input data-f="src" value="${esc(r.src ?? 'Any')}" aria-label="Source"><input data-f="dst" value="${esc(r.dst ?? 'Any')}" aria-label="Destination">
          <input data-f="port" value="${esc(r.port ?? 'Any')}" aria-label="Port">
          <span class="rule-btns"><button type="button" class="icon-btn" data-up aria-label="Move up" ${k === 0 ? 'disabled' : ''}>↑</button><button type="button" class="icon-btn" data-down aria-label="Move down" ${k === st.rules.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="icon-btn" data-del aria-label="Delete rule">✕</button></span></div>`).join('')}
        <div class="rules-row implicit"><span>—</span><span>Deny</span><span>Any</span><span>Any</span><span>Any</span><span>Any</span><span class="small muted">implicit</span></div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-add-rule>+ Add rule</button>
      ${st.results ? `<ul class="rule-tests">${a.tests.map((t, k) => `<li class="${st.results[k] ? 'pass' : 'fail'}">${icon(st.results[k] ? 'check' : 'x')}${esc(t.label)} → should be <b>${t.expect}</b></li>`).join('')}</ul>` : ''}`;
    box.querySelectorAll('.rules-row[data-r]').forEach((row) => {
      const k = Number(row.dataset.r); const r = st.rules[k];
      row.querySelectorAll('[data-f]').forEach((f) => f.addEventListener('change', () => { r[f.dataset.f] = f.value; st.results = null; changed(); }));
      row.querySelector('[data-up]').addEventListener('click', () => { [st.rules[k - 1], st.rules[k]] = [st.rules[k], st.rules[k - 1]]; st.results = null; drawActivity(i); changed(); });
      row.querySelector('[data-down]').addEventListener('click', () => { [st.rules[k + 1], st.rules[k]] = [st.rules[k], st.rules[k + 1]]; st.results = null; drawActivity(i); changed(); });
      row.querySelector('[data-del]').addEventListener('click', () => { st.rules.splice(k, 1); st.results = null; drawActivity(i); changed(); });
    });
    box.querySelector('[data-add-rule]').addEventListener('click', () => { st.rules.push({ action: 'Allow', proto: 'TCP', src: 'Any', dst: 'Any', port: 'Any' }); drawActivity(i); changed(); });
  }
}
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
function addrMatch(spec, ip) {
  const s = String(spec || 'any').trim().toLowerCase();
  if (s === 'any' || s === '*' || s === '0.0.0.0/0') return true;
  if (s.includes('/')) { const [n, b] = s.split('/'); const bits = Number(b); if (!isIp(n) || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return ((ip2n(ip) & mask) >>> 0) === ((ip2n(n) & mask) >>> 0); }
  return s === ip;
}
function portMatch(spec, port) {
  const s = String(spec || 'any').trim().toLowerCase();
  if (s === 'any' || s === '*' || port == null) return s === 'any' || s === '*' || port == null;
  return s.split(',').some((p) => { const [a, b] = p.split('-').map(Number); return b ? port >= a && port <= b : port === a; });
}
function evalRules(rules, pkt) {
  for (const r of rules) {
    const proto = String(r.proto || 'Any').toLowerCase();
    if (proto !== 'any' && proto !== pkt.proto.toLowerCase()) continue;
    if (!addrMatch(r.src, pkt.src) || !addrMatch(r.dst, pkt.dst)) continue;
    if (pkt.proto.toLowerCase() !== 'icmp' && !portMatch(r.port, pkt.port)) continue;
    return String(r.action).toLowerCase() === 'allow' ? 'allow' : 'deny';
  }
  return 'deny';
}
function activityOk(i) {
  const a = live.lab.activities[i]; const st = live.w.acts[i] || {};
  if (a.type === 'match') return a.items.every((it, k) => st.place?.[k] === it.cat);
  if (a.type === 'order') return !!st.order && st.order.every((k, pos) => k === pos);
  if (a.type === 'fill') return a.rows.every((r, k) => (Array.isArray(r.answer) ? r.answer : [r.answer]).some((ans) => norm(ans) === norm(st.vals?.[k])));
  if (a.type === 'rules') {
    const rules = st.rules || [];
    st.results = a.tests.map((t) => evalRules(rules, t.packet) === t.expect);
    return st.results.every(Boolean);
  }
  return false;
}

// ── Portal (admin console) ───────────────────────────────────────────────────
function renderPortal(el) {
  const P = live.lab.portal; const w = live.w.portal;
  const page = P.pages.find((p) => p.id === w.page) || P.pages[0];
  const dirty = page.sections?.some((s) => s.fields?.some((f) => w.draft[`${page.id}.${f.id}`] !== w.applied[`${page.id}.${f.id}`]))
    || (page.tables || []).some((t) => JSON.stringify(w.tablesDraft[`${page.id}.${t.id}`]) !== JSON.stringify(w.tables[`${page.id}.${t.id}`]));
  const field = (f) => {
    const key = `${page.id}.${f.id}`; const v = w.draft[key];
    let input;
    if (f.type === 'select') input = `<select data-key="${key}">${f.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.type === 'toggle') input = `<label class="switch"><input type="checkbox" data-key="${key}" ${v ? 'checked' : ''}><span>${v ? 'On' : 'Off'}</span></label>`;
    else input = `<input data-key="${key}" type="${f.type === 'password' ? 'password' : 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" spellcheck="false" autocomplete="off">`;
    return `<div class="portal-field"><label><span>${esc(f.label)}</span>${input}</label>${f.help ? `<span class="small muted">${esc(f.help)}</span>` : ''}</div>`;
  };
  const table = (t) => {
    const key = `${page.id}.${t.id}`; const rows = w.tablesDraft[key] || [];
    const cell = (c, r, k) => c.type === 'select'
      ? `<select data-t="${key}" data-row="${k}" data-col="${c.id}">${c.options.map((o) => `<option ${o === r[c.id] ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : `<input data-t="${key}" data-row="${k}" data-col="${c.id}" value="${esc(r[c.id] ?? '')}" aria-label="${esc(c.label)}" spellcheck="false" autocomplete="off">`;
    return `<div class="portal-table"><h4>${esc(t.title)}</h4>
      <div class="pt-grid" style="--cols:${t.columns.length}"><div class="pt-row head">${t.columns.map((c) => `<span>${esc(c.label)}</span>`).join('')}<span></span></div>
      ${rows.map((r, k) => `<div class="pt-row">${t.columns.map((c) => cell(c, r, k)).join('')}<button type="button" class="icon-btn" data-del-row="${key}" data-row="${k}" aria-label="Delete row">✕</button></div>`).join('')
        || `<div class="pt-empty small muted">No entries.</div>`}</div>
      ${t.add !== false ? `<button type="button" class="btn btn-ghost btn-sm" data-add-row="${key}">+ Add entry</button>` : ''}</div>`;
  };
  el.innerHTML = `<div class="portal">
    <div class="portal-bar"><span class="portal-logo">${icon('window')}</span><b>${esc(P.app)}</b><span class="small muted">${esc(P.address || '')}</span></div>
    <div class="portal-body">
      <nav class="portal-nav" aria-label="${esc(P.app)} sections">${P.pages.map((p) => `<button type="button" data-page="${p.id}" aria-current="${p.id === page.id}">${esc(p.title)}</button>`).join('')}</nav>
      <div class="portal-page">
        <h3>${esc(page.title)}</h3>${page.desc ? `<p class="small muted">${esc(page.desc)}</p>` : ''}
        ${(page.sections || []).map((s) => `<fieldset><legend>${esc(s.title)}</legend>${(s.fields || []).map(field).join('')}</fieldset>`).join('')}
        ${(page.tables || []).map(table).join('')}
        <div class="portal-actions"><button type="button" class="btn btn-primary btn-sm" data-apply ${dirty ? '' : 'disabled'}>Save changes</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cancel ${dirty ? '' : 'disabled'}>Discard</button>
          <span class="small ${dirty ? 'warn-text' : 'muted'}">${dirty ? 'Unsaved changes on this page' : 'All changes saved'}</span></div>
      </div>
    </div></div>`;
  const redraw = () => { ctx.save(); renderPortal(el); renderSide(true); };
  el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { w.page = b.dataset.page; redraw(); }));
  el.querySelectorAll('[data-key]').forEach((inp) => inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
    w.draft[inp.dataset.key] = inp.type === 'checkbox' ? inp.checked : inp.value;
    if (inp.type === 'checkbox' || inp.tagName === 'SELECT') redraw(); else { ctx.save(); updatePortalDirty(el, page); }
  }));
  el.querySelectorAll('[data-t]').forEach((inp) => inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => {
    w.tablesDraft[inp.dataset.t][Number(inp.dataset.row)][inp.dataset.col] = inp.value;
    if (inp.tagName === 'SELECT') redraw(); else { ctx.save(); updatePortalDirty(el, page); }
  }));
  el.querySelectorAll('[data-add-row]').forEach((b) => b.addEventListener('click', () => {
    const t = page.tables.find((x) => `${page.id}.${x.id}` === b.dataset.addRow);
    w.tablesDraft[b.dataset.addRow].push(Object.fromEntries(t.columns.map((c) => [c.id, c.type === 'select' ? c.options[0] : ''])));
    redraw();
  }));
  el.querySelectorAll('[data-del-row]').forEach((b) => b.addEventListener('click', () => { w.tablesDraft[b.dataset.delRow].splice(Number(b.dataset.row), 1); redraw(); }));
  el.querySelector('[data-apply]').addEventListener('click', () => {
    for (const s of page.sections || []) for (const f of s.fields || []) { const k = `${page.id}.${f.id}`; w.applied[k] = w.draft[k]; }
    for (const t of page.tables || []) { const k = `${page.id}.${t.id}`; w.tables[k] = JSON.parse(JSON.stringify(w.tablesDraft[k])); }
    redraw();
  });
  el.querySelector('[data-cancel]').addEventListener('click', () => {
    for (const s of page.sections || []) for (const f of s.fields || []) { const k = `${page.id}.${f.id}`; w.draft[k] = w.applied[k]; }
    for (const t of page.tables || []) { const k = `${page.id}.${t.id}`; w.tablesDraft[k] = JSON.parse(JSON.stringify(w.tables[k])); }
    redraw();
  });
}
function updatePortalDirty(el, page) {
  const w = live.w.portal;
  const dirty = page.sections?.some((s) => s.fields?.some((f) => w.draft[`${page.id}.${f.id}`] !== w.applied[`${page.id}.${f.id}`]))
    || (page.tables || []).some((t) => JSON.stringify(w.tablesDraft[`${page.id}.${t.id}`]) !== JSON.stringify(w.tables[`${page.id}.${t.id}`]));
  el.querySelector('[data-apply]').disabled = !dirty; el.querySelector('[data-cancel]').disabled = !dirty;
  const note = el.querySelector('.portal-actions > span');
  note.textContent = dirty ? 'Unsaved changes on this page' : 'All changes saved'; note.className = `small ${dirty ? 'warn-text' : 'muted'}`;
}

// ── Checks ───────────────────────────────────────────────────────────────────
const getPath = (o, path) => String(path).split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const same = (a, b) => (typeof a === 'string' || typeof b === 'string' ? norm(a) === norm(b) : a === b);
function compare(v, c) {
  if ('eq' in c) return same(v, c.eq);
  if ('ne' in c) return !same(v, c.ne);
  if ('in' in c) return c.in.some((x) => same(v, x));
  if ('minLen' in c) return String(v ?? '').length >= c.minLen;
  if ('re' in c) return new RegExp(c.re, 'i').test(String(v ?? ''));
  if ('exists' in c) return (v != null && v !== '') === c.exists;
  if ('nonEmpty' in c) return (v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v) === c.nonEmpty;
  return !!v;
}
function check(c, net) {
  const w = live.w;
  if (c.all) return c.all.every((x) => check(x, net));
  if (c.any) return c.any.some((x) => check(x, net));
  if (c.not) return !check(c.not, net);
  if (c.dev) return compare(getPath(w.devices[c.dev], c.path), c);
  if (c.iface) {
    const [dn, ...rest] = c.iface.split(/\s+/); const d = w.devices[dn]; const n = canonIf(rest.join(''));
    const i = d?.interfaces?.[n]; if (!i) return false;
    const vset = (x) => { const st = vlanSet(x); return st ? [...st].sort((p, q) => p - q).join(',') : 'all'; };
    return Object.entries(c.is || {}).every(([k, v]) => (k === 'up' ? net.ifUp(d, n) === v : k === 'allowed' ? vset(i[k]) === vset(v) : same(i[k], v)));
  }
  if (c.ping) {
    const [from, to] = c.ping; const d = w.devices[from];
    let ok;
    if (d.platform === 'windows') { const s = new WinSession(d); const t = s.target([to]); ok = !t.err && s.reach(t.ip); }
    else ok = net.ping(from, to).ok;
    return ok === (c.expect ?? true);
  }
  if (c.route) { const [dn, pfx] = c.route; const [nw, bits] = pfx.split('/'); const r = net.table(w.devices[dn]).find((x) => x.net === nw && maskBits(x.mask) === Number(bits)); return !!r && (!c.code || r.code.startsWith(c.code)); }
  if (c.ospfNbr) { const [a, b] = c.ospfNbr; return (net.nbrs[a] || []).some((n) => n.dev === b); }
  if (c.saved) { const d = w.devices[c.saved]; if (!d.startup) return false; return d.startup === new IosSession(d, net).runningConfig(); }
  if (c.ran) { const [dn, re] = c.ran; return (w.history?.[dn] || []).some((h) => new RegExp(re, 'i').test(h)); }
  if (c.sshReady) {
    const d = w.devices[c.sshReady];
    return !!d.domainName && !!d.rsa && d.rsa >= 768 && d.sshVersion === 2 && d.vty.login === 'local'
      && d.vty.transport.includes('ssh') && !d.vty.transport.includes('telnet') && d.vty.transport !== 'all' && Object.keys(d.users).length > 0;
  }
  if (c.lookup) { const [dn, name] = c.lookup; const s = new WinSession(w.devices[dn]); return !!s.resolve(name).ip === (c.expect ?? true); }
  if (c.q) return w.answers[c.q] === c.eq;
  if (c.activity != null) return activityOk(c.activity);
  if (c.field) return compare(w.portal.applied[c.field], c);
  if (c.rows) {
    const rows = w.portal.tables[c.rows] || [];
    const match = (r) => Object.entries(c.has || {}).every(([k, v]) => (Array.isArray(v) ? v.some((x) => same(r[k], x)) : same(r[k], v)));
    if (c.count != null) return rows.length === c.count;
    if (c.none) return !rows.some((r) => Object.entries(c.none).every(([k, v]) => same(r[k], v)));
    return rows.some(match);
  }
  return false;
}
function grade() {
  const net = live.lab.kind === 'cli' ? netFor(live.w).build() : null;
  return live.lab.tasks.map((t) => { try { return check(t.check, net); } catch { return false; } });
}

// ── Side panel: tasks, questions, actions ────────────────────────────────────
function renderSide(soft = false) {
  const side = $('lab-side'); if (!side) return;
  const lab = live.lab; const w = live.w; const res = store().results[lab.id];
  if (soft && live.checked) live.checked = null; // results go stale once the learner changes something
  const marks = live.checked;
  const passed = marks ? marks.filter(Boolean).length : 0;
  side.innerHTML = `<h3>Tasks</h3>
    <ol class="lab-tasks">${lab.tasks.map((t, i) => `<li class="${marks ? (marks[i] ? 'pass' : 'fail') : ''}">
      <span class="task-mark">${marks ? icon(marks[i] ? 'check' : 'x') : `<span class="task-n">${i + 1}</span>`}</span><span>${t.text}</span></li>`).join('')}</ol>
    ${(lab.questions || []).map((q) => `<div class="lab-q"><b>${esc(q.prompt)}</b>${q.options.map((o, k) =>
      `<label><input type="radio" name="q-${q.id}" value="${k}" ${w.answers[q.id] === k ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`).join('')}
    ${marks ? `<p class="lab-result ${passed === marks.length ? 'good' : ''}" role="status">${passed === marks.length
      ? `${icon('check')}All ${marks.length} tasks complete. Nice work!` : `${passed} of ${marks.length} tasks complete. Keep going.`}</p>` : ''}
    <div class="lab-actions">
      <button type="button" class="btn btn-primary" data-check>${icon('check')}Check my work</button>
      <button type="button" class="btn btn-ghost btn-sm" data-reset>${icon('redo')}Reset lab</button>
    </div>
    ${lab.hints?.length ? `<details class="lab-hints"><summary>Hints</summary><ul>${lab.hints.map((h) => `<li>${h}</li>`).join('')}</ul></details>` : ''}
    ${lab.solution && (res?.best || res?.done || marks) ? `<details class="lab-hints"><summary>Show a solution</summary>${lab.solution}</details>` : ''}
    ${res?.done && lab.review ? `<div class="lab-review"><h4>What you practiced</h4>${lab.review}</div>` : ''}
    ${res?.done ? `<p class="small muted">${icon('check')} Completed ${new Date(res.done).toLocaleDateString()}</p>` : ''}`;
  side.querySelectorAll('.lab-q input').forEach((r) => r.addEventListener('change', () => {
    w.answers[r.name.slice(2)] = Number(r.value); ctx.save(); live.checked = null; renderSide();
  }));
  side.querySelector('[data-check]').addEventListener('click', () => {
    live.checked = grade();
    const pct = Math.round((live.checked.filter(Boolean).length / live.checked.length) * 100);
    const r = (store().results[lab.id] ||= { best: 0, tries: 0 });
    r.tries += 1; r.best = Math.max(r.best || 0, pct); r.last = Date.now();
    if (pct === 100 && !r.done) r.done = Date.now();
    ctx.save(); renderSide();
    if (lab.kind === 'tasks') lab.activities.forEach((a, i) => { if (a.type === 'rules') drawActivity(i); });
  });
  side.querySelector('[data-reset]').addEventListener('click', () => {
    if (!confirmReset()) return;
    delete store().work[lab.id]; ctx.save(); renderLab($('main'), lab);
  });
}
function confirmReset() {
  const b = document.querySelector('[data-reset]');
  if (b.dataset.armed) return true;
  b.dataset.armed = '1'; b.innerHTML = `${icon('redo')}Click again to reset`;
  setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.innerHTML = `${icon('redo')}Reset lab`; } }, 3000);
  return false;
}

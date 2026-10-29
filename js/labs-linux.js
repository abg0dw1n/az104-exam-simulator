// Linux shell simulator for labs: a small virtual filesystem with owners and permission
// bits, sudo, services (systemctl), processes, a host firewall (ufw), packages (apt),
// users and groups, and text tools with pipes (grep, sort, uniq, wc, head, tail, cut, awk).

export function newLinux(def) {
  const fs = { '/': { t: 'd', mode: '755', owner: 'root', group: 'root' } };
  const add = (path, node) => {
    const parts = path.split('/').filter(Boolean); let cur = '';
    for (const p of parts.slice(0, -1)) { cur += `/${p}`; fs[cur] ||= { t: 'd', mode: '755', owner: 'root', group: 'root' }; }
    fs[path] = node;
  };
  for (const [path, f] of Object.entries(def.files || {})) {
    if (f.dir) add(path, { t: 'd', mode: f.mode || '755', owner: f.owner || 'root', group: f.group || f.owner || 'root' });
    else add(path, { t: 'f', mode: f.mode || '644', owner: f.owner || 'root', group: f.group || f.owner || 'root', content: Array.isArray(f.content) ? f.content.join('\n') : f.content || '' });
  }
  const user = def.user || 'student';
  // The user's home is theirs unless the lab defines it explicitly.
  if (!def.files?.[`/home/${user}`]) add(`/home/${user}`, { t: 'd', mode: '750', owner: user, group: user });
  return {
    name: def.name, platform: 'linux', hostname: def.hostname || def.name, user, cwd: `/home/${user}`, fs,
    users: { root: { groups: ['root'] }, [user]: { groups: [user, 'sudo'] }, ...(def.users || {}) },
    services: def.services || {}, procs: def.procs || [], packages: def.packages || [], available: def.available || [],
    ufw: { enabled: false, rules: [], ...(def.ufw || {}) }, pkgServices: { nginx: { active: true, enabled: true, port: 80, desc: 'A high performance web server' }, apache2: { active: true, enabled: true, port: 80 }, ...(def.pkgServices || {}) }, ip: def.ip || '10.0.0.10', net: def.net || {}, nextPid: 4000,
  };
}

const perms = (m) => [...m].map((d) => { const n = +d; return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`; }).join('');

export class LinuxSession {
  constructor(sys, opts = {}) { this.s = sys; this.opts = opts; this.history = []; this.root = false; }
  prompt() { const home = `/home/${this.s.user}`; const cwd = this.s.cwd.startsWith(home) ? `~${this.s.cwd.slice(home.length)}` : this.s.cwd; return `${this.s.user}@${this.s.hostname}:${cwd}$ `; }
  abs(p) {
    if (!p) return this.s.cwd;
    if (p.startsWith('~')) p = `/home/${this.s.user}${p.slice(1)}`;
    const parts = (p.startsWith('/') ? p : `${this.s.cwd}/${p}`).split('/'); const out = [];
    for (const x of parts) { if (!x || x === '.') continue; if (x === '..') out.pop(); else out.push(x); }
    return `/${out.join('/')}`;
  }
  me() { return this.root ? 'root' : this.s.user; }
  inGroup(g) { return (this.s.users[this.me()]?.groups || []).includes(g); }
  can(node, bit) { // bit: 4 read, 2 write, 1 exec
    if (this.root) return true;
    const [u, g, o] = [...node.mode].map(Number);
    if (node.owner === this.me()) return !!(u & bit);
    if (this.inGroup(node.group)) return !!(g & bit);
    return !!(o & bit);
  }
  parent(p) { return p.slice(0, p.lastIndexOf('/')) || '/'; }
  run(raw) {
    const line = raw.trim(); if (!line) return '';
    this.history.push(line);
    // Redirection: cmd > file / cmd >> file (only for echo/cat-like output).
    let redir = null; const rm = line.match(/^(.*?)\s*(>>?)\s*(\S+)$/);
    let body = line;
    if (rm && !/^(awk|grep)/.test(line.split('|').pop().trim())) { body = rm[1]; redir = { mode: rm[2], path: this.abs(rm[3]) }; }
    const stages = splitPipes(body);
    let input = null; let out = '';
    try {
      for (const st of stages) { out = this.exec(tokenize(st), input); input = out; }
    } catch (e) {
      if (e instanceof ShellError) return e.message;
      throw e;
    } finally { this.root = false; }
    if (redir) {
      const sudoRedir = /^sudo\s/.test(body);
      const node = this.s.fs[redir.path]; const dir = this.s.fs[this.parent(redir.path)];
      if (!dir) return `bash: ${redir.path}: No such file or directory`;
      // As in real bash, "sudo echo x > file" still writes as the normal user.
      if (sudoRedir && !(node ? this.can(node, 2) : this.can(dir, 2))) return `bash: ${redir.path}: Permission denied`;
      if (node ? !this.can(node, 2) : !this.can(dir, 2)) return `bash: ${redir.path}: Permission denied`;
      if (node) node.content = redir.mode === '>>' ? `${node.content}${node.content && !node.content.endsWith('\n') ? '\n' : ''}${out}` : out;
      else this.s.fs[redir.path] = { t: 'f', mode: '664', owner: this.s.user, group: this.s.user, content: out };
      this.opts.onChange?.(); return '';
    }
    return out;
  }
  exec(argv, input) {
    let [cmd, ...a] = argv;
    if (cmd === 'sudo') {
      if (!this.inGroup('sudo')) throw new ShellError(`${this.s.user} is not in the sudoers file.  This incident will be reported.`);
      this.root = true; [cmd, ...a] = a;
      if (!cmd) throw new ShellError('usage: sudo command');
    }
    const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x));
    const need = (n, use) => { if (args.length < n) throw new ShellError(use); };
    const read = (p) => {
      const path = this.abs(p); const n = this.s.fs[path];
      if (!n) throw new ShellError(`${cmd}: ${p}: No such file or directory`);
      if (n.t === 'd') throw new ShellError(`${cmd}: ${p}: Is a directory`);
      if (!this.can(n, 4)) throw new ShellError(`${cmd}: ${p}: Permission denied`);
      return n.content;
    };
    const text = () => (args.length ? args.map(read).join('\n') : input ?? '');
    const lines = (t) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
    switch (cmd) {
      case 'whoami': return this.me();
      case 'hostname': return this.s.hostname;
      case 'id': { const u = args[0] || this.me(); const g = this.s.users[u]?.groups || []; return `uid=${u === 'root' ? 0 : 1000}(${u}) gid=${u === 'root' ? 0 : 1000}(${u}) groups=${g.map((x, i) => `${i === 0 && x === u ? (u === 'root' ? 0 : 1000) : 1000 + i * 3}(${x})`).join(',')}`; }
      case 'groups': return (this.s.users[args[0] || this.me()]?.groups || []).join(' ');
      case 'pwd': return this.s.cwd;
      case 'clear': this.opts.clear?.(); return '';
      case 'help': return 'Commands in this lab: ls, cd, pwd, cat, head, tail, grep, wc, sort, uniq, cut, awk, echo, touch, mkdir, rm, cp, mv, chmod, chown, find, sed -i, sudo, whoami, id, groups, useradd, usermod, ps, kill, systemctl, ufw, apt, ss, ip, ping, df, history, clear';
      case 'history': return this.history.map((h, i) => `  ${i + 1}  ${h}`).join('\n');
      case 'echo': return a.join(' ');
      case 'cd': {
        const p = this.abs(args[0] || '~'); const n = this.s.fs[p];
        if (!n) throw new ShellError(`bash: cd: ${args[0]}: No such file or directory`);
        if (n.t !== 'd') throw new ShellError(`bash: cd: ${args[0]}: Not a directory`);
        if (!this.can(n, 1)) throw new ShellError(`bash: cd: ${args[0]}: Permission denied`);
        this.s.cwd = p; return '';
      }
      case 'ls': {
        const long = flags.some((f) => f.includes('l')); const all = flags.some((f) => f.includes('a'));
        const p = this.abs(args[0]); const n = this.s.fs[p];
        if (!n) throw new ShellError(`ls: cannot access '${args[0]}': No such file or directory`);
        const entries = n.t === 'd'
          ? Object.keys(this.s.fs).filter((k) => k !== p && this.parent(k) === p).sort()
          : [p];
        if (n.t === 'd' && !this.can(n, 4)) throw new ShellError(`ls: cannot open directory '${args[0] || '.'}': Permission denied`);
        const shown = entries.filter((k) => all || !k.split('/').pop().startsWith('.'));
        if (!long) return shown.map((k) => k.split('/').pop()).join('  ');
        return `total ${shown.length * 4}\n${shown.map((k) => { const x = this.s.fs[k];
          return `${x.t === 'd' ? 'd' : '-'}${perms(x.mode)} 1 ${x.owner.padEnd(8)} ${x.group.padEnd(8)} ${String(x.t === 'd' ? 4096 : (x.content || '').length).padStart(6)} Oct 29 09:12 ${k.split('/').pop()}`; }).join('\n')}`;
      }
      case 'cat': need(1, 'usage: cat FILE'); return args.map(read).join('\n');
      case 'head': case 'tail': {
        const nf = a.indexOf('-n'); const n = nf >= 0 ? +a[nf + 1] : (flags.find((f) => /^-\d+$/.test(f)) ? +flags.find((f) => /^-\d+$/.test(f)).slice(1) : 10);
        const files = args.filter((x) => x !== String(n));
        const l = lines(files.length ? files.map(read).join('\n') : input ?? '');
        return (cmd === 'head' ? l.slice(0, n) : l.slice(-n)).join('\n');
      }
      case 'grep': {
        need(1, 'Usage: grep [OPTION]... PATTERNS [FILE]...');
        const [pat, ...files] = args; const i = flags.some((f) => f.includes('i')); const v = flags.some((f) => f.includes('v')); const c = flags.some((f) => f.includes('c'));
        const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '.' || m === '*' || m === '^' || m === '$' || m === '[' || m === ']' ? m : `\\${m}`)), i ? 'i' : '');
        const src = files.length ? files.map(read).join('\n') : input ?? '';
        const hits = lines(src).filter((l) => re.test(l) !== v);
        return c ? String(hits.length) : hits.join('\n');
      }
      case 'wc': { const t = text(); const l = lines(t); return flags.some((f) => f.includes('l')) ? String(l.length) : `${l.length} ${t.split(/\s+/).filter(Boolean).length} ${t.length}`; }
      case 'sort': { const l = lines(text()); const numeric = flags.some((f) => f.includes('n')); const rev = flags.some((f) => f.includes('r'));
        l.sort((x, y) => (numeric ? parseFloat(x) - parseFloat(y) : x.localeCompare(y))); if (rev) l.reverse(); return l.join('\n'); }
      case 'uniq': { const l = lines(text()); const out = []; for (const x of l) { if (out.length && out[out.length - 1][1] === x) out[out.length - 1][0]++; else out.push([1, x]); }
        return out.map(([n, x]) => (flags.some((f) => f.includes('c')) ? `${String(n).padStart(7)} ${x}` : x)).join('\n'); }
      case 'cut': {
        const d = (a.find((x) => x.startsWith('-d')) || '-d\t').slice(2) || a[a.indexOf('-d') + 1] || '\t';
        const fi = a.find((x) => x.startsWith('-f')); const f = +(fi.length > 2 ? fi.slice(2) : a[a.indexOf('-f') + 1]);
        const files = args.filter((x) => x !== d && x !== String(f));
        return lines(files.length ? files.map(read).join('\n') : input ?? '').map((l) => l.split(d === "' '" ? ' ' : d.replace(/'/g, ''))[f - 1] ?? '').join('\n');
      }
      case 'awk': {
        const pi = a.findIndex((x) => /\{\s*print\s+\$\d+\s*\}/.test(x));
        const prog = pi >= 0 && a[pi].match(/\{\s*print\s+\$(\d+)\s*\}/);
        if (!prog) throw new ShellError("awk: this lab supports '{print $N}'");
        const files = a.slice(pi + 1);
        const src = files.length ? files.map(read).join('\n') : input ?? '';
        return lines(src).map((l) => l.trim().split(/\s+/)[+prog[1] - 1] ?? '').join('\n');
      }
      case 'touch': need(1, 'touch: missing file operand'); for (const f of args) this.create(f, 'f'); this.opts.onChange?.(); return '';
      case 'mkdir': need(1, 'mkdir: missing operand'); for (const f of args) this.create(f, 'd'); this.opts.onChange?.(); return '';
      case 'rm': {
        need(1, 'rm: missing operand');
        for (const f of args) {
          const p = this.abs(f); const n = this.s.fs[p];
          if (!n) throw new ShellError(`rm: cannot remove '${f}': No such file or directory`);
          if (n.t === 'd' && !flags.some((x) => x.includes('r'))) throw new ShellError(`rm: cannot remove '${f}': Is a directory`);
          if (!this.can(this.s.fs[this.parent(p)], 2)) throw new ShellError(`rm: cannot remove '${f}': Permission denied`);
          for (const k of Object.keys(this.s.fs)) if (k === p || k.startsWith(`${p}/`)) delete this.s.fs[k];
        }
        this.opts.onChange?.(); return '';
      }
      case 'cp': case 'mv': {
        need(2, `${cmd}: missing file operand`);
        const src = this.abs(args[0]); let dst = this.abs(args[1]); const n = this.s.fs[src];
        if (!n) throw new ShellError(`${cmd}: cannot stat '${args[0]}': No such file or directory`);
        if (this.s.fs[dst]?.t === 'd') dst = `${dst}/${src.split('/').pop()}`;
        if (!this.can(this.s.fs[this.parent(dst)] || {}, 2)) throw new ShellError(`${cmd}: cannot create regular file '${args[1]}': Permission denied`);
        this.s.fs[dst] = { ...n, owner: cmd === 'cp' ? this.me() : n.owner, group: cmd === 'cp' ? this.me() : n.group };
        if (cmd === 'mv') delete this.s.fs[src];
        this.opts.onChange?.(); return '';
      }
      case 'chmod': {
        need(2, 'chmod: missing operand');
        const [mode, ...files] = args;
        for (const f of files) {
          const p = this.abs(f); const n = this.s.fs[p];
          if (!n) throw new ShellError(`chmod: cannot access '${f}': No such file or directory`);
          if (!this.root && n.owner !== this.me()) throw new ShellError(`chmod: changing permissions of '${f}': Operation not permitted`);
          n.mode = applyMode(n.mode, mode);
          if (!n.mode) throw new ShellError(`chmod: invalid mode: '${mode}'`);
        }
        this.opts.onChange?.(); return '';
      }
      case 'chown': {
        need(2, 'chown: missing operand');
        if (!this.root) throw new ShellError(`chown: changing ownership of '${args[1]}': Operation not permitted`);
        const [ug, ...files] = args; const [u, g] = ug.split(':');
        if (u && !this.s.users[u]) throw new ShellError(`chown: invalid user: '${ug}'`);
        for (const f of files) { const n = this.s.fs[this.abs(f)]; if (!n) throw new ShellError(`chown: cannot access '${f}': No such file or directory`); if (u) n.owner = u; if (g) n.group = g; }
        this.opts.onChange?.(); return '';
      }
      case 'find': {
        const start = this.abs(args[0] && !args[0].startsWith('-') ? args[0] : '.');
        const ni = a.indexOf('-name'); const pat = ni >= 0 ? a[ni + 1].replace(/['"]/g, '') : '*';
        const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        return Object.keys(this.s.fs).filter((k) => (k === start || k.startsWith(`${start === '/' ? '' : start}/`)) && re.test(k.split('/').pop())).sort().join('\n');
      }
      case 'sed': {
        // sed -i 's/old/new/[g]' file
        const expr = a.find((x) => /^['"]?s(.).*\1.*\1g?['"]?$/.test(x));
        const file = args[args.length - 1];
        if (!expr || !flags.includes('-i') || !file || file === expr) throw new ShellError("sed: this lab supports: sed -i 's/old/new/' FILE");
        const e = expr.replace(/^['"]|['"]$/g, ''); const sep = e[1]; const [, from, to, opt] = e.split(sep);
        const p = this.abs(file); const n = this.s.fs[p];
        if (!n) throw new ShellError(`sed: can't read ${file}: No such file or directory`);
        if (!this.can(n, 2)) throw new ShellError(`sed: couldn't open temporary file ${this.parent(p)}/sedXyZ12: Permission denied`);
        const re = new RegExp(from.replace(/[.+?^${}()|[\]\\]/g, (m) => (m === '.' || m === '^' || m === '$' ? m : `\\${m}`)), opt === 'g' ? 'g' : '');
        n.content = n.content.split('\n').map((l) => l.replace(re, to)).join('\n');
        this.opts.onChange?.(); return '';
      }
      case 'useradd': {
        if (!this.root) throw new ShellError('useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.');
        const u = args[0]; if (!u) throw new ShellError('Usage: useradd [options] LOGIN');
        if (this.s.users[u]) throw new ShellError(`useradd: user '${u}' already exists`);
        this.s.users[u] = { groups: [u] };
        if (flags.includes('-m')) this.s.fs[`/home/${u}`] = { t: 'd', mode: '750', owner: u, group: u };
        this.opts.onChange?.(); return '';
      }
      case 'usermod': {
        if (!this.root) throw new ShellError('usermod: Permission denied.');
        const gi = a.findIndex((x) => /^-a?G$|^-aG$/.test(x)); const groupsArg = gi >= 0 ? a[gi + 1] : null; const u = a[a.length - 1];
        if (!groupsArg || !this.s.users[u]) throw new ShellError('Usage: usermod -aG GROUP USER');
        const append = a[gi].includes('a');
        const gs = groupsArg.split(',');
        this.s.users[u].groups = append ? [...new Set([...this.s.users[u].groups, ...gs])] : [this.s.users[u].groups[0], ...gs];
        this.opts.onChange?.(); return '';
      }
      case 'ps': return `    PID USER     %CPU %MEM COMMAND\n${this.s.procs.map((p) => `${String(p.pid).padStart(7)} ${p.user.padEnd(8)} ${String(p.cpu ?? 0.1).padStart(4)} ${String(p.mem ?? 0.2).padStart(4)} ${p.cmd}`).join('\n')}`;
      case 'top': return 'top: interactive mode isn\'t available in this lab. Try: ps aux';
      case 'kill': {
        need(1, 'kill: usage: kill [-9] pid');
        for (const pidS of args) {
          const pid = +pidS; const p = this.s.procs.find((x) => x.pid === pid);
          if (!p) throw new ShellError(`bash: kill: (${pidS}) - No such process`);
          if (!this.root && p.user !== this.me()) throw new ShellError(`bash: kill: (${pidS}) - Operation not permitted`);
          this.s.procs = this.s.procs.filter((x) => x !== p);
        }
        this.opts.onChange?.(); return '';
      }
      case 'systemctl': {
        const [verb, svcRaw] = args; const name = (svcRaw || '').replace(/\.service$/, ''); const svc = this.s.services[name];
        if (!verb) throw new ShellError('systemctl: missing verb');
        if (verb === 'list-units') return Object.entries(this.s.services).map(([n, s]) => `${`${n}.service`.padEnd(28)}loaded ${s.active ? 'active   running' : 'inactive dead   '}`).join('\n');
        if (!svc) throw new ShellError(`Unit ${name}.service could not be found.`);
        if (verb === 'status') return `● ${name}.service - ${svc.desc || name}\n     Loaded: loaded (/lib/systemd/system/${name}.service; ${svc.enabled ? 'enabled' : 'disabled'})\n     Active: ${svc.active ? 'active (running) since Thu 2026-10-29 08:01:12 EDT' : 'inactive (dead)'}`;
        if (verb === 'is-active') return svc.active ? 'active' : 'inactive';
        if (verb === 'is-enabled') return svc.enabled ? 'enabled' : 'disabled';
        if (!this.root) throw new ShellError(`Failed to ${verb} ${name}.service: Access denied\n(Try again with sudo.)`);
        if (verb === 'start') svc.active = true;
        else if (verb === 'stop') svc.active = false;
        else if (verb === 'restart' || verb === 'reload') { svc.active = true; svc.restartedAt = Date.now(); }
        else if (verb === 'enable') { svc.enabled = true; if (flags.includes('--now')) svc.active = true; }
        else if (verb === 'disable') { svc.enabled = false; if (flags.includes('--now')) svc.active = false; }
        else throw new ShellError(`Unknown command verb ${verb}.`);
        this.opts.onChange?.(); return '';
      }
      case 'ufw': {
        const u = this.s.ufw;
        if (args[0] === 'status' && args[1] === 'numbered') return `Status: ${u.enabled ? 'active' : 'inactive'}\n\n     To                         Action      From\n${u.rules.map((r, i) => `[${String(i + 1).padStart(2)}] ${(r.port || 'Anywhere').padEnd(27)}${r.action.toUpperCase().padEnd(12)}${r.from || 'Anywhere'}`).join('\n')}`;
        if (args[0] === 'status') return u.enabled ? `Status: active\n\nTo                         Action      From\n--                         ------      ----\n${u.rules.map((r) => `${(r.port || 'Anywhere').padEnd(27)}${r.action.toUpperCase().padEnd(12)}${r.from || 'Anywhere'}`).join('\n')}` : 'Status: inactive';
        if (!this.root) throw new ShellError('ERROR: You need to be root to run this script');
        if (args[0] === 'enable') { u.enabled = true; this.opts.onChange?.(); return 'Firewall is active and enabled on system startup'; }
        if (args[0] === 'disable') { u.enabled = false; this.opts.onChange?.(); return 'Firewall stopped and disabled on system startup'; }
        if (args[0] === 'default') { u.defaultIn = args[1]; this.opts.onChange?.(); return `Default incoming policy changed to '${args[1]}'`; }
        // ufw [insert N] allow|deny|reject|limit (PORT | from IP [to any port P])
        const ins = args[0] === 'insert' ? Number(args[1]) : null;
        const ra = ins ? args.slice(2) : args;
        if (['allow', 'deny', 'reject', 'limit'].includes(ra[0])) {
          const action = ra[0]; let rule;
          if (ra[1] === 'from') rule = { action, from: ra[2], port: ra.includes('port') ? ra[ra.indexOf('port') + 1] : null };
          else rule = { action, port: ra[1] };
          if (!rule.from && !rule.port) throw new ShellError('ERROR: Wrong number of arguments');
          if (ins) { if (!(ins >= 1 && ins <= u.rules.length + 1)) throw new ShellError(`ERROR: Invalid position '${ins}'`); u.rules.splice(ins - 1, 0, rule); }
          else u.rules.push(rule);
          this.opts.onChange?.(); return ins ? 'Rule inserted' : 'Rule added';
        }
        if (args[0] === 'status' && args[1] === 'numbered') return u.rules.map((r, i) => `[${String(i + 1).padStart(2)}] ${(r.port || 'Anywhere').padEnd(24)}${r.action.toUpperCase().padEnd(12)}${r.from || 'Anywhere'}`).join('\n');
        if (args[0] === 'delete') { u.rules = u.rules.filter((r) => !(r.action === args[1] && (r.port === args[2] || (args[2] === 'from' && r.from === args[3])))); this.opts.onChange?.(); return 'Rule deleted'; }
        throw new ShellError('ERROR: Invalid syntax');
      }
      case 'apt': case 'apt-get': {
        if (!this.root) throw new ShellError(`E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock, are you root?`);
        if (args[0] === 'update') return 'Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nReading package lists... Done';
        if (args[0] === 'install') {
          const pk = args.slice(1); const bad = pk.find((x) => !this.s.available.includes(x) && !this.s.packages.includes(x));
          if (bad) throw new ShellError(`E: Unable to locate package ${bad}`);
          for (const x of pk) if (!this.s.packages.includes(x)) this.s.packages.push(x);
          // Like Ubuntu, packages that ship a service start it and enable it at boot when installed.
          for (const x of pk) if (this.s.pkgServices?.[x] && !this.s.services[x]) this.s.services[x] = { ...this.s.pkgServices[x] };
          this.opts.onChange?.(); return `Reading package lists... Done\nSetting up ${pk.join(', ')} ...\nDone.`;
        }
        if (args[0] === 'remove' || args[0] === 'purge') { this.s.packages = this.s.packages.filter((x) => !args.slice(1).includes(x)); this.opts.onChange?.(); return 'Removing ... Done.'; }
        throw new ShellError('E: Invalid operation');
      }
      case 'dpkg': return this.s.packages.map((p) => `ii  ${p}`).join('\n');
      case 'ss': case 'netstat': return `Netid State  Local Address:Port   Process\n${Object.entries(this.s.services).filter(([, s]) => s.active && s.port).map(([n, s]) => `tcp   LISTEN 0.0.0.0:${s.port}`.padEnd(37) + `users:(("${n}"))`).join('\n')}`;
      case 'ip': return `1: lo: <LOOPBACK,UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\n    inet ${this.s.ip}/24 brd ${this.s.ip.replace(/\d+$/, '255')} scope global eth0`;
      case 'ifconfig': return `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${this.s.ip}  netmask 255.255.255.0`;
      case 'ping': { const h = args[0]; const ok = this.s.net[h] ?? false; return ok ? `PING ${h} 56(84) bytes of data.\n64 bytes from ${h}: icmp_seq=1 ttl=64 time=0.42 ms\n64 bytes from ${h}: icmp_seq=2 ttl=64 time=0.39 ms\n\n--- ${h} ping statistics ---\n2 packets transmitted, 2 received, 0% packet loss` : `PING ${h} 56(84) bytes of data.\n\n--- ${h} ping statistics ---\n2 packets transmitted, 0 received, 100% packet loss`; }
      case 'df': return 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        40G   31G  7.2G  82% /\ntmpfs           2.0G     0  2.0G   0% /dev/shm';
      case 'nano': case 'vi': case 'vim': throw new ShellError(`${cmd}: full-screen editors aren't available in this lab. Use sed -i 's/old/new/' FILE or echo "text" >> FILE.`);
      default: throw new ShellError(`${cmd}: command not found`);
    }
  }
  create(f, t) {
    const p = this.abs(f); if (this.s.fs[p]) { if (t === 'd') throw new ShellError(`mkdir: cannot create directory '${f}': File exists`); return; }
    const dir = this.s.fs[this.parent(p)];
    if (!dir) throw new ShellError(`${t === 'd' ? 'mkdir' : 'touch'}: cannot create '${f}': No such file or directory`);
    if (!this.can(dir, 2)) throw new ShellError(`${t === 'd' ? 'mkdir' : 'touch'}: cannot ${t === 'd' ? 'create directory' : 'touch'} '${f}': Permission denied`);
    this.s.fs[p] = t === 'd' ? { t: 'd', mode: '775', owner: this.me(), group: this.me() } : { t: 'f', mode: '664', owner: this.me(), group: this.me(), content: '' };
  }
  complete(line) {
    const m = line.match(/^(.*?)(\S*)$/); const last = m[2]; if (!last) return line;
    const dirPart = last.includes('/') ? last.slice(0, last.lastIndexOf('/') + 1) : '';
    const base = this.abs(dirPart || '.'); const rest = last.slice(dirPart.length);
    const hits = Object.keys(this.s.fs).filter((k) => this.parent(k) === base && k !== base && k.split('/').pop().startsWith(rest));
    if (hits.length !== 1) return line;
    const n = this.s.fs[hits[0]]; return `${m[1]}${dirPart}${hits[0].split('/').pop()}${n.t === 'd' ? '/' : ' '}`;
  }
}

class ShellError extends Error {}
function tokenize(s) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (const ch of s.trim()) {
    if (q) { if (ch === q) { q = null; } else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
// Split on | outside quotes.
function splitPipes(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '|') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
// chmod: octal (755) or symbolic (u+x, go-w, a=r, +x).
function applyMode(cur, spec) {
  if (/^[0-7]{3}$/.test(spec)) return spec;
  if (/^[0-7]{4}$/.test(spec)) return spec.slice(1);
  const digits = [...cur].map(Number);
  for (const part of spec.split(',')) {
    const m = part.match(/^([ugoa]*)([+\-=])([rwx]+)$/); if (!m) return null;
    const who = (m[1] || 'a').replace('a', 'ugo'); const bits = [...m[3]].reduce((n, c) => n | { r: 4, w: 2, x: 1 }[c], 0);
    for (const w of new Set(who)) {
      const i = 'ugo'.indexOf(w);
      digits[i] = m[2] === '+' ? digits[i] | bits : m[2] === '-' ? digits[i] & ~bits : bits;
    }
  }
  return digits.join('');
}

// Linux shell simulator for labs: a virtual filesystem with owners, permission bits, special
// bits, ACLs, symbolic links and SELinux labels; sudo and root shells; pipes, redirection,
// command lists (; and &&) and variables; and the text tools. System administration
// (packages, services, storage, networking, SELinux, firewalld, scheduling, reboot) lives in
// labs-linux-admin.js and the modules it uses. Ubuntu is the default; labs set distro: "rhel"
// for Red Hat Enterprise Linux behavior.
import { ShellError, policyCtx, parentOf } from './labs-linux-base.js';
import { admin, extendState, canSudo, virtualFile, human, linuxQuery } from './labs-linux-admin.js';
import { ctxString, ctxOf } from './labs-linux-sec.js';

export { linuxQuery };

export function newLinux(def) {
  const fs = { '/': { t: 'd', mode: '755', owner: 'root', group: 'root' } };
  const add = (path, node) => {
    const parts = path.split('/').filter(Boolean); let cur = '';
    for (const p of parts.slice(0, -1)) { cur += `/${p}`; fs[cur] ||= { t: 'd', mode: '755', owner: 'root', group: 'root' }; }
    fs[path] = node;
  };
  for (const [path, f] of Object.entries(def.files || {})) {
    const meta = { mode: f.mode || (f.dir ? '755' : '644'), owner: f.owner || 'root', group: f.group || f.owner || 'root', ...(f.sp ? { sp: f.sp } : {}), ...(f.ctx ? { ctx: f.ctx } : {}), ...(f.acl ? { acl: f.acl } : {}) };
    if (f.link) add(path, { t: 'l', target: f.link, ...meta, mode: '777' });
    else if (f.dir) add(path, { t: 'd', ...meta });
    else add(path, { t: 'f', ...meta, content: Array.isArray(f.content) ? f.content.join('\n') : f.content || '', ...(f.size != null ? { size: f.size } : {}) });
  }
  const user = def.user || 'student';
  // The user's home is theirs unless the lab defines it explicitly.
  if (!def.files?.[`/home/${user}`]) add(`/home/${user}`, { t: 'd', mode: def.distro === 'rhel' ? '700' : '750', owner: user, group: user });
  const sys = {
    name: def.name, platform: 'linux', hostname: def.hostname || def.name, user, cwd: `/home/${user}`, fs,
    users: { root: { groups: ['root'] }, [user]: { groups: [user, 'sudo'] }, ...(def.users || {}) },
    services: JSON.parse(JSON.stringify(def.services || {})), procs: def.procs || [], packages: [...(def.packages || [])], available: def.available || [],
    ufw: { enabled: false, rules: [], ...(def.ufw || {}) }, pkgServices: { nginx: { active: true, enabled: true, port: 80, desc: 'A high performance web server' }, apache2: { active: true, enabled: true, port: 80 }, ...(def.pkgServices || {}) }, ip: def.ip || '10.0.0.10', net: def.net || {}, web: def.web || {}, nextPid: 4000,
    shell: { stack: [] }, vars: {},
  };
  return extendState(sys, def);
}

const rwx = (d) => { const n = +d; return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`; };
function modeString(n) {
  if (n.t === 'l') return 'lrwxrwxrwx';
  const [u, g, o] = [...n.mode].map(rwx); const sp = n.sp || 0;
  const set = (s, bit, ch) => (sp & bit ? s.slice(0, 2) + (s[2] === 'x' ? ch : ch.toUpperCase()) : s);
  return `${n.t === 'd' ? 'd' : '-'}${set(u, 4, 's')}${set(g, 2, 's')}${set(o, 1, 't')}${n.acl && Object.keys(n.acl).length ? '+' : ''}`;
}
const BIN = new Set(['ls', 'cd', 'pwd', 'cat', 'head', 'tail', 'grep', 'egrep', 'wc', 'sort', 'uniq', 'cut', 'awk', 'tr', 'echo', 'printf', 'touch', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'chmod', 'chown', 'chgrp', 'find', 'sed', 'tee', 'umask', 'stat', 'whoami', 'ps', 'top', 'kill', 'pkill', 'killall', 'nice', 'renice', 'ufw', 'apt', 'apt-get', 'dpkg', 'history', 'help', 'clear', 'export', 'env', 'exit', 'logout', 'su', 'sudo', 'test', 'true', 'false', 'vi', 'vim', 'nano', 'sleep', 'bash', 'sh', 'source']);

export class LinuxSession {
  constructor(sys, opts = {}) { this.s = sys; this.opts = opts; this.history = []; this.root = false; this.s.shell ||= { stack: [] }; this.s.vars ||= {}; }
  // Interactive identity: the lab user, or root after sudo -i / su -, or another user after su - NAME.
  get shellUser() { return this.s.shell.stack.length ? this.s.shell.stack[this.s.shell.stack.length - 1].user : this.s.user; }
  get rootShell() { return this.shellUser === 'root'; }
  set rootShell(v) { if (!v) this.s.shell.stack = []; else this.s.shell.stack.push({ user: 'root', cwd: this.s.cwd }); }
  get umask() { return this.s.shell.umask?.[this.shellUser] ?? (this.shellUser === 'root' || this.s.distro !== 'rhel' && this.shellUser === 'root' ? '0022' : '0002'); }
  prompt() {
    const u = this.shellUser; const home = this.s.users[u]?.home || `/home/${u}`; const sign = u === 'root' ? '#' : '$';
    const cwd = this.s.cwd === home ? '~' : this.s.cwd.startsWith(`${home}/`) ? `~${this.s.cwd.slice(home.length)}` : this.s.cwd;
    if (this.s.distro === 'rhel') return `[${u}@${this.s.hostname.split('.')[0]} ${cwd === '~' ? '~' : cwd.split('/').pop() || '/'}]${sign} `;
    return `${u}@${this.s.hostname}:${cwd}${sign} `;
  }
  abs(p) {
    if (!p) return this.s.cwd;
    if (p === '~' || p.startsWith('~/')) p = `${this.s.users[this.shellUser]?.home || `/home/${this.shellUser}`}${p.slice(1)}`;
    else if (/^~\w/.test(p)) { const [u, ...rest] = p.slice(1).split('/'); p = `${this.s.users[u]?.home || `/home/${u}`}${rest.length ? `/${rest.join('/')}` : ''}`; }
    const parts = (p.startsWith('/') ? p : `${this.s.cwd}/${p}`).split('/'); const out = [];
    for (const x of parts) { if (!x || x === '.') continue; if (x === '..') out.pop(); else out.push(x); }
    return `/${out.join('/')}`;
  }
  // Resolve symbolic links in every component of an absolute path.
  follow(path) {
    let p = path; for (let hops = 0; hops < 16; hops++) {
      const parts = p.split('/').filter(Boolean); let cur = ''; let changed = false;
      for (let i = 0; i < parts.length; i++) {
        cur += `/${parts[i]}`; const n = this.s.fs[cur];
        if (n?.t === 'l') { const t = n.target.startsWith('/') ? n.target : `${parentOf(cur)}/${n.target}`; p = this.abs(`${t}/${parts.slice(i + 1).join('/')}`); changed = true; break; }
      }
      if (!changed) return p;
    }
    return p;
  }
  node(p) { return this.s.fs[this.follow(this.abs(p))]; }
  me() { return this.root ? 'root' : this.shellUser; }
  primary(u = this.me()) { return this.s.users[u]?.groups?.[0] || u; }
  inGroup(g) { return (this.s.users[this.me()]?.groups || []).includes(g); }
  can(node, bit) { // bit: 4 read, 2 write, 1 exec
    if (this.root || this.me() === 'root') return true;
    if (!node?.mode) return false;
    const [u, g, o] = [...node.mode].map(Number); const me = this.me();
    if (node.owner === me) return !!(u & bit);
    const ua = node.acl?.[`u:${me}`]; if (ua) return ua.includes('rwx'['421'.indexOf(String(bit))]) ;
    if (this.inGroup(node.group)) return !!(g & bit);
    for (const [k, v] of Object.entries(node.acl || {})) if (k.startsWith('g:') && this.inGroup(k.slice(2))) return v.includes('rwx'['421'.indexOf(String(bit))]);
    return !!(o & bit);
  }
  parent(p) { return parentOf(p); }
  // Create or overwrite a file the way a shell redirect or tee would.
  writeFile(path, content, append = false) {
    const p = this.follow(path); const node = this.s.fs[p]; const dir = this.s.fs[parentOf(p)];
    if (!dir) throw new ShellError(`bash: ${path}: No such file or directory`);
    if (node?.t === 'd') throw new ShellError(`bash: ${path}: Is a directory`);
    if (node ? !this.can(node, 2) : !this.can(dir, 2)) throw new ShellError(`bash: ${path}: Permission denied`);
    if (node) { node.content = append ? `${node.content}${node.content && !node.content.endsWith('\n') ? '\n' : ''}${content}` : content; delete node.size; delete node.archive; }
    else this.s.fs[p] = this.newNode(p, 'f', content);
    this.opts.onChange?.();
  }
  newNode(p, t, content = '') {
    const dir = this.s.fs[parentOf(p)]; const um = parseInt(this.umask, 8);
    const mode = ((t === 'd' ? 0o777 : 0o666) & ~um).toString(8).padStart(3, '0');
    const group = dir?.sp & 2 ? dir.group : this.primary();
    const n = t === 'd' ? { t: 'd', mode, owner: this.me(), group } : { t: 'f', mode, owner: this.me(), group, content };
    if (t === 'd' && dir?.sp & 2) n.sp = 2;
    if (this.s.selinux) n.ctx = dir?.ctx || policyCtx(this.s, p);
    return n;
  }
  readFile(p0) {
    const ap = this.abs(p0); const v = virtualFile(this.s, ap, this.root || this.me() === 'root');
    if (v === null) throw new ShellError(`${p0}: Permission denied`); if (v !== undefined) return v;
    const p = this.follow(ap); const n = this.s.fs[p];
    if (!n) throw new ShellError(`${p0}: No such file or directory`);
    if (n.t === 'd') throw new ShellError(`${p0}: Is a directory`);
    for (let d = parentOf(p); d !== '/'; d = parentOf(d)) if (this.s.fs[d] && !this.can(this.s.fs[d], 1)) throw new ShellError(`${p0}: Permission denied`);
    if (!this.can(n, 4)) throw new ShellError(`${p0}: Permission denied`);
    if (n.archive || n.packed) return '(binary data)';
    return n.content;
  }
  expand(str) {
    const v = { HOME: this.s.users[this.shellUser]?.home, USER: this.shellUser, HOSTNAME: this.s.hostname, PWD: this.s.cwd, PATH: '/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin', SHELL: '/bin/bash', ...this.s.vars };
    return str.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => v[a || b] ?? '');
  }
  run(raw) {
    const line = raw.trim(); if (!line) return '';
    this.history.push(line);
    // Command lists: a; b and a && b (outside quotes).
    const parts = splitList(line); const outs = [];
    try {
      for (const { cmd, op } of parts) {
        if (op === '&&' && this.lastFailed) break;
        if (op === '||' && !this.lastFailed) continue;
        const o = this.runOne(cmd); if (o) outs.push(o);
      }
    } finally { this.root = false; this.sudoAs = null; }
    return outs.join('\n');
  }
  runOne(line) {
    this.lastFailed = false;
    if (/^\w+=\S*$/.test(line)) { const [k, ...v] = line.split('='); this.s.vars[k] = v.join('=').replace(/^['"]|['"]$/g, ''); return ''; }
    const { body, out, append, input, quiet, merge } = redirects(line);
    const stages = splitPipes(body);
    let data = input ? this.readFile(input) : null; let text = '';
    try {
      for (const st of stages) { text = this.exec(tokenize(this.expandQuoted(st)), data); data = text; }
    } catch (e) {
      this.lastFailed = true; this.root = false;
      if (!(e instanceof ShellError)) throw e;
      if (quiet) return ''; if (merge && out) { try { this.root = /^sudo\s/.test(body) && false; this.writeFile(this.abs(out), e.message, append); } catch (w) { return w.message; } return ''; }
      return e.message;
    }
    if (out) {
      this.root = this.rootShell; // like bash, "sudo cmd > file" still writes as the calling user
      try { if (out === '/dev/null') return ''; this.writeFile(this.abs(out), text, append); } catch (e) { this.lastFailed = true; return e instanceof ShellError ? e.message : String(e); }
      return '';
    }
    return text;
  }
  // Expand $VARS except inside single quotes.
  expandQuoted(s) { let out = ''; let q = null; let buf = ''; for (const ch of s) { if (q === "'") { buf += ch; if (ch === "'") { out += buf; buf = ''; q = null; } continue; } if (ch === "'" && !q) { out += this.expand(buf); buf = ch; q = "'"; continue; } if (ch === '"') q = q === '"' ? null : '"'; buf += ch; } return q === "'" ? out + buf : out + this.expand(buf); }
  exec(argv, input) {
    let [cmd, ...a] = argv;
    if (cmd === 'sudo') {
      if (!canSudo(this.s, this.shellUser)) throw new ShellError(`${this.shellUser} is not in the sudoers file.  This incident will be reported.`);
      if (a[0] === '-l') return `User ${this.shellUser} may run the following commands on ${this.s.hostname}:\n    (ALL) ALL`;
      if (a[0] === '-i' || a[0] === '-s' || (a[0] === 'su' && (a[1] === '-' || !a[1]))) { this.s.shell.stack.push({ user: 'root', cwd: this.s.cwd }); this.s.cwd = a[0] === '-s' ? this.s.cwd : '/root'; return ''; }
      if (a[0] === '-u') { this.sudoAs = a[1]; a = a.slice(2); if (!this.s.users[this.sudoAs]) throw new ShellError(`sudo: unknown user ${this.sudoAs}`); }
      else this.root = true;
      [cmd, ...a] = a;
      if (!cmd) throw new ShellError('usage: sudo command');
      if (this.sudoAs) { const prev = this.s.shell.stack.slice(); this.s.shell.stack.push({ user: this.sudoAs, cwd: this.s.cwd }); try { return this.exec([cmd, ...a], input); } finally { this.s.shell.stack = prev; } }
    }
    if (this.me() === 'root') this.root = true;
    const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x));
    const need = (n, use) => { if (args.length < n) throw new ShellError(use); };
    const read = (p) => { try { return this.readFile(p); } catch (e) { throw new ShellError(`${cmd}: ${e.message}`); } };
    const text = () => (args.length ? args.map(read).join('\n') : input ?? '');
    const lines = (t) => (t === '' || t == null ? [] : String(t).replace(/\n$/, '').split('\n'));
    const changed = () => this.opts.onChange?.();
    if (this.s.emergency && !['cat', 'vi', 'vim', 'nano', 'sed', 'systemctl', 'reboot', 'ls', 'echo', 'mount', 'blkid', 'lsblk', 'findmnt', 'journalctl', 'grep', 'tee', 'exit', 'cp', 'umount', 'help', 'clear', 'head', 'tail', 'history', 'df', 'mkdir'].includes(cmd)) throw new ShellError(`${cmd}: not available in emergency mode. Fix /etc/fstab (for example with vi /etc/fstab), then run systemctl reboot.`);
    switch (cmd) {
      case 'whoami': return this.me();
      case 'pwd': return this.s.cwd;
      case 'clear': this.opts.clear?.(); return '';
      case 'true': return ''; case 'false': this.lastFailed = true; throw new ShellError('');
      case 'sleep': return '';
      case 'help': return `Commands in this lab include:\n  files: ls cd pwd cat head tail touch mkdir rmdir rm cp mv ln find tar du stat file vi nano\n  text:  grep sort uniq wc cut awk tr sed tee echo printf\n  users: whoami id groups useradd usermod userdel groupadd passwd chage chmod chown chgrp setfacl getfacl umask sudo su\n  system: ps kill renice systemctl journalctl ${this.s.distro === 'rhel' ? 'dnf rpm firewall-cmd getenforce setenforce semanage restorecon setsebool nmcli hostnamectl timedatectl chronyc tuned-adm crontab at grubby' : 'apt ufw crontab'}\n  storage: lsblk blkid ${this.s.distro === 'rhel' ? 'parted pvcreate vgcreate lvcreate lvextend mkfs.xfs mkfs.ext4 mkswap swapon ' : ''}mount umount df free\n  network: ip ping ss curl ssh ssh-keygen ssh-copy-id\n  other: reboot history clear exit\nCombine commands with |, ;, &&, > and >>.`;
      case 'history': return this.history.map((h, i) => `  ${i + 1}  ${h}`).join('\n');
      case 'export': for (const x of args) { const [k, ...v] = x.split('='); if (v.length) this.s.vars[k] = v.join('='); } return '';
      case 'env': return Object.entries({ USER: this.shellUser, HOME: this.s.users[this.shellUser]?.home, ...this.s.vars }).map(([k, v]) => `${k}=${v}`).join('\n');
      case 'exit': case 'logout': {
        if (this.s.shell.stack.length) { const top = this.s.shell.stack.pop(); this.s.cwd = top.cwd || this.s.cwd; return 'logout'; }
        return 'logout\n(The lab keeps your session open.)';
      }
      case 'su': {
        const target = args[0] || 'root';
        if (!this.s.users[target]) throw new ShellError(`su: user ${target} does not exist or the user entry does not contain all the required fields`);
        if (target !== 'root' && this.s.users[target].shell?.includes('nologin')) throw new ShellError('This account is currently not available.');
        if (this.shellUser !== 'root' && target === 'root') return 'Password: \nsu: Authentication failure\n(Root logins with a password are disabled here. Use sudo -i instead.)';
        if (this.shellUser !== 'root') return 'Password: \nsu: Authentication failure (use sudo -i first, then su - USER)';
        this.s.shell.stack.push({ user: target, cwd: this.s.cwd }); if (a.includes('-') || a.includes('-l')) this.s.cwd = this.s.users[target].home; return '';
      }
      case 'echo': {
        const e = flags.includes('-e'); const n = flags.includes('-n'); const words = a.filter((x, i) => !(i === a.indexOf(x) && /^-[en]+$/.test(x) && a.slice(0, i).every((y) => /^-[en]+$/.test(y))));
        const t = words.join(' '); return e ? t.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : t + (n ? '' : '');
      }
      case 'printf': { if (!a.length) throw new ShellError('printf: usage: printf FORMAT [ARGUMENTS]'); let i = 1; return a[0].replace(/%s/g, () => a[i++] ?? '').replace(/%d/g, () => a[i++] ?? '0').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\n$/, ''); }
      case 'cd': {
        const p = this.follow(this.abs(args[0] || '~')); const n = this.s.fs[p];
        if (!n) throw new ShellError(`bash: cd: ${args[0]}: No such file or directory`);
        if (n.t !== 'd') throw new ShellError(`bash: cd: ${args[0]}: Not a directory`);
        if (!this.can(n, 1)) throw new ShellError(`bash: cd: ${args[0]}: Permission denied`);
        this.s.cwd = p; return '';
      }
      case 'ls': {
        const f = flags.join(''); const long = /l/.test(f); const all = /a/.test(f); const dirOnly = /d/.test(f); const Z = /Z/.test(f); const h = /h/.test(f); const R = /R/.test(f);
        const targets = args.length ? args : ['.']; const out = [];
        for (const t of targets) {
          const lp = this.abs(t); const ln = this.s.fs[lp]; const p = long && ln?.t === 'l' && !t.endsWith('/') ? lp : this.follow(lp); const n = this.s.fs[p];
          if (!n) { out.push(`ls: cannot access '${t}': No such file or directory`); continue; }
          let entries;
          if (n.t === 'd' && !dirOnly) {
            if (!this.can(n, 4)) { out.push(`ls: cannot open directory '${t}': Permission denied`); continue; }
            entries = Object.keys(this.s.fs).filter((k) => k !== p && (R ? k.startsWith(`${p === '/' ? '' : p}/`) : parentOf(k) === p)).sort();
            entries = entries.filter((k) => all || !k.slice(p.length).split('/').some((x) => x.startsWith('.')));
            if (all) entries = ['.', '..', ...entries];
          } else entries = [p];
          const name = (k) => (k === '.' || k === '..' ? k : entries.length === 1 && k === p && n.t !== 'd' ? t : R ? k.slice(p.length + 1) : dirOnly ? t : k.split('/').pop());
          if (targets.length > 1 && n.t === 'd' && !dirOnly) out.push(`${t}:`);
          if (!long) { out.push(entries.map((k) => `${Z ? `${ctxString(k === '.' || k === '..' ? ctxOf(this.s, p) : ctxOf(this.s, k))} ` : ''}${name(k)}`).join(Z ? '\n' : '  ')); continue; }
          const rows = entries.map((k) => { const x = k === '.' || k === '..' ? n : this.s.fs[k]; const sz = x.t === 'd' ? 4096 : x.t === 'l' ? x.target.length : x.size ?? (x.content || '').length;
            return `${modeString(x)} ${String(x.t === 'd' ? 2 : x.links || 1).padStart(2)} ${x.owner.padEnd(8)} ${x.group.padEnd(8)} ${Z ? `${ctxString(k === '.' || k === '..' ? ctxOf(this.s, p) : ctxOf(this.s, k))} ` : ''}${String(h ? human(sz) : sz).padStart(h ? 5 : 7)} Oct 29 09:12 ${name(k)}${x.t === 'l' ? ` -> ${x.target}` : ''}`; });
          out.push(`${n.t === 'd' && !dirOnly ? `total ${entries.length * 4}\n` : ''}${rows.join('\n')}`);
        }
        return out.join('\n');
      }
      case 'stat': { need(1, 'stat: missing operand'); return args.map((t) => { const p = this.abs(t); const n = this.s.fs[p] || this.s.fs[this.follow(p)]; if (!n) throw new ShellError(`stat: cannot statx '${t}': No such file or directory`); return `  File: ${t}${n.t === 'l' ? ` -> ${n.target}` : ''}\n  Size: ${n.size ?? (n.content || '').length}\tBlocks: 8\t${n.t === 'd' ? 'directory' : n.t === 'l' ? 'symbolic link' : 'regular file'}\nAccess: (${n.sp || 0}${n.mode}/${modeString(n)})  Uid: ( ${this.s.users[n.owner]?.uid ?? '?'}/${n.owner})   Gid: ( ${this.s.groups?.[n.group]?.gid ?? '?'}/${n.group})${this.s.selinux ? `\nContext: ${ctxString(ctxOf(this.s, p))}` : ''}`; }).join('\n'); }
      case 'cat': need(1, 'usage: cat FILE'); return args.map(read).join('\n');
      case 'head': case 'tail': {
        if (cmd === 'tail' && flags.includes('-f')) { const t = args.map(read).join('\n'); return `${lines(t).slice(-10).join('\n')}\n(tail -f would keep waiting for new lines; this lab stops here.)`; }
        const nf = a.indexOf('-n'); const n = nf >= 0 ? +a[nf + 1] : (flags.find((f) => /^-\d+$/.test(f)) ? +flags.find((f) => /^-\d+$/.test(f)).slice(1) : 10);
        const files = args.filter((x) => !(nf >= 0 && x === a[nf + 1]));
        const l = lines(files.length ? files.map(read).join('\n') : input ?? '');
        return (cmd === 'head' ? l.slice(0, n) : l.slice(-n)).join('\n');
      }
      case 'grep': case 'egrep': {
        need(1, 'Usage: grep [OPTION]... PATTERNS [FILE]...');
        const f = flags.filter((x) => !x.startsWith('--')).join(''); const ere = cmd === 'egrep' || /E/.test(f);
        const i = /i/.test(f); const v = /v/.test(f); const c = /c/.test(f); const nflag = /n/.test(f); const l = /l/.test(f); const r = /[rR]/.test(f); const w = /w/.test(f); const o = /o/.test(f);
        const [pat0, ...targets] = args; const eIdx = a.indexOf('-e'); const pat = eIdx >= 0 ? a[eIdx + 1] : pat0; const files0 = eIdx >= 0 ? args.filter((x) => x !== pat) : targets;
        let src = pat; if (!ere) src = src.replace(/\\\|/g, '|').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/(^|[^\\])([+?{}|()])/g, '$1\\$2');
        if (w) src = `\\b(?:${src})\\b`;
        let re; try { re = new RegExp(src, i ? 'gi' : 'g'); } catch { throw new ShellError(`grep: Invalid regular expression`); }
        const test = (s) => { re.lastIndex = 0; return re.test(s); };
        let files = files0;
        if (r) files = (files.length ? files : ['.']).flatMap((x) => { const p = this.follow(this.abs(x)); return Object.keys(this.s.fs).filter((k) => (k === p || k.startsWith(`${p === '/' ? '' : p}/`)) && this.s.fs[k].t === 'f').sort(); });
        const many = files.length > 1 || r; const out = []; let errs = [];
        if (!files.length) { const hits = lines(input ?? '').map((s, k) => [s, k]).filter(([s]) => test(s) !== v); this.lastFailed = !hits.length; return c ? String(hits.length) : hits.map(([s, k]) => (o ? s.match(re)?.join('\n') ?? '' : `${nflag ? `${k + 1}:` : ''}${s}`)).join('\n'); }
        for (const fl of files) {
          let t; try { t = this.readFile(fl); } catch (e) { if (!r || !/Permission/.test(e.message)) errs.push(`grep: ${e.message}`); else errs.push(`grep: ${fl}: Permission denied`); continue; }
          const hits = lines(t).map((s, k) => [s, k]).filter(([s]) => test(s) !== v);
          if (l) { if (hits.length) out.push(fl); continue; }
          if (c) { out.push(`${many ? `${fl}:` : ''}${hits.length}`); continue; }
          for (const [s, k] of hits) out.push(`${many ? `${fl}:` : ''}${nflag ? `${k + 1}:` : ''}${o ? (s.match(re) || []).join('\n') : s}`);
        }
        this.lastFailed = !out.length;
        return [...out, ...errs].join('\n');
      }
      case 'wc': { const t = text(); const l = lines(t); const f = flags.join(''); if (/l/.test(f)) return String(l.length); if (/w/.test(f)) return String(t.split(/\s+/).filter(Boolean).length); if (/c/.test(f)) return String(t.length); return `${l.length} ${t.split(/\s+/).filter(Boolean).length} ${t.length}`; }
      case 'sort': {
        const f = flags.join(''); const kIdx = a.indexOf('-k'); const key = kIdx >= 0 ? parseInt(a[kIdx + 1], 10) : null; const tIdx = a.indexOf('-t'); const sep = tIdx >= 0 ? a[tIdx + 1] : null;
        const files = args.filter((x) => x !== a[kIdx + 1] && x !== a[tIdx + 1]); const l = lines(files.length ? files.map(read).join('\n') : input ?? '');
        const k = (x) => (key ? (sep ? x.split(sep) : x.trim().split(/\s+/))[key - 1] ?? '' : x);
        const hv = (x) => { const m = String(x).trim().match(/^([\d.]+)([KMGT]?)/i); return m ? parseFloat(m[1]) * 1024 ** ' KMGT'.indexOf((m[2] || ' ').toUpperCase()) : 0; };
        l.sort((x, y) => (/h/.test(f) ? hv(k(x)) - hv(k(y)) : /n/.test(f) ? parseFloat(k(x)) - parseFloat(k(y)) : k(x).localeCompare(k(y))));
        if (/r/.test(f)) l.reverse(); return (/u/.test(f) ? [...new Set(l)] : l).join('\n');
      }
      case 'uniq': { const l = lines(text()); const out = []; for (const x of l) { if (out.length && out[out.length - 1][1] === x) out[out.length - 1][0]++; else out.push([1, x]); }
        return out.map(([n, x]) => (flags.some((f) => f.includes('c')) ? `${String(n).padStart(7)} ${x}` : x)).join('\n'); }
      case 'cut': {
        const d = (a.find((x) => x.startsWith('-d') && x.length > 2) || '').slice(2) || (a.indexOf('-d') >= 0 ? a[a.indexOf('-d') + 1] : '\t');
        const fi = a.find((x) => x.startsWith('-f')); if (!fi) throw new ShellError('cut: you must specify a list of fields (-f N)');
        const fs = (fi.length > 2 ? fi.slice(2) : a[a.indexOf('-f') + 1]).split(',').map(Number);
        const files = args.filter((x) => x !== d && x !== a[a.indexOf('-f') + 1]);
        return lines(files.length ? files.map(read).join('\n') : input ?? '').map((l) => fs.map((f) => l.split(d)[f - 1] ?? '').join(d)).join('\n');
      }
      case 'awk': {
        const fsIdx = a.indexOf('-F'); const fsArg = fsIdx >= 0 ? a[fsIdx + 1] : (a.find((x) => x.startsWith('-F') && x.length > 2) || '').slice(2) || null;
        const pi = a.findIndex((x) => /\{\s*print\b/.test(x));
        const prog = pi >= 0 && a[pi].match(/^\s*(?:\/(.*)\/|\$(\d+)\s*==\s*"([^"]*)")?\s*\{\s*print\s+([^}]*)\}\s*$/);
        if (!prog) throw new ShellError("awk: this lab supports '{print $N}', '{print $1, $3}', '/pattern/ {print $N}' and -F:");
        const files = a.slice(pi + 1);
        const split = (l) => (fsArg ? l.split(fsArg) : l.trim().split(/\s+/));
        const cols = prog[4].split(',').map((x) => x.trim());
        return lines(files.length ? files.map(read).join('\n') : input ?? '').filter((l) => (prog[1] ? new RegExp(prog[1]).test(l) : prog[2] ? split(l)[+prog[2] - 1] === prog[3] : true))
          .map((l) => cols.map((c) => (c === '$0' ? l : /^\$\d+$/.test(c) ? split(l)[+c.slice(1) - 1] ?? '' : c.replace(/"/g, ''))).join(' ')).join('\n');
      }
      case 'tr': { const [from, to = ''] = args; const t = input ?? ''; if (flags.includes('-d')) return t.split('').filter((ch) => !from.includes(ch)).join(''); if (from === 'a-z' && to === 'A-Z') return t.toUpperCase(); if (from === 'A-Z' && to === 'a-z') return t.toLowerCase(); return t.split('').map((ch) => (from.includes(ch) ? to[Math.min(from.indexOf(ch), to.length - 1)] ?? '' : ch)).join(''); }
      case 'touch': need(1, 'touch: missing file operand'); for (const f of args) this.create(f, 'f'); changed(); return '';
      case 'mkdir': {
        need(1, 'mkdir: missing operand'); const p = flags.some((f) => /p/.test(f)); const mIdx = a.indexOf('-m'); const m = mIdx >= 0 ? a[mIdx + 1] : null;
        for (const f of args.filter((x) => x !== m)) {
          if (p) { const parts = this.abs(f).split('/').filter(Boolean); let cur = ''; for (const x of parts) { cur += `/${x}`; if (!this.s.fs[cur]) this.create(cur, 'd'); else if (this.s.fs[cur].t !== 'd') throw new ShellError(`mkdir: cannot create directory '${f}': Not a directory`); } }
          else this.create(f, 'd');
          if (m) this.s.fs[this.abs(f)].mode = applyMode(this.s.fs[this.abs(f)].mode, m).mode;
        }
        changed(); return '';
      }
      case 'rmdir': for (const f of args) { const p = this.abs(f); if (!this.s.fs[p]) throw new ShellError(`rmdir: failed to remove '${f}': No such file or directory`); if (Object.keys(this.s.fs).some((k) => k.startsWith(`${p}/`))) throw new ShellError(`rmdir: failed to remove '${f}': Directory not empty`); delete this.s.fs[p]; } changed(); return '';
      case 'rm': {
        need(1, 'rm: missing operand'); const f = flags.join('');
        for (const x of args) {
          const p = this.abs(x); const n = this.s.fs[p];
          if (!n) { if (/f/.test(f)) continue; throw new ShellError(`rm: cannot remove '${x}': No such file or directory`); }
          if (n.t === 'd' && !/[rR]/.test(f)) throw new ShellError(`rm: cannot remove '${x}': Is a directory`);
          const dir = this.s.fs[parentOf(p)];
          if (!this.can(dir, 2)) throw new ShellError(`rm: cannot remove '${x}': Permission denied`);
          if (dir.sp & 1 && !this.root && n.owner !== this.me() && dir.owner !== this.me()) throw new ShellError(`rm: cannot remove '${x}': Operation not permitted`);
          if (this.s.mounts?.some((m) => m.dir === p || m.dir.startsWith(`${p}/`))) throw new ShellError(`rm: cannot remove '${x}': Device or resource busy`);
          for (const k of Object.keys(this.s.fs)) if (k === p || k.startsWith(`${p}/`)) delete this.s.fs[k];
        }
        changed(); return '';
      }
      case 'cp': case 'mv': {
        need(2, `${cmd}: missing file operand`); const f = flags.join(''); const rec = /[rRa]/.test(f) || cmd === 'mv'; const keep = /[ap]/.test(f) || cmd === 'mv';
        const dst0 = args[args.length - 1]; const srcs = args.slice(0, -1);
        for (const s0 of srcs) {
          const src = this.follow(this.abs(s0)); const n = this.s.fs[src];
          if (!n) throw new ShellError(`${cmd}: cannot stat '${s0}': No such file or directory`);
          if (n.t === 'd' && !rec) throw new ShellError(`cp: -r not specified; omitting directory '${s0}'`);
          if (n.t === 'f' && !this.can(n, 4)) throw new ShellError(`${cmd}: cannot open '${s0}' for reading: Permission denied`);
          let dst = this.follow(this.abs(dst0)); if (this.s.fs[dst]?.t === 'd') dst = `${dst === '/' ? '' : dst}/${src.split('/').pop()}`;
          const dir = this.s.fs[parentOf(dst)];
          if (!dir) throw new ShellError(`${cmd}: cannot create regular file '${dst0}': No such file or directory`);
          if (!this.can(dir, 2)) throw new ShellError(`${cmd}: cannot create regular file '${dst0}': Permission denied`);
          const keys = Object.keys(this.s.fs).filter((k) => k === src || (n.t === 'd' && k.startsWith(`${src}/`))).sort();
          for (const k of keys) {
            const x = this.s.fs[k]; const to = dst + k.slice(src.length); const existing = this.s.fs[to];
            const copy = JSON.parse(JSON.stringify(x));
            if (!keep) { copy.owner = this.me(); copy.group = this.primary(); copy.mode = existing?.mode || copy.mode; delete copy.sp; }
            if (this.s.selinux && cmd === 'cp' && !/a/.test(f) && !a.includes('--preserve=context')) copy.ctx = existing?.ctx || this.s.fs[parentOf(to)]?.ctx || policyCtx(this.s, to);
            this.s.fs[to] = existing && cmd === 'cp' && !keep ? { ...existing, content: copy.content, size: copy.size } : copy;
          }
          if (cmd === 'mv') for (const k of keys) delete this.s.fs[k];
        }
        changed(); return '';
      }
      case 'chmod': {
        need(2, 'chmod: missing operand'); const rec = flags.includes('-R');
        const [mode, ...files] = args.length ? (/^[ugoa]*[+\-=]/.test(a.find((x) => !['-R'].includes(x))) ? [a.find((x) => x !== '-R'), ...a.filter((x) => x !== '-R').slice(1)] : args) : args;
        for (const f of files) {
          const p = this.follow(this.abs(f)); const n = this.s.fs[p];
          if (!n) throw new ShellError(`chmod: cannot access '${f}': No such file or directory`);
          for (const k of Object.keys(this.s.fs).filter((k) => k === p || (rec && k.startsWith(`${p}/`)))) {
            const x = this.s.fs[k]; if (x.t === 'l') continue;
            if (!this.root && x.owner !== this.me()) throw new ShellError(`chmod: changing permissions of '${f}': Operation not permitted`);
            const r = applyMode(x.mode, mode, x.sp || 0, x.t === 'd'); if (!r) throw new ShellError(`chmod: invalid mode: '${mode}'`);
            x.mode = r.mode; if (r.sp) x.sp = r.sp; else delete x.sp;
          }
        }
        changed(); return '';
      }
      case 'chown': case 'chgrp': {
        need(2, `${cmd}: missing operand`); const rec = flags.includes('-R'); const [ug, ...files] = args;
        let [u, g] = cmd === 'chgrp' ? [null, ug] : ug.split(/[:.]/); if (cmd === 'chown' && ug.includes(':') && g === '') g = this.s.users[u]?.groups[0];
        if (u && !this.s.users[u]) throw new ShellError(`chown: invalid user: '${ug}'`);
        if (g && !this.s.groups[g]) throw new ShellError(`${cmd}: invalid group: '${ug}'`);
        for (const f of files) {
          const p = this.follow(this.abs(f)); const n = this.s.fs[p]; if (!n) throw new ShellError(`${cmd}: cannot access '${f}': No such file or directory`);
          if (!this.root && (u || n.owner !== this.me() || !this.inGroup(g))) throw new ShellError(`${cmd}: changing ${u ? 'ownership' : 'group'} of '${f}': Operation not permitted`);
          for (const k of Object.keys(this.s.fs).filter((k) => k === p || (rec && k.startsWith(`${p}/`)))) { if (u) this.s.fs[k].owner = u; if (g) this.s.fs[k].group = g; }
        }
        changed(); return '';
      }
      case 'umask': {
        if (!args.length) return this.umask;
        if (!/^0?[0-7]{3}$/.test(args[0])) throw new ShellError(`bash: umask: ${args[0]}: octal number out of range`);
        (this.s.shell.umask ||= {})[this.shellUser] = args[0].padStart(4, '0'); return '';
      }
      case 'find': {
        const starts = []; let i = 0; while (i < a.length && !a[i].startsWith('-') && a[i] !== '!' && a[i] !== '(') starts.push(a[i++]);
        const tests = []; let exec = null;
        for (; i < a.length; i++) {
          const t = a[i]; const v = a[i + 1];
          if (t === '-name' || t === '-iname') { const re = new RegExp(`^${v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, t === '-iname' ? 'i' : ''); tests.push((k) => re.test(k.split('/').pop())); i++; }
          else if (t === '-type') { tests.push((k, n) => n.t === v); i++; }
          else if (t === '-user') { if (!this.s.users[v]) throw new ShellError(`find: '${v}' is not the name of a known user`); tests.push((k, n) => n.owner === v); i++; }
          else if (t === '-group') { tests.push((k, n) => n.group === v); i++; }
          else if (t === '-nouser') tests.push((k, n) => !this.s.users[n.owner]);
          else if (t === '-perm') { const m = v.replace(/^[-/]/, ''); const want = m.length === 4 ? +m[0] : 0; tests.push((k, n) => (want ? ((n.sp || 0) & want) === want : n.mode === m.slice(-3))); i++; }
          else if (t === '-size') { const m = v.match(/^([+-]?)(\d+)([kMG]?)$/); if (!m) throw new ShellError(`find: invalid argument '${v}' to '-size'`); const mult = { '': 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[3]]; const lim = +m[2] * mult; tests.push((k, n) => { if (n.t !== 'f') return false; const sz = n.size ?? (n.content || '').length; return m[1] === '+' ? sz > lim : m[1] === '-' ? sz < lim : Math.ceil(sz / mult) === +m[2]; }); i++; }
          else if (t === '-mmin' || t === '-mtime' || t === '-newer') { i++; }
          else if (t === '-exec') { const end = a.findIndex((x, j) => j > i && (x === ';' || x === '\\;' || x === '+')); exec = a.slice(i + 1, end < 0 ? a.length : end); i = end < 0 ? a.length : end; }
          else if (t === '-print' || t === '-xdev') continue;
          else throw new ShellError(`find: unknown predicate '${t}'`);
        }
        const out = []; const denied = new Set();
        for (const s0 of starts.length ? starts : ['.']) {
          const start = this.follow(this.abs(s0)); if (!this.s.fs[start]) throw new ShellError(`find: '${s0}': No such file or directory`);
          for (const k of Object.keys(this.s.fs).filter((k) => k === start || k.startsWith(`${start === '/' ? '' : start}/`)).sort()) {
            const blocked = [...denied].some((d) => k.startsWith(`${d}/`)); if (blocked) continue;
            const n = this.s.fs[k]; if (n.t === 'd' && k !== start && !this.can(n, 4)) { denied.add(k); }
            if (tests.every((fn) => fn(k, n))) out.push(s0.startsWith('/') || s0 === '/' ? k : k === start ? s0 : `${s0.replace(/\/$/, '')}${k.slice(start.length)}`);
          }
        }
        const err = [...denied].map((d) => `find: '${d}': Permission denied`);
        if (exec) { const res = []; for (const k of out) { const argv = exec.map((x) => (x === '{}' ? k : x)); const r = this.exec(argv, null); if (r) res.push(r); } return [...res, ...err].join('\n'); }
        return [...out, ...err].join('\n');
      }
      case 'sed': {
        const inPlace = flags.some((f) => /^-i/.test(f)); const ex = a.find((x, i) => !x.startsWith('-') && /^(\d+|\$)?[sd]|^\/.+\/d$|^s./.test(x) && i === a.findIndex((y) => !y.startsWith('-')));
        const file = args[args.length - 1] !== ex ? args[args.length - 1] : null;
        if (!ex) throw new ShellError("sed: this lab supports: sed [-i] 's/old/new/[g]' FILE and sed -i '/pattern/d' FILE");
        let t;
        if (file) { const p = this.follow(this.abs(file)); const n = this.s.fs[p]; if (!n) throw new ShellError(`sed: can't read ${file}: No such file or directory`); if (!this.can(n, 4)) throw new ShellError(`sed: couldn't open file ${file}: Permission denied`); t = n.content; } else t = input ?? '';
        let res;
        const del = ex.match(/^\/(.+)\/d$/); const delN = ex.match(/^(\d+)d$/);
        if (del) res = t.split('\n').filter((l) => !new RegExp(del[1]).test(l)).join('\n');
        else if (delN) res = t.split('\n').filter((l, i) => i !== +delN[1] - 1).join('\n');
        else {
          const sep = ex[1]; const [, from, to, opt = ''] = ex.split(sep); if (from == null || to == null) throw new ShellError(`sed: -e expression #1, char ${ex.length}: unterminated \`s' command`);
          let re; try { re = new RegExp(from.replace(/\\([()|+?{}])/g, '$1'), `${opt.includes('g') ? 'g' : ''}${opt.includes('I') || opt.includes('i') ? 'i' : ''}`); } catch { throw new ShellError('sed: -e expression #1: Invalid regular expression'); }
          res = t.split('\n').map((l) => l.replace(re, to.replace(/\\\//g, '/').replace(/&/g, '$&').replace(/\\(\d)/g, '$$$1'))).join('\n');
        }
        if (!inPlace) return res;
        const p = this.follow(this.abs(file)); const n = this.s.fs[p];
        if (!this.can(n, 2) || !this.can(this.s.fs[parentOf(p)], 2)) throw new ShellError(`sed: couldn't open temporary file ${parentOf(p)}/sedXyZ12: Permission denied`);
        n.content = res; changed(); return '';
      }
      case 'tee': {
        const append = flags.some((f) => /a/.test(f)); for (const f of args) this.writeFile(this.abs(f), input ?? '', append); return input ?? '';
      }
      case 'ps': {
        const rows = this.s.procs.map((p) => ({ ...p, nice: p.nice ?? 0 }));
        if (flags.some((f) => /e|f/.test(f)) && !a.includes('aux')) return `UID          PID    PPID  NI CMD\n${rows.map((p) => `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid ?? 1).padStart(7)} ${String(p.nice).padStart(3)} ${p.cmd}`).join('\n')}`;
        let list = rows; const sortA = a.find((x) => x.startsWith('--sort=')); if (sortA) { const key = sortA.slice(7).replace('-', '').replace('%', ''); list = [...rows].sort((x, y) => (y[key] ?? 0) - (x[key] ?? 0)); if (!sortA.includes('=-')) list.reverse(); }
        return `USER         PID %CPU %MEM  NI COMMAND\n${list.map((p) => `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.cpu ?? 0.1).padStart(4)} ${String(p.mem ?? 0.2).padStart(4)} ${String(p.nice).padStart(3)} ${p.cmd}`).join('\n')}`;
      }
      case 'top': return `top - 10:42:13 up  2:41,  1 user,  load average: ${this.s.load || '0.08, 0.05, 0.01'}\n    PID USER      NI  %CPU  %MEM COMMAND\n${[...this.s.procs].sort((x, y) => (y.cpu ?? 0) - (x.cpu ?? 0)).slice(0, 8).map((p) => `${String(p.pid).padStart(7)} ${p.user.padEnd(9)} ${String(p.nice ?? 0).padStart(2)} ${String(p.cpu ?? 0.1).padStart(5)} ${String(p.mem ?? 0.2).padStart(5)} ${p.cmd}`).join('\n')}\n(top is interactive on a real system; this lab shows one snapshot.)`;
      case 'kill': case 'pkill': case 'killall': {
        need(1, `${cmd}: usage: ${cmd === 'kill' ? 'kill [-9] PID' : `${cmd} NAME`}`); let n = 0;
        for (const t of args) {
          const hits = cmd === 'kill' ? this.s.procs.filter((x) => x.pid === +t) : this.s.procs.filter((x) => x.cmd.split(/\s+/)[0].split('/').pop() === t || x.cmd.includes(t));
          if (!hits.length) throw new ShellError(cmd === 'kill' ? `bash: kill: (${t}) - No such process` : `${cmd}: ${t}: no process found`);
          for (const p of hits) { if (!this.root && p.user !== this.me()) throw new ShellError(`bash: kill: (${p.pid}) - Operation not permitted`); if (p.stubborn && !flags.includes('-9') && !flags.includes('-KILL') && !flags.includes('-SIGKILL')) { p.termTried = true; continue; } this.s.procs = this.s.procs.filter((x) => x !== p); n++; }
        }
        changed(); return n ? '' : '(The process ignored SIGTERM. Check with ps; a stuck process may need kill -9.)';
      }
      case 'nice': { const nIdx = a.indexOf('-n'); const lvl = nIdx >= 0 ? +a[nIdx + 1] : 10; const c = a.slice(nIdx >= 0 ? nIdx + 2 : 0).join(' '); if (lvl < 0 && !this.root) throw new ShellError('nice: cannot set niceness: Permission denied'); const p = { pid: this.s.nextPid++, user: this.me(), cmd: c, nice: lvl, cpu: 0.1, mem: 0.1 }; this.s.procs.push(p); changed(); return `[1] ${p.pid}`; }
      case 'renice': {
        const nIdx = a.indexOf('-n'); const lvl = nIdx >= 0 ? +a[nIdx + 1] : +args[0]; const pIdx = a.indexOf('-p'); const pid = +(pIdx >= 0 ? a[pIdx + 1] : args[args.length - 1]);
        const p = this.s.procs.find((x) => x.pid === pid); if (!p) throw new ShellError(`renice: failed to get priority for ${pid} (process ID): No such process`);
        if (!this.root && (p.user !== this.me() || lvl < (p.nice ?? 0))) throw new ShellError(`renice: failed to set priority for ${pid} (process ID): Permission denied`);
        const old = p.nice ?? 0; p.nice = Math.max(-20, Math.min(19, lvl)); changed(); return `${pid} (process ID) old priority ${old}, new priority ${p.nice}`;
      }
      case 'ufw': {
        if (this.s.distro === 'rhel') throw new ShellError('ufw: command not found (RHEL uses firewalld: firewall-cmd)');
        const u = this.s.ufw;
        if (args[0] === 'status' && args[1] === 'numbered') return `Status: ${u.enabled ? 'active' : 'inactive'}\n\n     To                         Action      From\n${u.rules.map((r, i) => `[${String(i + 1).padStart(2)}] ${(r.port || 'Anywhere').padEnd(27)}${r.action.toUpperCase().padEnd(12)}${r.from || 'Anywhere'}`).join('\n')}`;
        if (args[0] === 'status') return u.enabled ? `Status: active\n\nTo                         Action      From\n--                         ------      ----\n${u.rules.map((r) => `${(r.port || 'Anywhere').padEnd(27)}${r.action.toUpperCase().padEnd(12)}${r.from || 'Anywhere'}`).join('\n')}` : 'Status: inactive';
        if (!this.root) throw new ShellError('ERROR: You need to be root to run this script');
        if (args[0] === 'enable') { u.enabled = true; changed(); return 'Firewall is active and enabled on system startup'; }
        if (args[0] === 'disable') { u.enabled = false; changed(); return 'Firewall stopped and disabled on system startup'; }
        if (args[0] === 'default') { u.defaultIn = args[1]; changed(); return `Default incoming policy changed to '${args[1]}'`; }
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
          changed(); return ins ? 'Rule inserted' : 'Rule added';
        }
        if (args[0] === 'delete') { const before = u.rules.length; if (/^\d+$/.test(args[1] || '')) u.rules.splice(+args[1] - 1, 1); else u.rules = u.rules.filter((r) => !(r.action === args[1] && (r.port === args[2] || (args[2] === 'from' && r.from === args[3])))); changed(); return u.rules.length < before ? 'Rule deleted' : 'Could not delete non-existent rule'; }
        throw new ShellError('ERROR: Invalid syntax');
      }
      case 'apt': case 'apt-get': {
        if (this.s.distro === 'rhel') throw new ShellError(`${cmd}: command not found (RHEL uses dnf)`);
        if (args[0] === 'list' && a.includes('--installed')) return [...this.s.packages].sort().map((p) => `${p}/noble,now 1.0 amd64 [installed]`).join('\n');
        if (args[0] === 'search') return this.s.available.filter((p) => p.includes(args[1] || '')).map((p) => `${p}/noble 1.0 amd64`).join('\n');
        if (!this.root) throw new ShellError(`E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock, are you root?`);
        if (args[0] === 'update') return 'Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nReading package lists... Done';
        if (args[0] === 'upgrade') return 'Reading package lists... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.';
        if (args[0] === 'install') {
          const pk = args.slice(1); const bad = pk.find((x) => !this.s.available.includes(x) && !this.s.packages.includes(x));
          if (bad) throw new ShellError(`E: Unable to locate package ${bad}`);
          for (const x of pk) if (!this.s.packages.includes(x)) this.s.packages.push(x);
          // Like Ubuntu, packages that ship a service start it and enable it at boot when installed.
          for (const x of pk) if (this.s.pkgServices?.[x] && !this.s.services[x]) this.s.services[x] = { ...this.s.pkgServices[x] };
          changed(); return `Reading package lists... Done\nSetting up ${pk.join(', ')} ...\nDone.`;
        }
        if (args[0] === 'remove' || args[0] === 'purge') { this.s.packages = this.s.packages.filter((x) => !args.slice(1).includes(x)); changed(); return 'Removing ... Done.'; }
        throw new ShellError('E: Invalid operation');
      }
      case 'dpkg': if (this.s.distro === 'rhel') throw new ShellError('dpkg: command not found (RHEL uses rpm)'); return this.s.packages.map((p) => `ii  ${p}`).join('\n');
      case 'nano': case 'vi': case 'vim': {
        const f = args[0]; if (!f) throw new ShellError(`${cmd}: name a file to edit, for example: ${cmd} /etc/fstab`);
        const p = this.follow(this.abs(f)); const n = this.s.fs[p]; const dir = this.s.fs[parentOf(p)];
        if (n?.t === 'd') throw new ShellError(`"${f}" is a directory`);
        if (!dir) throw new ShellError(`"${f}" [New DIRECTORY] — the folder doesn't exist`);
        if (n && !this.can(n, 4)) throw new ShellError(`"${f}" [Permission Denied]`);
        if (!this.opts.edit) throw new ShellError(`${cmd}: full-screen editors aren't available here. Use sed -i 's/old/new/' FILE or echo "text" | sudo tee -a FILE.`);
        const asRoot = this.root; const canWrite = n ? this.can(n, 2) : this.can(dir, 2);
        this.opts.edit({ path: p, name: f, content: n?.content ?? '', readonly: !canWrite, editor: cmd,
          save: (txt) => { const prev = this.root; this.root = asRoot; try { this.writeFile(p, txt.replace(/\r/g, ''), false); } finally { this.root = prev; } } });
        return '';
      }
      case 'bash': case 'sh': case 'source': { const f = args[0]; if (!f) return ''; const t = this.readFile(f); return `(${f}: this lab doesn't run scripts. Its contents are:)\n${t}`; }
      case 'test': return '';
      default: {
        const r = admin(this, cmd, a, input);
        if (r !== undefined) return r;
        if (/^\.?\//.test(cmd)) { const n = this.node(cmd); if (!n) throw new ShellError(`bash: ${cmd}: No such file or directory`); if (!this.can(n, 1)) throw new ShellError(`bash: ${cmd}: Permission denied`); return `(${cmd} ran. This lab doesn't execute script contents.)`; }
        throw new ShellError(`bash: ${cmd}: command not found`);
      }
    }
  }
  create(f, t) {
    const p = this.abs(f); if (this.s.fs[p]) { if (t === 'd') throw new ShellError(`mkdir: cannot create directory '${f}': File exists`); return; }
    const dir = this.s.fs[parentOf(p)];
    if (!dir) throw new ShellError(`${t === 'd' ? 'mkdir' : 'touch'}: cannot ${t === 'd' ? 'create directory' : 'touch'} '${f}': No such file or directory`);
    if (!this.can(dir, 2)) throw new ShellError(`${t === 'd' ? 'mkdir' : 'touch'}: cannot ${t === 'd' ? 'create directory' : 'touch'} '${f}': Permission denied`);
    this.s.fs[p] = this.newNode(p, t);
  }
  complete(line) {
    const m = line.match(/^(.*?)(\S*)$/); const last = m[2]; if (!last) return line;
    if (!m[1].trim()) { const hits = [...BIN].filter((c) => c.startsWith(last)); return hits.length === 1 ? `${hits[0]} ` : line; }
    const dirPart = last.includes('/') ? last.slice(0, last.lastIndexOf('/') + 1) : '';
    const base = this.follow(this.abs(dirPart || '.')); const rest = last.slice(dirPart.length);
    const hits = Object.keys(this.s.fs).filter((k) => parentOf(k) === base && k !== base && k.split('/').pop().startsWith(rest));
    if (hits.length !== 1) {
      if (hits.length > 1) { const names = hits.map((k) => k.split('/').pop()); let pre = rest; while (names.every((x) => x.startsWith(pre + (names[0][pre.length] || '\0')))) pre += names[0][pre.length]; return `${m[1]}${dirPart}${pre}`; }
      return line;
    }
    const n = this.s.fs[hits[0]]; return `${m[1]}${dirPart}${hits[0].split('/').pop()}${n.t === 'd' ? '/' : ' '}`;
  }
}

function tokenize(s) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (let i = 0; i < s.trim().length; i++) {
    const ch = s.trim()[i];
    if (q) { if (ch === q) { q = null; } else cur += ch; continue; }
    if (ch === '\\' && i + 1 < s.trim().length && s.trim()[i + 1] !== ';') { cur += s.trim()[++i]; any = true; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
// Split a line into commands joined by ;, && or || (outside quotes).
function splitList(s) {
  const out = []; let cur = ''; let q = null; let op = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '\\' && s[i + 1] === ';') { cur += '\\;'; i++; continue; }
    if (ch === ';') { out.push({ cmd: cur.trim(), op }); cur = ''; op = ';'; continue; }
    if ((ch === '&' && s[i + 1] === '&') || (ch === '|' && s[i + 1] === '|')) { out.push({ cmd: cur.trim(), op }); cur = ''; op = ch === '&' ? '&&' : '||'; i++; continue; }
    cur += ch;
  }
  out.push({ cmd: cur.trim(), op });
  return out.filter((x) => x.cmd);
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
// Pull > file, >> file, < file, 2>/dev/null and 2>&1 out of a command (outside quotes).
function redirects(line) {
  let body = ''; let q = null; let out = null; let append = false; let input = null; let quiet = false; let merge = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; body += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; body += ch; continue; }
    if (line.startsWith('2>&1', i)) { merge = true; i += 3; continue; }
    if (line.startsWith('&>', i) || line.startsWith('2>', i) || ch === '>' || ch === '<') {
      const err = line.startsWith('2>', i); const both = line.startsWith('&>', i); let j = i + (err || both ? 2 : 1); let app = false;
      if (ch === '>' || err || both) { if (line[j] === '>') { app = true; j++; } }
      while (line[j] === ' ') j++; let tgt = ''; while (j < line.length && !/[\s|;]/.test(line[j])) tgt += line[j++];
      if (ch === '<') input = tgt; else if (err) { if (tgt === '/dev/null') quiet = true; } else { out = tgt; append = app; if (both) merge = true; }
      i = j - 1; continue;
    }
    body += ch;
  }
  return { body: body.trim(), out, append, input, quiet, merge };
}
// chmod: octal (755, 2770) or symbolic (u+x, go-w, a=r, +x, g+s, o+t, u+s).
function applyMode(cur, spec, sp = 0, isDir = false) {
  if (/^[0-7]{3}$/.test(spec)) return { mode: spec, sp: isDir ? sp : 0 };
  if (/^[0-7]{4}$/.test(spec)) return { mode: spec.slice(1), sp: +spec[0] };
  const digits = [...cur].map(Number);
  for (const part of spec.split(',')) {
    const m = part.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/); if (!m) return null;
    const who = (m[1] || 'a').replace('a', 'ugo'); const bits = [...m[3]].reduce((n, c) => n | ({ r: 4, w: 2, x: 1, X: isDir || digits.some((d) => d & 1) ? 1 : 0 }[c] || 0), 0);
    for (const w of new Set(who)) {
      const i = 'ugo'.indexOf(w);
      digits[i] = m[2] === '+' ? digits[i] | bits : m[2] === '-' ? digits[i] & ~bits : bits;
    }
    let spBits = 0; if (m[3].includes('s')) { if (who.includes('u')) spBits |= 4; if (who.includes('g')) spBits |= 2; } if (m[3].includes('t')) spBits |= 1;
    sp = m[2] === '+' ? sp | spBits : m[2] === '-' ? sp & ~spBits : (m[3].includes('s') || m[3].includes('t') ? spBits : sp);
  }
  return { mode: digits.join(''), sp };
}

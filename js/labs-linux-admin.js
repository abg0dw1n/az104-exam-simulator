// System administration for the Linux lab simulator: users and groups, sudo rules, packages
// (dnf/rpm/flatpak and apt), services and timers (systemctl, journalctl), scheduling (cron,
// at), tuned, networking (nmcli, ip, hostnamectl, name resolution, ping, curl), time (chrony),
// SSH keys, archives (tar), links, disk usage, reboot persistence, and state queries for checks.
import { ShellError, policyCtx, fmtSize, parentOf } from './labs-linux-base.js';
import { storage, storageState, defaultFstab, bootStorage, canon, resolveSpec } from './labs-linux-storage.js';
import { sec, secState, webStart, webPorts, httpGet, ctxOf } from './labs-linux-sec.js';

const RHEL_PKG_SERVICES = {
  httpd: { port: 80, desc: 'The Apache HTTP Server' }, nginx: { port: 80, desc: 'The nginx HTTP and reverse proxy server' },
  vsftpd: { port: 21, desc: 'Vsftpd ftp daemon' }, mariadb: { port: 3306, desc: 'MariaDB database server', pkg: 'mariadb-server' },
  'nfs-server': { port: 2049, desc: 'NFS server and services', pkg: 'nfs-utils' }, autofs: { desc: 'Automounts filesystems on demand' },
  cockpit: { port: 9090, desc: 'Cockpit Web Service' }, podman: null,
};
const PKG_FILES = {
  httpd: {
    '/etc/httpd/conf/httpd.conf': 'ServerRoot "/etc/httpd"\nListen 80\nInclude conf.modules.d/*.conf\nUser apache\nGroup apache\nServerAdmin root@localhost\nDocumentRoot "/var/www/html"\n<Directory "/var/www">\n    AllowOverride None\n    Require all granted\n</Directory>\nErrorLog "logs/error_log"\nIncludeOptional conf.d/*.conf',
    '/etc/httpd/conf.d/': null, '/var/www/html/': null, '/var/www/cgi-bin/': null,
  },
  nginx: { '/etc/nginx/nginx.conf': 'user nginx;\nevents { worker_connections 1024; }\nhttp {\n    server {\n        listen 80;\n        root /usr/share/nginx/html;\n    }\n}', '/usr/share/nginx/html/': null },
  autofs: { '/etc/auto.master': '/misc   /etc/auto.misc\n+auto.master', '/etc/auto.master.d/': null },
};
const TZS = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
const TUNED = ['balanced', 'desktop', 'latency-performance', 'network-latency', 'network-throughput', 'powersave', 'throughput-performance', 'virtual-guest', 'virtual-host'];

// Fill in everything the admin commands need. Called from newLinux().
export function extendState(s, def) {
  const rhel = def.distro === 'rhel'; s.distro = rhel ? 'rhel' : 'ubuntu';
  // Users: uid, primary group first, shell, home, password and aging.
  let uid = 1000; const groups = { root: { gid: 0 }, wheel: { gid: 10 }, adm: { gid: 4 }, sudo: { gid: 27 }, ...(def.groups || {}) };
  for (const [u, info] of Object.entries(s.users)) {
    const base = u === 'root' ? { uid: 0, shell: '/bin/bash', home: '/root' } : { uid: info.uid ?? (u === s.user ? 1000 : ++uid), shell: '/bin/bash', home: `/home/${u}` };
    s.users[u] = { pw: true, maxDays: 99999, ...base, ...info, groups: info.groups || [u] };
    if (!groups[s.users[u].groups[0]]) groups[s.users[u].groups[0]] = { gid: s.users[u].uid };
    for (const g of s.users[u].groups) if (!groups[g]) groups[g] = { gid: 1000 + Object.keys(groups).length * 3 };
  }
  if (rhel) s.users[s.user].groups = s.users[s.user].groups.map((g) => (g === 'sudo' ? 'wheel' : g));
  s.groups = groups;
  s.adminGroup = rhel ? 'wheel' : 'sudo';
  // Services that exist on a fresh server.
  const base = rhel
    ? { sshd: { port: 22, desc: 'OpenSSH server daemon' }, firewalld: { desc: 'firewalld - dynamic firewall daemon' }, chronyd: { desc: 'NTP client/server' }, crond: { desc: 'Command Scheduler' }, atd: { desc: 'Deferred execution scheduler' }, tuned: { desc: 'Dynamic System Tuning Daemon' }, NetworkManager: { desc: 'Network Manager' }, 'systemd-journald': { desc: 'Journal Service' } }
    : { ssh: { port: 22, desc: 'OpenBSD Secure Shell server' }, cron: { desc: 'Regular background program processing daemon' } };
  const svcs = {}; for (const [n, v] of Object.entries(base)) svcs[n] = { active: true, enabled: true, ...v };
  s.services = { ...svcs, ...s.services };
  if (rhel && def.firewalld === false) s.services.firewalld = { ...s.services.firewalld, active: false, enabled: false };
  s.timers = def.timers || {};
  s.journal = (def.journal || []).map((j) => (typeof j === 'string' ? { unit: 'kernel', prio: 6, msg: j } : j));
  s.bootTarget = def.bootTarget || (rhel ? 'multi-user.target' : 'graphical.target');
  s.kernelArgs = def.kernelArgs || ['ro', 'crashkernel=1G-4G:192M', 'rhgb', 'quiet'];
  s.crontabs = def.crontabs || {}; s.atJobs = []; s.tuned = { active: def.tuned || 'virtual-guest', recommend: 'virtual-guest' };
  s.tz = def.tz || 'America/New_York'; s.ntp = true; s.chrony = { sources: [] };
  s.boots = 0; s.sshTrust = def.sshTrust || []; s.remote = {}; s.flatpak = { remotes: {}, apps: [] };
  s.repoUrls = def.repoUrls || []; s.presetRepos = def.presetRepos ?? !def.repoUrls; s.provides = def.provides || {};
  s.dns = def.dns || {}; s.prefix = def.prefix || 24; s.gw = def.gw ?? s.ip.replace(/\d+$/, '1');
  for (const k of ['gwReal', 'dnsServerNeeded', 'timeServers', 'rootBase', 'load']) if (def[k] != null) s[k] = def[k];
  s.nm = rhel ? { cons: { [def.con || 'eth0']: { dev: 'eth0', method: def.dhcp ? 'auto' : 'manual', addresses: def.dhcp ? '' : `${s.ip}/${s.prefix}`, gateway: def.dhcp ? '' : s.gw, dns: def.dnsServer ?? '172.25.250.254', autoconnect: 'yes', ...(def.nm || {}) } } } : null;
  s.dhcpIp = def.dhcpIp || null; s.wrongNet = def.wrongNet || null;
  Object.assign(s, storageState(def), secState(def));
  // Files every server has (labs can override any of them).
  const f = (path, content, mode = '644', owner = 'root', group = owner) => { if (!s.fs[path]) mkNode(s, path, { t: 'f', mode, owner, group, content }); };
  const d = (path, mode = '755', owner = 'root', group = owner) => { if (!s.fs[path]) mkNode(s, path, { t: 'd', mode, owner, group }); };
  for (const x of ['/etc', '/var', '/var/log', '/var/tmp', '/var/spool', '/usr/share', '/tmp', '/root', '/srv', '/mnt', '/opt', '/usr', '/usr/bin', '/usr/local', '/usr/local/bin', '/home', '/etc/sudoers.d', '/etc/cron.d', '/etc/systemd', '/etc/systemd/system']) d(x, x === '/tmp' || x === '/var/tmp' ? '777' : x === '/root' ? '550' : x === '/etc/sudoers.d' ? '750' : '755');
  for (const t of ['/tmp', '/var/tmp']) if (s.fs[t]) s.fs[t].sp = 1;
  f('/etc/hostname', `${s.hostname}\n`); f('/etc/hosts', '127.0.0.1   localhost localhost.localdomain\n::1         localhost localhost.localdomain\n');
  f('/etc/fstab', defaultFstab(s)); f('/etc/login.defs', 'MAIL_DIR\t/var/spool/mail\nPASS_MAX_DAYS\t99999\nPASS_MIN_DAYS\t0\nPASS_WARN_AGE\t7\nUID_MIN\t\t1000\nUMASK\t\t022\nCREATE_HOME\tyes\nENCRYPT_METHOD\tSHA512');
  f('/etc/sudoers', `root\tALL=(ALL)\tALL\n${rhel ? '%wheel\tALL=(ALL)\tALL' : '%sudo\tALL=(ALL:ALL) ALL'}\n#includedir /etc/sudoers.d`, '440');
  f('/etc/resolv.conf', def.noDns ? '# Generated by NetworkManager\n' : `# Generated by NetworkManager\nnameserver ${def.dnsServer || '172.25.250.254'}\n`);
  f('/etc/os-release', rhel ? 'NAME="Red Hat Enterprise Linux"\nVERSION="10.0 (Coughlan)"\nID="rhel"\nVERSION_ID="10.0"\nPRETTY_NAME="Red Hat Enterprise Linux 10.0 (Coughlan)"' : 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian');
  if (rhel) {
    f('/etc/selinux/config', `# This file controls the state of SELinux on the system.\n# SELINUX= can take one of these three values:\n#     enforcing - SELinux security policy is enforced.\n#     permissive - SELinux prints warnings instead of enforcing.\n#     disabled - No SELinux policy is loaded.\nSELINUX=${def.selinuxConfig || def.selinux || 'enforcing'}\nSELINUXTYPE=targeted`);
    f('/etc/chrony.conf', 'pool 2.rhel.pool.ntp.org iburst\nsourcedir /run/chrony-dhcp\ndriftfile /var/lib/chrony/drift\nmakestep 1.0 3\nrtcsync\nkeyfile /etc/chrony.keys\nlogdir /var/log/chrony');
    f('/etc/systemd/journald.conf', '[Journal]\n#Storage=auto\n#Compress=yes\n#SystemMaxUse=');
    d('/etc/yum.repos.d'); d('/var/www'); d('/var/log/journal', '2755', 'root', 'systemd-journal'); delete s.fs['/var/log/journal'];
    for (const [p, n] of Object.entries(s.fs)) if (!n.ctx) n.ctx = policyCtx(s, p);
  }
  s.chrony.sources = chronySources(s);
  s.dnfInstalled = [...(def.packages || [])];
  return s;
}
function mkNode(s, path, node) {
  const parts = path.split('/').filter(Boolean); let cur = '';
  for (const p of parts.slice(0, -1)) { cur += `/${p}`; s.fs[cur] ||= { t: 'd', mode: '755', owner: 'root', group: 'root' }; }
  s.fs[path] = node;
}
const chronySources = (s) => [...(s.fs['/etc/chrony.conf']?.content || '').matchAll(/^\s*(server|pool)\s+(\S+)/gm)].map((m) => m[2]);

// ── Users, groups and sudo ──────────────────────────────────────────────────
export function canSudo(s, user) {
  if (user === 'root') return true;
  const gs = s.users[user]?.groups || [];
  const rules = [s.fs['/etc/sudoers']?.content || '', ...Object.keys(s.fs).filter((k) => k.startsWith('/etc/sudoers.d/') && s.fs[k].t === 'f').map((k) => s.fs[k].content)].join('\n');
  return rules.split('\n').some((l) => { const m = l.trim().match(/^(%?[\w.-]+)\s+\S+\s*=\s*(\([^)]*\))?\s*(NOPASSWD:\s*)?ALL\s*$/); if (!m) return false; return m[1].startsWith('%') ? gs.includes(m[1].slice(1)) : m[1] === user; });
}
const sudoersLineOk = (l) => !l.trim() || /^\s*#/.test(l) || /^\s*Defaults\b/.test(l) || /^@?#?includedir\s/.test(l.trim()) || /^(%?[\w.-]+)\s+[\w.,-]+\s*=\s*(\([^)]*\))?\s*(NOPASSWD:\s*)?[^=]+$/.test(l.trim()) || /^(User|Cmnd|Host)_Alias\s/.test(l.trim());
export function virtualFile(s, path, asRoot) {
  if (path === '/etc/passwd') return Object.entries(s.users).map(([u, x]) => `${u}:x:${x.uid}:${s.groups[x.groups[0]]?.gid ?? x.uid}:${x.comment || (u === 'root' ? 'root' : '')}:${x.home}:${x.shell}`).join('\n');
  if (path === '/etc/group') return Object.entries(s.groups).map(([g, x]) => `${g}:x:${x.gid}:${Object.entries(s.users).filter(([u, ux]) => ux.groups.slice(1).includes(g) || (g !== u && ux.groups[0] === g && false)).map(([u]) => u).join(',')}`).join('\n');
  if (path === '/etc/shadow') { if (!asRoot) return null; return Object.entries(s.users).map(([u, x]) => `${u}:${x.locked ? '!' : ''}${x.pw ? '$6$rounds=100000$Qe2n1$Wm9vZ3...' : '!!'}:20390:${x.minDays ?? 0}:${x.maxDays ?? 99999}:${x.warnDays ?? 7}:${x.inactive ?? ''}:${x.expire ?? ''}:`).join('\n'); }
  if (path === '/proc/cmdline') return `BOOT_IMAGE=(hd0,gpt1)/vmlinuz-6.12.0-55.el10.x86_64 root=UUID=${s.blk?.['/dev/vda2']?.uuid} ${s.bootArgs || s.kernelArgs.join(' ')}`;
  if (path === '/proc/swaps') return `Filename\tType\tSize\tUsed\tPriority\n${s.swaps.map((d) => `${d}\tpartition\t1048572\t0\t-2`).join('\n')}`;
  return undefined;
}
function users(sh, cmd, a, input) {
  const s = sh.s; const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x));
  const val = (...ns) => { for (const n of ns) { const i = a.indexOf(n); if (i >= 0) return a[i + 1]; const eq = a.find((x) => x.startsWith(`${n}=`)); if (eq) return eq.slice(n.length + 1); } return null; };
  const rhel = s.distro === 'rhel'; const changed = () => sh.opts.onChange?.();
  const root = (msg) => { if (!sh.root) throw new ShellError(msg); };
  const loginDefs = (k, d) => +((s.fs['/etc/login.defs']?.content.match(new RegExp(`^${k}\\s+(\\d+)`, 'm')) || [])[1] ?? d);
  const VOPTS = { useradd: ['-u', '-g', '-G', '-s', '-c', '-d', '-e', '-p', '-k'], usermod: ['-g', '-G', '-aG', '-s', '-c', '-d', '-e'], chage: ['-M', '-m', '-W', '-E', '-I', '-d'], groupadd: ['-g'], gpasswd: ['-a', '-d'] };
  const vals = new Set((VOPTS[cmd] || []).flatMap((o) => (val(o) != null ? [val(o)] : [])));
  const names = args.filter((x) => !vals.has(x));
  switch (cmd) {
    case 'useradd': {
      root('useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.');
      const u = names[names.length - 1]; if (!u) throw new ShellError('Usage: useradd [options] LOGIN');
      if (s.users[u]) throw new ShellError(`useradd: user '${u}' already exists`);
      const supp = (val('-G', '--groups') || '').split(',').filter(Boolean); const prim = val('-g', '--gid');
      for (const g of [...supp, ...(prim ? [prim] : [])]) if (!s.groups[g]) throw new ShellError(`useradd: group '${g}' does not exist`);
      const sysAcct = flags.includes('-r') || flags.includes('--system');
      let id = val('-u', '--uid') ? +val('-u', '--uid') : sysAcct ? 999 : Math.max(999, ...Object.values(s.users).map((x) => (x.uid < 60000 ? x.uid : 0))) + 1;
      if (sysAcct && !val('-u', '--uid')) while (Object.values(s.users).some((x) => x.uid === id)) id--;
      if (Object.values(s.users).some((x) => x.uid === id)) throw new ShellError(`useradd: UID ${id} is not unique`);
      const g0 = prim || u; if (!prim) { if (s.groups[u]) throw new ShellError(`useradd: group ${u} exists - if you want to add this user to that group, use -g.`); let gid = id; while (Object.values(s.groups).some((x) => x.gid === gid)) gid++; s.groups[u] = { gid }; }
      const home = val('-d', '--home-dir') || `/home/${u}`;
      s.users[u] = { uid: id, groups: [g0, ...supp], shell: val('-s', '--shell') || '/bin/bash', home, comment: val('-c', '--comment') || '', pw: false, maxDays: loginDefs('PASS_MAX_DAYS', 99999), minDays: loginDefs('PASS_MIN_DAYS', 0), warnDays: loginDefs('PASS_WARN_AGE', 7) };
      const mkHome = flags.includes('-m') || flags.includes('--create-home') || (rhel && !flags.includes('-M') && !flags.includes('-r'));
      if (mkHome && !s.fs[home]) { s.fs[home] = { t: 'd', mode: '700', owner: u, group: g0, ctx: rhel ? policyCtx(s, home) : undefined }; }
      changed(); return '';
    }
    case 'usermod': {
      root('usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.');
      const u = names[names.length - 1]; const x = s.users[u]; if (!x) throw new ShellError(`usermod: user '${u || ''}' does not exist`);
      const G = val('-G', '--groups', '-aG'); const append = flags.includes('-a') || flags.includes('-aG') || flags.includes('--append');
      if (G) { const gs = G.split(',').filter(Boolean); for (const g of gs) if (!s.groups[g]) throw new ShellError(`usermod: group '${g}' does not exist`); x.groups = append ? [...new Set([...x.groups, ...gs])] : [x.groups[0], ...gs]; }
      if (val('-g', '--gid')) { const g = val('-g', '--gid'); if (!s.groups[g]) throw new ShellError(`usermod: group '${g}' does not exist`); x.groups[0] = g; }
      if (val('-s', '--shell')) x.shell = val('-s', '--shell');
      if (val('-c', '--comment') != null) x.comment = val('-c', '--comment');
      if (val('-e', '--expiredate') != null) x.expire = val('-e', '--expiredate');
      if (flags.includes('-L') || flags.includes('--lock')) x.locked = true;
      if (flags.includes('-U') || flags.includes('--unlock')) x.locked = false;
      changed(); return '';
    }
    case 'userdel': {
      root('userdel: Permission denied.'); const u = names[0]; const x = s.users[u]; if (!x) throw new ShellError(`userdel: user '${u}' does not exist`);
      if (flags.includes('-r')) for (const k of Object.keys(s.fs)) if (k === x.home || k.startsWith(`${x.home}/`) || k === `/var/spool/mail/${u}`) delete s.fs[k];
      delete s.users[u]; if (s.groups[u] && !Object.values(s.users).some((y) => y.groups[0] === u)) delete s.groups[u];
      changed(); return '';
    }
    case 'groupadd': {
      root('groupadd: Permission denied.'); const g = names[names.length - 1]; if (!g) throw new ShellError('Usage: groupadd [options] GROUP');
      if (s.groups[g]) throw new ShellError(`groupadd: group '${g}' already exists`);
      const gid = val('-g', '--gid') ? +val('-g', '--gid') : Math.max(999, ...Object.values(s.groups).map((x) => (x.gid < 60000 ? x.gid : 0)), ...Object.values(s.users).map((x) => (x.uid < 60000 ? x.uid : 0))) + 1;
      if (Object.values(s.groups).some((x) => x.gid === gid)) throw new ShellError(`groupadd: GID '${gid}' already exists`);
      s.groups[g] = { gid }; changed(); return '';
    }
    case 'groupdel': { root('groupdel: Permission denied.'); const g = names[0]; if (!s.groups[g]) throw new ShellError(`groupdel: group '${g}' does not exist`); delete s.groups[g]; for (const x of Object.values(s.users)) x.groups = [x.groups[0], ...x.groups.slice(1).filter((y) => y !== g)]; changed(); return ''; }
    case 'gpasswd': {
      root('gpasswd: Permission denied.'); const add = val('-a'); const del = val('-d'); const g = names.filter((x) => x !== add && x !== del).pop();
      if (!s.groups[g]) throw new ShellError(`gpasswd: group '${g}' does not exist`);
      const u = add || del; if (!s.users[u]) throw new ShellError(`gpasswd: user '${u}' does not exist`);
      if (add) { s.users[u].groups = [...new Set([...s.users[u].groups, g])]; changed(); return `Adding user ${u} to group ${g}`; }
      s.users[u].groups = s.users[u].groups.filter((x, i) => i === 0 || x !== g); changed(); return `Removing user ${u} from group ${g}`;
    }
    case 'passwd': {
      const u = names[0] || sh.me(); const x = s.users[u]; if (!x) throw new ShellError(`passwd: user '${u}' does not exist`);
      if (u !== sh.me() && !sh.root) throw new ShellError('passwd: Only root can specify a user name.');
      if (flags.includes('-S')) return `${u} ${x.locked ? 'LK' : x.pw ? 'PS' : 'NP'} 2026-10-29 ${x.minDays ?? 0} ${x.maxDays ?? 99999} ${x.warnDays ?? 7} -1 (${x.locked ? 'Password locked.' : x.pw ? 'Password set, SHA512 crypt.' : 'Empty password.'})`;
      if (flags.includes('-l')) { root('passwd: Permission denied.'); x.locked = true; changed(); return `Locking password for user ${u}.\npasswd: Success`; }
      if (flags.includes('-u')) { root('passwd: Permission denied.'); x.locked = false; changed(); return `Unlocking password for user ${u}.\npasswd: Success`; }
      if (flags.includes('-e')) { root('passwd: Permission denied.'); x.lastChange = 0; changed(); return `Expiring password for user ${u}.\npasswd: Success`; }
      if (flags.includes('--stdin')) { if (!rhel) throw new ShellError("passwd: unrecognized option '--stdin'\n(Ubuntu: use echo 'user:password' | sudo chpasswd)"); root('passwd: Only root can use --stdin.'); if (!String(input || '').trim()) throw new ShellError('passwd: no password supplied on standard input'); x.pw = true; changed(); return `Changing password for user ${u}.\npasswd: all authentication tokens updated successfully.`; }
      x.pw = true; changed(); return `Changing password for user ${u}.\nNew password: \nRetype new password: \npasswd: all authentication tokens updated successfully.\n(This lab sets the password without prompting.)`;
    }
    case 'chpasswd': { root('chpasswd: Permission denied.'); for (const l of String(input || '').split('\n').filter(Boolean)) { const [u] = l.split(':'); if (!s.users[u]) throw new ShellError(`chpasswd: line 1: user '${u}' does not exist`); s.users[u].pw = true; } changed(); return ''; }
    case 'chage': {
      const u = names[names.length - 1]; const x = s.users[u]; if (!x) throw new ShellError(`chage: user '${u || ''}' does not exist in /etc/passwd`);
      if (flags.includes('-l')) return `Last password change\t\t\t\t\t: ${x.lastChange === 0 ? 'password must be changed' : 'Oct 29, 2026'}\nPassword expires\t\t\t\t\t: ${x.maxDays >= 99999 ? 'never' : `in ${x.maxDays} days`}\nPassword inactive\t\t\t\t\t: ${x.inactive ?? 'never'}\nAccount expires\t\t\t\t\t\t: ${x.expire && x.expire !== '-1' ? x.expire : 'never'}\nMinimum number of days between password change\t\t: ${x.minDays ?? 0}\nMaximum number of days between password change\t\t: ${x.maxDays ?? 99999}\nNumber of days of warning before password expires\t: ${x.warnDays ?? 7}`;
      root('chage: Permission denied.');
      if (val('-M', '--maxdays') != null) x.maxDays = +val('-M', '--maxdays');
      if (val('-m', '--mindays') != null) x.minDays = +val('-m', '--mindays');
      if (val('-W', '--warndays') != null) x.warnDays = +val('-W', '--warndays');
      if (val('-I', '--inactive') != null) x.inactive = +val('-I', '--inactive');
      if (val('-E', '--expiredate') != null) x.expire = val('-E', '--expiredate');
      if (val('-d', '--lastday') != null) x.lastChange = +val('-d', '--lastday');
      changed(); return '';
    }
    case 'getent': {
      const [db, key] = args; const src = db === 'hosts' ? null : virtualFile(s, `/etc/${db}`, true);
      if (db === 'hosts') { const ip = resolveName(s, key); if (!ip) throw new ShellError(''); return `${ip.padEnd(15)} ${key}`; }
      if (src == null) throw new ShellError(`Unknown database: ${db}`);
      const rows = src.split('\n').filter((l) => !key || l.split(':')[0] === key); if (key && !rows.length) throw new ShellError(''); return rows.join('\n');
    }
    case 'id': {
      const u = names[0] || sh.me(); const x = s.users[u]; if (!x) throw new ShellError(`id: '${u}': no such user`);
      const g = (n) => `${s.groups[n]?.gid ?? '?'}(${n})`;
      return `uid=${x.uid}(${u}) gid=${g(x.groups[0])} groups=${[...new Set(x.groups)].map(g).join(',')}${s.selinux && !names[0] ? ' context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023' : ''}`;
    }
    case 'groups': { const u = names[0] || sh.me(); return `${names[0] ? `${u} : ` : ''}${(s.users[u]?.groups || []).join(' ')}`; }
    case 'visudo': {
      if (!flags.includes('-c')) throw new ShellError("visudo: interactive editing isn't available here. Write a drop-in file instead, for example:\n  echo '%sysadms ALL=(ALL) ALL' | sudo tee /etc/sudoers.d/sysadms\nthen check it with sudo visudo -c");
      root('visudo: /etc/sudoers: Permission denied');
      const files = ['/etc/sudoers', ...Object.keys(s.fs).filter((k) => k.startsWith('/etc/sudoers.d/') && s.fs[k].t === 'f')];
      const out = []; for (const k of files) { const bad = s.fs[k].content.split('\n').findIndex((l) => !sudoersLineOk(l)); out.push(bad >= 0 ? `${k}:${bad + 1}:${s.fs[k].content.split('\n')[bad].length}: syntax error` : `${k}: parsed OK`); }
      return out.join('\n');
    }
    default: return undefined;
  }
}

// ── Packages ────────────────────────────────────────────────────────────────
function repos(s) {
  const out = [];
  for (const k of Object.keys(s.fs).filter((p) => p.startsWith('/etc/yum.repos.d/') && p.endsWith('.repo'))) {
    let cur = null;
    for (const l of s.fs[k].content.split('\n')) {
      const sec = l.match(/^\s*\[([^\]]+)\]/); if (sec) { cur = { id: sec[1], file: k, enabled: true, gpgcheck: true }; out.push(cur); continue; }
      const kv = l.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/); if (!kv || !cur) continue;
      if (kv[1] === 'baseurl') cur.baseurl = kv[2]; if (kv[1] === 'name') cur.name = kv[2]; if (kv[1] === 'enabled') cur.enabled = kv[2] !== '0'; if (kv[1] === 'gpgcheck') cur.gpgcheck = kv[2] !== '0';
    }
  }
  return out;
}
const repoOk = (s, r) => r.enabled && r.baseurl && s.repoUrls.some((u) => u.replace(/\/$/, '') === r.baseurl.replace(/\/$/, ''));
function installPkg(sh, p) {
  const s = sh.s; if (!s.packages.includes(p)) s.packages.push(p);
  if (s.distro === 'rhel') {
    for (const [svc, info] of Object.entries(RHEL_PKG_SERVICES)) if (info && (info.pkg || svc) === p && !s.services[svc]) s.services[svc] = { active: false, enabled: false, port: info.port, desc: info.desc };
    if (p === 'httpd' && !s.users.apache) { s.users.apache = { uid: 48, groups: ['apache'], shell: '/sbin/nologin', home: '/usr/share/httpd', pw: false }; s.groups.apache = { gid: 48 }; }
    for (const [path, content] of Object.entries(PKG_FILES[p] || {})) {
      const isDir = path.endsWith('/'); const pp = isDir ? path.slice(0, -1) : path;
      if (!s.fs[pp]) { mkNode(s, pp, isDir ? { t: 'd', mode: '755', owner: 'root', group: 'root' } : { t: 'f', mode: '644', owner: 'root', group: 'root', content }); s.fs[pp].ctx = policyCtx(s, pp); }
      for (const k of Object.keys(s.fs)) if (!s.fs[k].ctx) s.fs[k].ctx = policyCtx(s, k);
    }
  } else if (s.pkgServices?.[p] && !s.services[p]) s.services[p] = { ...s.pkgServices[p] };
}
function packages(sh, cmd, a) {
  const s = sh.s; const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x)); const changed = () => sh.opts.onChange?.();
  if ((cmd === 'dnf' || cmd === 'yum' || cmd === 'rpm' || cmd === 'flatpak') && s.distro !== 'rhel') throw new ShellError(`${cmd}: command not found (this is Ubuntu; use apt)`);
  if (cmd === 'rpm') {
    if (flags.includes('-qa')) return [...s.packages].sort().map((p) => `${p}-1.0-1.el10.x86_64`).join('\n');
    if (flags.includes('--import')) { if (!sh.root) throw new ShellError('error: --import: Permission denied'); return ''; }
    if (flags.includes('-qf')) { const p = s.provides[sh.abs(args[0] || '')]; return p && s.packages.includes(p) ? `${p}-1.0-1.el10.x86_64` : `file ${args[0]} is not owned by any package`; }
    if (flags.some((f) => /^-q/.test(f))) return args.map((p) => (s.packages.includes(p) ? `${p}-1.0-1.el10.x86_64` : `package ${p} is not installed`)).join('\n');
    throw new ShellError('rpm: use dnf to install packages; rpm -q, -qa, -qf and --import work here');
  }
  if (cmd === 'flatpak') {
    const [sub, ...rest] = args; const fp = s.flatpak;
    if (sub === 'remotes') return Object.entries(fp.remotes).map(([n, u]) => `${n}\tsystem\t${u}`).join('\n');
    if (sub === 'list') return fp.apps.join('\n');
    if (sub === 'remote-add') { if (!sh.root) throw new ShellError('error: Flatpak system operation requires root (try sudo)'); const [name, url] = rest; if (!name || !url) throw new ShellError('usage: flatpak remote-add [--if-not-exists] NAME LOCATION'); if (fp.remotes[name] && !a.includes('--if-not-exists')) throw new ShellError(`error: Remote ${name} already exists`); fp.remotes[name] = url; changed(); return ''; }
    if (sub === 'install') { if (!sh.root) throw new ShellError('error: Flatpak system operation requires root (try sudo)'); const [remote, app] = rest.length > 1 ? rest : [Object.keys(fp.remotes)[0], rest[0]]; if (!fp.remotes[remote]) throw new ShellError(`error: No remote refs found for '${remote || ''}'`); const ok = (s.flatpakApps || {})[fp.remotes[remote]] || []; if (!ok.includes(app)) throw new ShellError(`error: Nothing matches ${app} in remote ${remote}`); if (!fp.apps.includes(app)) fp.apps.push(app); changed(); return `Installing ${app}... done.\nInstallation complete.`; }
    throw new ShellError('usage: flatpak {remote-add|remotes|install|list}');
  }
  if (cmd === 'apt' || cmd === 'apt-get' || cmd === 'dpkg') return undefined; // handled in core
  const sub = args[0]; const pk = args.slice(1);
  const rs = repos(s); const usable = s.presetRepos || rs.some((r) => repoOk(s, r));
  switch (sub) {
    case 'repolist': {
      const list = s.presetRepos ? [{ id: 'rhel-10-for-x86_64-baseos-rpms', name: 'Red Hat Enterprise Linux 10 for x86_64 - BaseOS (RPMs)', enabled: true }, { id: 'rhel-10-for-x86_64-appstream-rpms', name: 'Red Hat Enterprise Linux 10 for x86_64 - AppStream (RPMs)', enabled: true }] : rs;
      return `repo id${' '.repeat(30)}repo name\n${list.filter((r) => r.enabled || a.includes('all')).map((r) => `${r.id.padEnd(37)}${r.name || r.id}`).join('\n')}`;
    }
    case 'config-manager': {
      if (!sh.root) throw new ShellError('Error: This command has to be run with superuser privileges (under the root user on most systems).');
      const url = (a.find((x) => x.startsWith('--add-repo=')) || '').slice(11) || a[a.indexOf('--add-repo') + 1] || (a.find((x) => x.startsWith('--set=baseurl=')) || '').slice(14);
      if (!url || !/^(https?|file|ftp):\/\//.test(url)) throw new ShellError('usage: dnf config-manager addrepo --set=baseurl=URL   (or the older: dnf config-manager --add-repo URL)');
      const id = url.replace(/^\w+:\/\//, '').replace(/[/:]/g, '_').replace(/_+$/, '');
      sh.s.fs[`/etc/yum.repos.d/${id}.repo`] = { t: 'f', mode: '644', owner: 'root', group: 'root', ctx: 'system_conf_t', content: `[${id}]\nname=created by dnf config-manager from ${url}\nbaseurl=${url}\nenabled=1` };
      changed(); return `Adding repo from: ${url}`;
    }
    case 'install': case 'remove': case 'erase': case 'upgrade': case 'update': case 'reinstall': {
      if (!sh.root) throw new ShellError('Error: This command has to be run with superuser privileges (under the root user on most systems).');
      if (!usable) {
        const bad = rs.find((r) => r.enabled && !repoOk(s, r));
        if (bad) throw new ShellError(`Updating and loading repositories:\n ${bad.id}\nErrors during downloading metadata for repository '${bad.id}':\n  - Curl error (37): Couldn't read a file:// file / or 404 for ${bad.baseurl || '(no baseurl)'}\nError: Failed to download metadata for repo '${bad.id}': Cannot download repomd.xml`);
        throw new ShellError('Error: There are no enabled repositories in "/etc/yum.repos.d", "/etc/yum/repos.d", "/etc/distro.repos.d".');
      }
      if (sub === 'upgrade' || sub === 'update') return 'Updating and loading repositories:\nRepositories loaded.\nNothing to do.';
      if (!pk.length) throw new ShellError('Error: No packages specified.');
      if (sub === 'remove' || sub === 'erase') { const miss = pk.find((p) => !s.packages.includes(p)); if (miss) throw new ShellError(`No match for argument: ${miss}\nNo packages marked for removal.`); s.packages = s.packages.filter((p) => !pk.includes(p)); changed(); return `Removing:\n${pk.map((p) => ` ${p}`).join('\n')}\n\nComplete!`; }
      const want = pk.map((p) => p.replace(/^@/, '')); const miss = want.find((p) => !s.available.includes(p) && !s.packages.includes(p));
      if (miss) throw new ShellError(`Updating and loading repositories:\nRepositories loaded.\nFailed to resolve the transaction:\nNo match for argument: ${miss}`);
      const fresh = want.filter((p) => !s.packages.includes(p));
      for (const p of fresh) installPkg(sh, p); changed();
      if (!fresh.length) return `Package ${want.join(', ')} is already installed.\nNothing to do.`;
      return `Updating and loading repositories:\nRepositories loaded.\nPackage                 Arch     Version            Repository      Size\nInstalling:\n${fresh.map((p) => ` ${p.padEnd(22)} x86_64   1.0-1.el10          AppStream     1.2 MiB`).join('\n')}\n\nTransaction Summary:\n Installing:        ${fresh.length} package${fresh.length > 1 ? 's' : ''}\n${flags.includes('-y') ? '' : 'Is this ok [y/N]: y\n'}[1/${fresh.length}] ${fresh[0]}  100% | done\nComplete!`;
    }
    case 'list': {
      if (args[1] === 'installed' || !args[1]) return `Installed packages\n${[...s.packages].sort().map((p) => `${p.padEnd(30)}1.0-1.el10   @AppStream`).join('\n')}`;
      if (args[1] === 'available') { if (!usable) throw new ShellError('Error: There are no enabled repositories.'); return `Available packages\n${s.available.filter((p) => !s.packages.includes(p)).map((p) => `${p.padEnd(30)}1.0-1.el10   AppStream`).join('\n')}`; }
      return s.packages.includes(args[1]) ? `Installed packages\n${args[1]}` : usable && s.available.includes(args[1]) ? `Available packages\n${args[1]}` : `Error: No matching Packages to list`;
    }
    case 'search': { if (!usable) throw new ShellError('Error: There are no enabled repositories.'); const hits = s.available.filter((p) => pk.some((q) => p.includes(q))); return hits.length ? hits.map((p) => `${p}.x86_64\t${p}`).join('\n') : 'No matches found.'; }
    case 'info': { const p = pk[0]; if (!s.packages.includes(p) && !(usable && s.available.includes(p))) throw new ShellError('Error: No matching Packages to list'); return `Name         : ${p}\nVersion      : 1.0\nRelease      : 1.el10\nArchitecture : x86_64\nRepository   : ${s.packages.includes(p) ? '@System' : 'AppStream'}\nSummary      : ${p} package`; }
    case 'provides': case 'whatprovides': { const f = pk[0]; const p = s.provides[f] || s.provides[sh.abs(f || '')]; return p ? `${p}-1.0-1.el10.x86_64 : ${p} package\nRepo        : AppStream\nMatched From:\nFilename    : ${f}` : `Error: No matches found. If searching for a file, try specifying the full path or using a wildcard prefix ("*/") at the beginning.`; }
    case 'history': return 'ID | Command line | Date and time    | Action(s) | Altered\n 1 |              | 2026-10-20 08:00 | Install   |  412';
    case 'clean': return 'Removed 12 files, 3 directories. 0 errors occurred.';
    case 'module': case 'group': return `${sub}: not used in this lab`;
    default: throw new ShellError(`Unknown argument "${sub || ''}" for command "${cmd}". Try: install, remove, list, search, info, provides, repolist, config-manager`);
  }
}

// ── Services, timers and the journal ────────────────────────────────────────
const TARGETS = ['multi-user.target', 'graphical.target', 'rescue.target', 'emergency.target', 'default.target'];
function systemctl(sh, a) {
  const s = sh.s; const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x)); const changed = () => sh.opts.onChange?.();
  const [verb, ...units] = args; if (!verb) throw new ShellError('systemctl: missing verb (try systemctl status UNIT)');
  const rhel = s.distro === 'rhel'; const libdir = rhel ? '/usr/lib/systemd/system' : '/lib/systemd/system';
  const need = () => { if (!sh.root) throw new ShellError(`Failed to ${verb} ${units[0] || ''}: Access denied\n(Try again with sudo.)`); };
  if (verb === 'list-units' || verb === 'list-unit-files') return Object.entries(s.services).map(([n, x]) => `${`${n}.service`.padEnd(32)}${verb === 'list-unit-files' ? (x.masked ? 'masked' : x.enabled ? 'enabled' : 'disabled') : `loaded ${x.active ? 'active   running' : 'inactive dead   '} ${x.desc || ''}`}`).join('\n');
  if (verb === 'list-timers') return `NEXT                        LEFT      LAST  PASSED  UNIT${' '.repeat(18)}ACTIVATES\n${Object.entries(s.timers).filter(([, t]) => t.active).map(([n, t]) => `Fri 2026-10-30 00:00:00 EDT  9h left   -     -       ${`${n}.timer`.padEnd(22)}${t.service || `${n}.service`}`).join('\n')}\n\n${Object.values(s.timers).filter((t) => t.active).length} timers listed.`;
  if (verb === 'get-default') return s.bootTarget;
  if (verb === 'set-default') { need(); const t = units[0]; if (!TARGETS.includes(t)) throw new ShellError(`Failed to set default target: Unit file ${t} does not exist.`); s.bootTarget = t; changed(); return `Removed '/etc/systemd/system/default.target'.\nCreated symlink '/etc/systemd/system/default.target' → '${libdir}/${t}'.`; }
  if (verb === 'isolate') { need(); if (!TARGETS.includes(units[0])) throw new ShellError(`Failed to start ${units[0]}: Unit ${units[0]} not found.`); return ''; }
  if (verb === 'daemon-reload') { need(); return ''; }
  if (verb === 'reboot' || verb === 'poweroff' || verb === 'halt') { need(); return verb === 'reboot' ? reboot(sh) : 'Powering off… (in this lab the system comes straight back up)\n' + reboot(sh); }
  if (verb === 'default') { need(); s.emergency = null; return ''; }
  if (!units.length) throw new ShellError(`Too few arguments.`);
  const out = [];
  for (const raw of units) {
    const timer = /\.timer$/.test(raw); const name = raw.replace(/\.(service|timer)$/, '');
    if (TARGETS.includes(raw)) { if (verb === 'status' || verb === 'is-active') { out.push(raw === s.bootTarget || raw === 'multi-user.target' ? 'active' : 'inactive'); continue; } }
    const u = timer ? s.timers[name] : s.services[name];
    if (!u) throw new ShellError(verb === 'status' ? `Unit ${raw.includes('.') ? raw : `${raw}.service`} could not be found.` : `Failed to ${verb} ${raw}: Unit ${raw.includes('.') ? raw : `${raw}.service`} not found.`);
    const unit = `${name}.${timer ? 'timer' : 'service'}`;
    switch (verb) {
      case 'status': {
        const recent = s.journal.filter((j) => j.unit === name).slice(-3).map((j) => `Oct 29 10:14:02 ${s.hostname} ${name}[2741]: ${j.msg}`).join('\n');
        out.push(`${u.active ? '●' : u.failed ? '×' : '○'} ${unit} - ${u.desc || name}\n     Loaded: ${u.masked ? 'masked (Reason: Unit ' + unit + ' is masked.)' : `loaded (${libdir}/${unit}; ${u.enabled ? 'enabled' : 'disabled'}; preset: disabled)`}\n     Active: ${u.active ? 'active (running) since Thu 2026-10-29 08:01:12 EDT; 2h ago' : u.failed ? 'failed (Result: exit-code) since Thu 2026-10-29 10:14:02 EDT' : 'inactive (dead)'}${timer && u.onCalendar ? `\n    Trigger: Fri 2026-10-30 00:00:00 EDT\n   Triggers: ● ${u.service || `${name}.service`}` : ''}${recent ? `\n\n${recent}` : ''}`);
        break;
      }
      case 'is-active': out.push(u.active ? 'active' : u.failed ? 'failed' : 'inactive'); break;
      case 'is-enabled': out.push(u.masked ? 'masked' : u.enabled ? 'enabled' : 'disabled'); break;
      case 'is-failed': out.push(u.failed ? 'failed' : u.active ? 'active' : 'inactive'); break;
      case 'start': case 'restart': case 'reload': case 'try-restart': {
        need(); if (u.masked) throw new ShellError(`Failed to start ${unit}: Unit ${unit} is masked.`);
        if (!timer) { const err = webStart(s, name) || reqFail(s, name); if (err) { u.active = false; u.failed = true; changed(); throw new ShellError(err); } }
        if (name === 'chronyd') s.chrony.sources = chronySources(s);
        if (name === 'atd' || name === 'crond' || name === 'cron') u.failed = false;
        u.active = true; u.failed = false; if (verb !== 'start') u.restartedAt = Date.now(); break;
      }
      case 'stop': need(); u.active = false; break;
      case 'enable': case 'disable': {
        need(); if (u.masked && verb === 'enable') throw new ShellError(`Failed to enable unit: Unit file ${unit} is masked.`);
        u.enabled = verb === 'enable';
        if (flags.includes('--now')) {
          if (verb === 'enable') { if (!timer) { const err = webStart(s, name) || reqFail(s, name); if (err) { u.failed = true; changed(); throw new ShellError(`Created symlink '/etc/systemd/system/multi-user.target.wants/${unit}' → '${libdir}/${unit}'.\n${err}`); } } u.active = true; u.failed = false; if (name === 'chronyd') s.chrony.sources = chronySources(s); } else u.active = false;
        }
        out.push(verb === 'enable' ? `Created symlink '/etc/systemd/system/${timer ? 'timers' : 'multi-user'}.target.wants/${unit}' → '${libdir}/${unit}'.` : `Removed '/etc/systemd/system/multi-user.target.wants/${unit}'.`);
        break;
      }
      case 'mask': need(); u.masked = true; u.active = false; out.push(`Created symlink '/etc/systemd/system/${unit}' → '/dev/null'.`); break;
      case 'unmask': need(); u.masked = false; out.push(`Removed '/etc/systemd/system/${unit}'.`); break;
      default: throw new ShellError(`Unknown command verb '${verb}'.`);
    }
  }
  changed(); return out.join('\n');
}
// A service can declare requirements on its config, e.g. requires: [{file, re, msg}].
function reqFail(s, name) {
  for (const r of s.services[name]?.requires || []) {
    const t = s.fs[r.file]?.content;
    if (t == null || !new RegExp(r.re, 'm').test(t)) {
      s.journal.push({ unit: name, prio: 3, msg: r.msg || `configuration error in ${r.file}` }, { unit: name, prio: 3, msg: `${name}.service: Main process exited, code=exited, status=1/FAILURE` }, { unit: name, prio: 4, msg: `${name}.service: Failed with result 'exit-code'.` });
      return `Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`;
    }
  }
  return '';
}
function journalctl(sh, a) {
  const s = sh.s; const u = (a.find((x) => x.startsWith('--unit=')) || '').slice(7) || (a.indexOf('-u') >= 0 ? a[a.indexOf('-u') + 1] : null);
  const p = (a.find((x) => x.startsWith('--priority=')) || '').slice(11) || (a.indexOf('-p') >= 0 ? a[a.indexOf('-p') + 1] : null);
  const pr = { emerg: 0, alert: 1, crit: 2, err: 3, warning: 4, notice: 5, info: 6, debug: 7 }[p] ?? (p != null ? +p : 7);
  const n = a.indexOf('-n') >= 0 ? +a[a.indexOf('-n') + 1] : null;
  const prev = a.includes('-b') && a[a.indexOf('-b') + 1] === '-1';
  if (prev && !s.fs['/var/log/journal'] && !/^\s*Storage\s*=\s*persistent/m.test(s.fs['/etc/systemd/journald.conf']?.content || '')) throw new ShellError('Specifying boot ID or boot offset has no effect, no persistent journal was found.');
  if (!sh.root && !sh.inGroup('wheel') && !sh.inGroup('adm') && !sh.inGroup('systemd-journal')) return 'Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'systemd-journal\', \'wheel\' can see all messages.';
  let rows = s.journal.filter((j) => (!u || j.unit === u.replace(/\.service$/, '')) && (j.prio ?? 6) <= pr);
  if (n) rows = rows.slice(-n);
  return rows.length ? rows.map((j, i) => `Oct 29 ${String(8 + Math.floor(i / 6)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}:14 ${s.hostname} ${j.unit}[${j.pid || 1200 + i}]: ${j.msg}`).join('\n') : '-- No entries --';
}

// ── Scheduling ──────────────────────────────────────────────────────────────
const cronLineOk = (l) => !l.trim() || /^\s*#/.test(l) || /^\s*\w+=/.test(l) || /^@(reboot|yearly|annually|monthly|weekly|daily|hourly)\s+\S/.test(l.trim()) || /^(\S+\s+){5}\S/.test(l.trim()) && l.trim().split(/\s+/).slice(0, 5).every((f) => /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$|^(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(-\w+)?$/i.test(f));
function sched(sh, cmd, a, input) {
  const s = sh.s; const changed = () => sh.opts.onChange?.(); const args = a.filter((x) => !/^-/.test(x));
  if (cmd === 'crontab') {
    const ui = a.indexOf('-u'); const u = ui >= 0 ? a[ui + 1] : sh.me();
    if (ui >= 0 && !sh.root && u !== sh.me()) throw new ShellError('crontab: must be privileged to use -u');
    if (!s.users[u]) throw new ShellError(`crontab: user '${u}' unknown`);
    if (a.includes('-l')) { const t = s.crontabs[u]; if (!t) throw new ShellError(`no crontab for ${u}`); return t.replace(/\n$/, ''); }
    if (a.includes('-r')) { delete s.crontabs[u]; changed(); return ''; }
    if (a.includes('-e')) throw new ShellError(`crontab -e opens an editor, which isn't available here. Install the whole crontab from standard input instead:\n  echo '*/5 * * * * /usr/bin/logger hello' | crontab${ui >= 0 ? ` -u ${u}` : ''} -\n(To keep existing lines: (crontab -l; echo 'NEW LINE') | crontab -)`);
    const src = args.filter((x) => x !== u).pop();
    const text = a.includes('-') || src === undefined ? String(input ?? '') : sh.readFile(src);
    const bad = text.split('\n').findIndex((l) => !cronLineOk(l));
    if (bad >= 0) throw new ShellError(`"-":${bad + 1}: bad ${/^\s*\S+\s*$/.test(text.split('\n')[bad]) ? 'command' : 'minute'}\nerrors in crontab file, can't install.`);
    s.crontabs[u] = text.endsWith('\n') ? text : `${text}\n`; changed(); return '';
  }
  if (cmd === 'at') {
    if (!s.services.atd?.active) throw new ShellError("Can't open /var/run/atd.pid to signal atd. No atd running?");
    if (a.includes('-l')) return sched(sh, 'atq', [], '');
    const when = a.join(' '); if (!when) throw new ShellError('Garbled time');
    if (!/^(now(\s*\+\s*\d+\s*(minutes?|hours?|days?|weeks?))?|\d{1,2}(:\d{2})?\s*(am|pm)?(\s+(today|tomorrow))?|midnight|noon|teatime|tomorrow)$/i.test(when.trim())) throw new ShellError('syntax error. Last token seen: ' + when.split(' ').pop() + '\nGarbled time');
    const job = { id: s.atJobs.length + 1, when, cmd: String(input || '').trim(), user: sh.me() };
    if (!job.cmd) throw new ShellError('at: no commands given on standard input (try: echo "COMMAND" | at now + 5 minutes)');
    s.atJobs.push(job); changed(); return `warning: commands will be executed using /bin/sh\njob ${job.id} at Thu Oct 29 ${/now/.test(when) ? '10:35:00' : '23:00:00'} 2026`;
  }
  if (cmd === 'atq') return s.atJobs.filter((j) => sh.root || j.user === sh.me()).map((j) => `${j.id}\tThu Oct 29 ${/now/.test(j.when) ? '10:35:00' : '23:00:00'} 2026 a ${j.user}`).join('\n');
  if (cmd === 'atrm') { for (const id of args) s.atJobs = s.atJobs.filter((j) => String(j.id) !== id); changed(); return ''; }
  if (cmd === 'tuned-adm') {
    const [sub, prof] = args;
    if (sub === 'list') return `Available profiles:\n${TUNED.map((p) => `- ${p}`).join('\n')}\nCurrent active profile: ${s.tuned.active}`;
    if (sub === 'active') return s.services.tuned?.active ? `Current active profile: ${s.tuned.active}` : 'Cannot talk to TuneD daemon via DBus. Is TuneD daemon running?';
    if (sub === 'recommend') return s.tuned.recommend;
    if (sub === 'profile') { if (!sh.root) throw new ShellError('Cannot talk to TuneD daemon: Permission denied (try sudo)'); if (!s.services.tuned?.active) throw new ShellError('Cannot talk to TuneD daemon via DBus. Is TuneD daemon running?'); if (!TUNED.includes(prof)) throw new ShellError(`Requested profile '${prof}' doesn't exist.`); s.tuned.active = prof; changed(); return ''; }
    if (sub === 'off') { s.tuned.active = 'off'; changed(); return ''; }
    throw new ShellError('usage: tuned-adm {list|active|recommend|profile NAME|off}');
  }
  return undefined;
}

// ── Networking and time ─────────────────────────────────────────────────────
const sameNet = (a, b, bits = 24) => { const n = (ip) => ip.split('.').reduce((x, o) => (x << 8) + +o, 0) >>> 0; const m = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0; return ((n(a) & m) >>> 0) === ((n(b) & m) >>> 0); };
export function resolveName(s, name) {
  if (!name) return null; if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return name;
  if (['localhost', s.hostname, s.hostname.split('.')[0]].includes(name)) return name === 'localhost' ? '127.0.0.1' : s.ip;
  for (const l of (s.fs['/etc/hosts']?.content || '').split('\n')) { const [ip, ...names] = l.replace(/#.*/, '').trim().split(/\s+/); if (ip && names.includes(name)) return ip; }
  const ns = /^\s*nameserver\s+\S+/m.test(s.fs['/etc/resolv.conf']?.content || '');
  const dnsOk = ns && (!s.dnsServerNeeded || (s.fs['/etc/resolv.conf']?.content || '').includes(s.dnsServerNeeded));
  return dnsOk ? s.dns[name] || s.dns[name.split('.')[0]] || null : null;
}
export function reachable(s, ip) {
  if (ip === '127.0.0.1' || ip === s.ip) return true;
  if (!s.ip || s.ipDown) return false;
  const known = s.net[ip] ?? Object.entries(s.dns).some(([, v]) => v === ip) ?? false;
  if (!known) return false;
  if (sameNet(ip, s.ip, s.prefix)) return true;
  return !!s.gw && sameNet(s.gw, s.ip, s.prefix) && s.gwOk !== false && (!s.gwReal || s.gw === s.gwReal);
}
function applyCon(s, c) {
  if (c.method === 'auto') { s.ip = s.dhcpIp || s.ip; s.gw = s.dhcpGw || s.gw; return; }
  const [ip, bits] = String(c.addresses || '').split(',')[0].split('/'); if (ip) { s.ip = ip; s.prefix = +(bits || 24); }
  s.gw = c.gateway || ''; const dns = String(c.dns || '').split(/[,\s]+/).filter(Boolean);
  s.fs['/etc/resolv.conf'] = { ...(s.fs['/etc/resolv.conf'] || { t: 'f', mode: '644', owner: 'root', group: 'root' }), content: `# Generated by NetworkManager\n${c.searchDomain ? `search ${c.searchDomain}\n` : ''}${dns.map((d) => `nameserver ${d}`).join('\n')}\n` };
  if (c.hostname) s.hostname = c.hostname;
}
const NM_KEYS = { 'ipv4.addresses': 'addresses', 'ipv4.address': 'addresses', 'ipv4.gateway': 'gateway', 'ipv4.dns': 'dns', 'ipv4.method': 'method', 'connection.autoconnect': 'autoconnect', 'ipv6.addresses': 'addresses6', 'ipv6.method': 'method6', 'ipv6.gateway': 'gateway6', 'ipv4.dns-search': 'searchDomain', 'ipv6.dns': 'dns6', ifname: 'dev', 'connection.interface-name': 'dev', 'con-name': 'name' };
function net(sh, cmd, a) {
  const s = sh.s; const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x)); const changed = () => sh.opts.onChange?.();
  switch (cmd) {
    case 'nmcli': {
      if (!s.nm) throw new ShellError('nmcli: command not found (this lab uses netplan/ip)');
      const ab = { c: 'connection', con: 'connection', conn: 'connection', d: 'device', dev: 'device', g: 'general', gen: 'general', s: 'show', m: 'modify', mod: 'modify' };
      const [obj0, verb0, name, ...kv] = args; const obj = ab[obj0] || obj0; const verb = ab[verb0] || verb0 || 'show';
      if (obj === 'general' && verb === 'hostname') { if (!name) return s.hostname; if (!sh.root) throw new ShellError('Error: Insufficient privileges.'); s.hostname = name; s.fs['/etc/hostname'].content = `${name}\n`; changed(); return ''; }
      if (obj === 'device') return `DEVICE  TYPE      STATE                   CONNECTION\neth0    ethernet  connected               ${Object.keys(s.nm.cons).find((k) => s.nm.cons[k].dev === 'eth0') || '--'}\nlo      loopback  connected (externally)  lo`;
      if (obj !== 'connection') throw new ShellError('Error: argument not understood. Try: nmcli connection show | modify | up');
      if (verb === 'show') {
        if (!name) return `NAME                UUID                                  TYPE      DEVICE\n${Object.entries(s.nm.cons).map(([n, c]) => `${n.padEnd(19)} 5fb06bd0-0bb0-7ffb-45f1-d6edd65f3e03  ethernet  ${c.dev}`).join('\n')}\nlo                  9a1c7e2f-6a4e-4f0b-8d9a-1f2e3d4c5b6a  loopback  lo`;
        const c = s.nm.cons[name]; if (!c) throw new ShellError(`Error: ${name} - no such connection profile.`);
        return `connection.id:                          ${name}\nconnection.interface-name:              ${c.dev}\nconnection.autoconnect:                 ${c.autoconnect}\nipv4.method:                            ${c.method}\nipv4.dns:                               ${c.dns || '--'}\nipv4.dns-search:                        ${c.searchDomain || '--'}\nipv4.addresses:                         ${c.addresses || '--'}\nipv4.gateway:                           ${c.gateway || '--'}\nipv6.method:                            ${c.method6 || 'auto'}\nipv6.addresses:                         ${c.addresses6 || '--'}\nIP4.ADDRESS[1]:                         ${s.ip}/${s.prefix}\nIP4.GATEWAY:                            ${s.gw || '--'}`;
      }
      if (!sh.root) throw new ShellError('Error: Insufficient privileges.');
      if (verb === 'modify') {
        const c = s.nm.cons[name]; if (!c) throw new ShellError(`Error: unknown connection '${name}'.`);
        for (let i = 0; i < kv.length; i += 2) {
          const plus = kv[i].startsWith('+'); const minus = kv[i].startsWith('-'); const k = NM_KEYS[kv[i].replace(/^[+-]/, '')]; const v = kv[i + 1];
          if (!k) throw new ShellError(`Error: invalid or not-allowed setting '${kv[i]}'.`);
          if (v == null) throw new ShellError(`Error: value for '${kv[i]}' is missing.`);
          if (k === 'addresses' && v && !/^(\d+\.\d+\.\d+\.\d+\/\d+)(,\s*\d+\.\d+\.\d+\.\d+\/\d+)*$/.test(v) && !/^\d+\.\d+\.\d+\.\d+$/.test(v)) throw new ShellError(`Error: failed to modify ipv4.addresses: invalid IP address: Invalid IPv4 address '${v}'.`);
          if (k === 'method' && !['auto', 'manual', 'disabled', 'link-local', 'shared'].includes(v)) throw new ShellError(`Error: failed to modify ipv4.method: '${v}' not among [auto, disabled, link-local, manual, shared].`);
          c[k] = plus ? [c[k], v].filter(Boolean).join(',') : minus ? String(c[k] || '').split(',').filter((x) => x !== v).join(',') : (k === 'addresses' && /^\d+\.\d+\.\d+\.\d+$/.test(v) ? `${v}/32` : v);
        }
        if (c.method === 'manual' && !c.addresses) throw new ShellError("Error: Failed to modify connection: ipv4.addresses: this property cannot be empty for 'method=manual'");
        changed(); return '';
      }
      if (verb === 'up' || verb === 'reload') {
        if (verb === 'reload') return '';
        const c = s.nm.cons[name]; if (!c) throw new ShellError(`Error: unknown connection '${name}'.`);
        applyCon(s, c); changed(); return 'Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/3)';
      }
      if (verb === 'down') { s.ipDown = true; changed(); return `Connection '${name}' successfully deactivated.`; }
      if (verb === 'add') {
        const o = {}; for (let i = 0; i < a.length; i++) if (NM_KEYS[a[i]] || a[i] === 'type') { o[NM_KEYS[a[i]] || a[i]] = a[i + 1]; i++; }
        const n = o.name || `${o.type}-${o.dev}`; s.nm.cons[n] = { dev: o.dev || 'eth0', method: o.method || (o.addresses ? 'manual' : 'auto'), addresses: o.addresses || '', gateway: o.gateway || '', dns: o.dns || '', autoconnect: o.autoconnect || 'yes' };
        changed(); return `Connection '${n}' (8d1e5a4c-2b3f-4a6e-9c7d-0e1f2a3b4c5d) successfully added.`;
      }
      throw new ShellError(`Error: '${verb}' is not valid 'connection' command.`);
    }
    case 'ip': {
      const [obj] = args; const brief = flags.includes('-br') || flags.includes('-brief');
      if (!obj || /^a(ddr(ess)?)?$/.test(obj)) {
        if (brief) return `lo               UNKNOWN        127.0.0.1/8 ::1/128\neth0             ${s.ipDown ? 'DOWN' : 'UP  '}           ${s.ipDown ? '' : `${s.ip}/${s.prefix}`}`;
        return `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state ${s.ipDown ? 'DOWN' : 'UP'}\n    link/ether 52:54:00:01:fa:0b brd ff:ff:ff:ff:ff:ff\n${s.ipDown ? '' : `    inet ${s.ip}/${s.prefix} brd ${s.ip.replace(/\d+$/, '255')} scope global ${s.nm?.cons && Object.values(s.nm.cons)[0].method === 'manual' ? 'noprefixroute' : 'dynamic'} eth0`}`;
      }
      if (/^r(oute)?$/.test(obj)) return `${s.gw ? `default via ${s.gw} dev eth0 proto static metric 100\n` : ''}${s.ip.replace(/\d+$/, '0')}/${s.prefix} dev eth0 proto kernel scope link src ${s.ip} metric 100`;
      if (/^l(ink)?$/.test(obj)) return '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP';
      throw new ShellError(`Object "${obj}" is unknown, try "ip help".`);
    }
    case 'ifconfig': return `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${s.ip}  netmask 255.255.255.0`;
    case 'hostnamectl': {
      if (args[0] === 'set-hostname' || args[0] === 'hostname' && args[1]) { if (!sh.root) throw new ShellError('Could not set static hostname: Access denied'); s.hostname = args[1]; s.fs['/etc/hostname'].content = `${args[1]}\n`; changed(); return ''; }
      return ` Static hostname: ${(s.fs['/etc/hostname']?.content || '').trim()}\n${(s.fs['/etc/hostname']?.content || '').trim() !== s.hostname ? `Transient hostname: ${s.hostname}\n` : ''}       Icon name: computer-vm\n         Chassis: vm\nOperating System: ${s.distro === 'rhel' ? 'Red Hat Enterprise Linux 10.0 (Coughlan)' : 'Ubuntu 24.04.1 LTS'}\n          Kernel: Linux ${s.distro === 'rhel' ? '6.12.0-55.el10.x86_64' : '6.8.0-45-generic'}\n    Architecture: x86-64`;
    }
    case 'hostname': {
      if (!args.length) return flags.includes('-I') ? s.ip : s.hostname;
      if (!sh.root) throw new ShellError('hostname: you must be root to change the host name');
      s.hostname = args[0]; changed(); return '';
    }
    case 'ping': {
      const h = args.find((x) => !/^\d+$/.test(x) || /\./.test(x)) || args[0]; if (!h) throw new ShellError('ping: usage error: Destination address required');
      const ip = resolveName(s, h); if (!ip) throw new ShellError(`ping: ${h}: Name or service not known`);
      if (!s.gw && !sameNet(ip, s.ip, s.prefix) && ip !== '127.0.0.1') throw new ShellError('ping: connect: Network is unreachable');
      const ok = reachable(s, ip);
      return ok ? `PING ${h} (${ip}) 56(84) bytes of data.\n64 bytes from ${ip}: icmp_seq=1 ttl=64 time=0.42 ms\n64 bytes from ${ip}: icmp_seq=2 ttl=64 time=0.39 ms\n64 bytes from ${ip}: icmp_seq=3 ttl=64 time=0.41 ms\n\n--- ${h} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 2003ms` : `PING ${h} (${ip}) 56(84) bytes of data.\nFrom ${s.ip} icmp_seq=1 Destination Host Unreachable\n\n--- ${h} ping statistics ---\n3 packets transmitted, 0 received, +3 errors, 100% packet loss, time 2042ms`;
    }
    case 'host': case 'nslookup': case 'dig': {
      const h = args.find((x) => !x.startsWith('@')); const ip = resolveName(s, h);
      if (!ip) return cmd === 'host' ? `Host ${h} not found: 3(NXDOMAIN)` : `** server can't find ${h}: NXDOMAIN`;
      return cmd === 'host' ? `${h} has address ${ip}` : cmd === 'dig' ? `;; ANSWER SECTION:\n${h}.\t\t300\tIN\tA\t${ip}` : `Name:\t${h}\nAddress: ${ip}`;
    }
    case 'curl': case 'wget': {
      const url = args.find((x) => /^(https?:\/\/)?[\w.-]+(:\d+)?(\/|$)/.test(x)); if (!url) throw new ShellError(`${cmd}: try '${cmd} http://localhost/'`);
      const host = url.replace(/^https?:\/\//, '').split(/[:/]/)[0]; const ip = resolveName(s, host);
      if (!ip) throw new ShellError(`curl: (6) Could not resolve host: ${host}`);
      const self = ip === s.ip || ip === '127.0.0.1';
      if (!self) { const w = s.web?.[`${host}${url.replace(/^https?:\/\/[^/]+/, '') || '/'}`] ?? s.web?.[host]; if (w != null && reachable(s, ip)) return w; throw new ShellError(`curl: (7) Failed to connect to ${host} port 80: ${reachable(s, ip) ? 'Connection refused' : 'No route to host'}`); }
      const r = httpGet(s, url.replace(host, 'localhost'), 'local');
      if (r.err) throw new ShellError(r.err);
      return flags.some((f) => /I/.test(f)) ? `HTTP/1.1 ${r.code} ${r.code === 200 ? 'OK' : r.code === 403 ? 'Forbidden' : 'Not Found'}\nServer: Apache/2.4.63 (Red Hat Enterprise Linux)` : r.body;
    }
    case 'ss': case 'netstat': {
      const rows = Object.entries(s.services).filter(([, x]) => x.active && (x.port || x.ports)).flatMap(([n, x]) => (n === 'httpd' || n === 'nginx' ? webPorts(s) : [x.port]).map((p) => `tcp   LISTEN 0      511          0.0.0.0:${p}`.padEnd(46) + `0.0.0.0:*    users:(("${n}",pid=${1100 + +p},fd=4))`));
      return `Netid State  Recv-Q Send-Q   Local Address:Port   Peer Address:Port Process\n${rows.join('\n')}`;
    }
    case 'timedatectl': {
      const [sub, v] = args;
      if (sub === 'set-timezone') { if (!sh.root) throw new ShellError('Failed to set time zone: Access denied'); if (!TZS.includes(v)) throw new ShellError(`Failed to set time zone: Invalid or not installed time zone '${v}'`); s.tz = v; changed(); return ''; }
      if (sub === 'set-ntp') { if (!sh.root) throw new ShellError('Failed to set ntp: Access denied'); s.ntp = /^(true|yes|1|on)$/.test(v); if (s.services.chronyd) { s.services.chronyd.active = s.ntp; s.services.chronyd.enabled = s.ntp; } changed(); return ''; }
      if (sub === 'list-timezones') return TZS.join('\n');
      const synced = s.services.chronyd?.active && s.chrony.sources.some((x) => s.timeServers ? s.timeServers.includes(x) : true);
      return `               Local time: Thu 2026-10-29 10:42:13 ${s.tz === 'UTC' ? 'UTC' : 'EDT'}\n           Universal time: Thu 2026-10-29 14:42:13 UTC\n                 RTC time: Thu 2026-10-29 14:42:13\n                Time zone: ${s.tz}\nSystem clock synchronized: ${synced ? 'yes' : 'no'}\n              NTP service: ${s.services.chronyd?.active ? 'active' : 'inactive'}\n          RTC in local TZ: no`;
    }
    case 'chronyc': {
      if (!s.services.chronyd?.active) throw new ShellError('506 Cannot talk to daemon');
      if (args[0] === 'sources') return `MS Name/IP address         Stratum Poll Reach LastRx Last sample\n===============================================================================\n${s.chrony.sources.map((x, i) => `${i === 0 && (!s.timeServers || s.timeServers.includes(x)) ? '^*' : '^?'} ${x.padEnd(27)} ${s.timeServers && !s.timeServers.includes(x) ? '0   6     0     -     +0ns[   +0ns] +/-    0ns' : '2   6   377    35   +112us[ +140us] +/-   18ms'}`).join('\n')}`;
      if (args[0] === 'tracking') return `Reference ID    : AC19FAFE (${s.chrony.sources[0] || '-'})\nStratum         : 3\nLeap status     : Normal`;
      throw new ShellError('chronyc: try chronyc sources or chronyc tracking');
    }
    case 'ssh-keygen': {
      const t = (a.indexOf('-t') >= 0 ? a[a.indexOf('-t') + 1] : 'ed25519'); const home = s.users[sh.me()].home;
      const f = a.indexOf('-f') >= 0 ? sh.abs(a[a.indexOf('-f') + 1]) : `${home}/.ssh/id_${t}`;
      if (s.fs[f] && !flags.includes('-y')) throw new ShellError(`${f} already exists.\nOverwrite (y/n)? n`);
      const dir = parentOf(f); if (!s.fs[dir]) s.fs[dir] = { t: 'd', mode: '700', owner: sh.me(), group: sh.me(), ctx: s.selinux ? 'ssh_home_t' : undefined };
      s.fs[f] = { t: 'f', mode: '600', owner: sh.me(), group: sh.me(), content: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ...\n-----END OPENSSH PRIVATE KEY-----`, ctx: s.selinux ? 'ssh_home_t' : undefined };
      s.fs[`${f}.pub`] = { t: 'f', mode: '644', owner: sh.me(), group: sh.me(), content: `ssh-${t} AAAAC3NzaC1lZDI1NTE5AAAAIK9z${sh.me()}lab ${sh.me()}@${s.hostname}`, ctx: s.selinux ? 'ssh_home_t' : undefined };
      changed(); return `Generating public/private ${t} key pair.\nEnter passphrase (empty for no passphrase): \nYour identification has been saved in ${f}\nYour public key has been saved in ${f}.pub\nThe key fingerprint is:\nSHA256:7Qe1Vb9yK2mH0pL4xR8sT3nW6cZ5aJ1dF0gB2hN4kE ${sh.me()}@${s.hostname}`;
    }
    case 'ssh-copy-id': {
      const target = args[0]; if (!target) throw new ShellError('Usage: ssh-copy-id [-i identity_file] [user@]hostname');
      const [user, host] = target.includes('@') ? target.split('@') : [sh.me(), target];
      const ip = resolveName(s, host); if (!ip || !reachable(s, ip)) throw new ShellError(`ssh: connect to host ${host} port 22: No route to host`);
      const home = s.users[sh.me()].home; const key = Object.keys(s.fs).find((k) => k.startsWith(`${home}/.ssh/`) && k.endsWith('.pub'));
      if (!key) throw new ShellError('/usr/bin/ssh-copy-id: ERROR: No identities found (run ssh-keygen first)');
      if (!s.sshTrust.some((x) => x.from === sh.me() && x.to === `${user}@${host}`)) s.sshTrust.push({ from: sh.me(), to: `${user}@${host}` });
      changed(); return `/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s)\n${user}@${host}'s password: \n\nNumber of key(s) added: 1\n\nNow try logging into the machine, with:   "ssh '${user}@${host}'"`;
    }
    case 'ssh': {
      const target = args[0]; if (!target) throw new ShellError('usage: ssh [user@]hostname [command]');
      const [user, host] = target.includes('@') ? target.split('@') : [sh.me(), target];
      const ip = resolveName(s, host); if (!ip) throw new ShellError(`ssh: Could not resolve hostname ${host}: Name or service not known`);
      if (!reachable(s, ip)) throw new ShellError(`ssh: connect to host ${host} port 22: No route to host`);
      if (!s.sshTrust.some((x) => x.from === sh.me() && x.to === `${user}@${host}`)) return `${user}@${host}'s password: \n(This lab doesn't simulate the remote password. Set up key-based login with ssh-keygen and ssh-copy-id, then try again.)`;
      sh.s.sshLogins = [...new Set([...(sh.s.sshLogins || []), `${user}@${host}`])]; changed();
      return `Last login: Thu Oct 29 09:58:11 2026 from ${s.ip}\n[${user}@${host.split('.')[0]} ~]$ logout\nConnection to ${host} closed.\n(Key-based login worked without a password. This lab returns you to ${s.hostname}.)`;
    }
    default: return undefined;
  }
}

// ── Files: archives, links, disk usage ──────────────────────────────────────
export const rootUsed = (s) => Math.round((s.rootBase ?? (s.blk['/dev/vda2']?.fsSize || 19454) * 0.38) + Object.values(s.fs).reduce((n, x) => n + (x.size || 0), 0) / 1048576);
const nodeSize = (n) => (n.t === 'd' ? 4096 : n.size ?? (n.content || '').length);
export function human(bytes) { const u = ['', 'K', 'M', 'G', 'T']; let i = 0; let v = bytes; while (v >= 1024 && i < 4) { v /= 1024; i++; } return i === 0 ? String(bytes) : `${v < 10 ? v.toFixed(1) : Math.round(v)}${u[i]}`; }
function files(sh, cmd, a, input) {
  const s = sh.s; const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x)); const changed = () => sh.opts.onChange?.();
  switch (cmd) {
    case 'tar': {
      let t = [...a]; if (t[0] && !t[0].startsWith('-') && /^[cxtzjJvfpaP]+$/.test(t[0])) t[0] = `-${t[0]}`;
      let mode = null; let comp = null; let file = null; let dir = null; const paths = [];
      for (let i = 0; i < t.length; i++) {
        const x = t[i];
        if (x === '-C' || x === '--directory') { dir = t[++i]; continue; }
        if (x.startsWith('--file=')) { file = x.slice(7); continue; }
        if (x === '--gzip') { comp = 'gzip'; continue; } if (x === '--bzip2') { comp = 'bzip2'; continue; } if (x === '--xz') { comp = 'xz'; continue; }
        if (x === '--create') { mode = 'c'; continue; } if (x === '--extract') { mode = 'x'; continue; } if (x === '--list') { mode = 't'; continue; }
        if (/^-[a-zA-Z]+$/.test(x)) { for (const ch of x.slice(1)) { if ('cxt'.includes(ch)) mode = ch; if (ch === 'z') comp = 'gzip'; if (ch === 'j') comp = 'bzip2'; if (ch === 'J') comp = 'xz'; if (ch === 'f') file = t[++i]; } continue; }
        paths.push(x);
      }
      if (!mode) throw new ShellError("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options");
      if (!file) throw new ShellError('tar: this lab needs an archive file: use -f FILE');
      const ap = sh.abs(file);
      if (mode === 'c') {
        if (!paths.length) throw new ShellError('tar: Cowardly refusing to create an empty archive');
        const entries = {}; const errs = [];
        for (const p0 of paths) {
          const p = sh.abs(p0); if (!s.fs[p]) { errs.push(`tar: ${p0}: Cannot stat: No such file or directory`); continue; }
          for (const k of Object.keys(s.fs).filter((k) => k === p || k.startsWith(`${p === '/' ? '' : p}/`)).sort()) {
            const n = s.fs[k]; if (n.t === 'f' && !sh.can(n, 4)) { errs.push(`tar: ${k.slice(1)}: Cannot open: Permission denied`); continue; }
            entries[p0.startsWith('/') ? k.slice(1) : k.slice(sh.s.cwd.length + 1) || k.split('/').pop()] = JSON.parse(JSON.stringify(n));
          }
        }
        const dirNode = s.fs[parentOf(ap)]; if (!dirNode) throw new ShellError(`tar: ${file}: Cannot open: No such file or directory`); if (!sh.can(dirNode, 2)) throw new ShellError(`tar: ${file}: Cannot open: Permission denied`);
        const total = Object.values(entries).reduce((n, x) => n + nodeSize(x), 0);
        s.fs[ap] = { t: 'f', mode: sh.root ? '644' : '664', owner: sh.me(), group: s.users[sh.me()].groups[0], content: '', size: Math.max(512, Math.round(total / (comp ? 4 : 1))), archive: { comp, entries }, ctx: s.selinux ? s.fs[parentOf(ap)]?.ctx : undefined };
        changed(); const warn = paths.some((p) => p.startsWith('/')) ? "tar: Removing leading `/' from member names\n" : '';
        return `${warn}${flags.some((f) => /v/.test(f)) ? Object.keys(entries).join('\n') : ''}${errs.length ? `\n${errs.join('\n')}\ntar: Exiting with failure status due to previous errors` : ''}`.replace(/^\n/, '');
      }
      const n = s.fs[ap]; if (!n) throw new ShellError(`tar: ${file}: Cannot open: No such file or directory`);
      if (!n.archive) throw new ShellError('tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors');
      if (comp && comp !== n.archive.comp) throw new ShellError(`${comp}: stdin: not in ${comp} format\ntar: Child returned status 1\ntar: Error is not recoverable: exiting now`);
      if (mode === 't') return Object.entries(n.archive.entries).map(([k, x]) => (flags.some((f) => /v/.test(f)) ? `${x.t === 'd' ? 'd' : '-'}rw-r--r-- ${x.owner}/${x.group} ${String(nodeSize(x)).padStart(7)} 2026-10-29 09:12 ${k}${x.t === 'd' ? '/' : ''}` : `${k}${x.t === 'd' ? '/' : ''}`)).join('\n');
      const base = sh.abs(dir || '.'); if (!s.fs[base]) throw new ShellError(`tar: ${dir}: Cannot open: No such file or directory`);
      for (const [k, x] of Object.entries(n.archive.entries)) { const dest = `${base === '/' ? '' : base}/${k}`; mkNode(s, dest, { ...JSON.parse(JSON.stringify(x)), owner: sh.root ? x.owner : sh.me(), group: sh.root ? x.group : s.users[sh.me()].groups[0], ctx: s.selinux ? policyCtx(s, dest) : undefined }); }
      changed(); return flags.some((f) => /v/.test(f)) ? Object.keys(n.archive.entries).join('\n') : '';
    }
    case 'gzip': case 'bzip2': case 'xz': case 'gunzip': case 'bunzip2': case 'unxz': {
      const ext = { gzip: '.gz', bzip2: '.bz2', xz: '.xz' }; const un = cmd.startsWith('gun') || cmd.startsWith('bun') || cmd === 'unxz';
      const kind = { gunzip: 'gzip', bunzip2: 'bzip2', unxz: 'xz' }[cmd] || cmd;
      for (const f of args) {
        const p = sh.abs(f); const n = s.fs[p]; if (!n) throw new ShellError(`${cmd}: ${f}: No such file or directory`);
        if (un) { if (!p.endsWith(ext[kind])) throw new ShellError(`${cmd}: ${f}: unknown suffix -- ignored`); s.fs[p.slice(0, -ext[kind].length)] = { ...n, packed: undefined, archive: n.archive ? { ...n.archive, comp: null } : undefined }; delete s.fs[p]; }
        else { s.fs[p + ext[kind]] = { ...n, packed: kind, size: Math.round(nodeSize(n) / 3), archive: n.archive ? { ...n.archive, comp: kind } : undefined }; delete s.fs[p]; }
      }
      changed(); return '';
    }
    case 'file': return args.map((f) => { const n = s.fs[sh.abs(f)]; if (!n) return `${f}: cannot open \`${f}' (No such file or directory)`; if (n.t === 'd') return `${f}: directory`; if (n.t === 'l') return `${f}: symbolic link to ${n.target}`; const c = n.archive?.comp || n.packed; if (c) return `${f}: ${c === 'gzip' ? 'gzip compressed data, from Unix' : c === 'bzip2' ? 'bzip2 compressed data, block size = 900k' : 'XZ compressed data, checksum CRC64'}`; if (n.archive) return `${f}: POSIX tar archive (GNU)`; return `${f}: ${/^#!/.test(n.content || '') ? 'Bourne-Again shell script, ASCII text executable' : (n.content || '') ? 'ASCII text' : 'empty'}`; }).join('\n');
    case 'ln': {
      const sym = flags.some((f) => /s/.test(f)); const force = flags.some((f) => /f/.test(f)); const [target, link0] = args;
      if (!target) throw new ShellError('ln: missing file operand');
      let link = sh.abs(link0 || target.split('/').pop()); if (s.fs[link]?.t === 'd' && link0) link = `${link}/${target.split('/').pop()}`;
      if (s.fs[link] && !force) throw new ShellError(`ln: failed to create ${sym ? 'symbolic ' : 'hard '}link '${link0 || link}': File exists`);
      if (!sh.can(s.fs[parentOf(link)] || { mode: '000' }, 2)) throw new ShellError(`ln: failed to create ${sym ? 'symbolic ' : 'hard '}link '${link0}': Permission denied`);
      if (sym) s.fs[link] = { t: 'l', target, mode: '777', owner: sh.me(), group: s.users[sh.me()].groups[0], ctx: s.selinux ? s.fs[parentOf(link)]?.ctx : undefined };
      else { const src = s.fs[sh.abs(target)]; if (!src) throw new ShellError(`ln: failed to access '${target}': No such file or directory`); if (src.t === 'd') throw new ShellError(`ln: ${target}: hard link not allowed for directory`); src.links = (src.links || 1) + 1; s.fs[link] = { ...src, hardOf: sh.abs(target) }; }
      changed(); return '';
    }
    case 'readlink': case 'realpath': { const p = sh.abs(args[0] || ''); const n = s.fs[p]; if (cmd === 'readlink' && !flags.length) return n?.t === 'l' ? n.target : ''; return sh.follow(p); }
    case 'du': {
      const sum = flags.some((f) => /s/.test(f)); const h = flags.some((f) => /h/.test(f)); const depthArg = (a.find((x) => x.startsWith('--max-depth=')) || '').slice(12) || (a.indexOf('-d') >= 0 ? a[a.indexOf('-d') + 1] : null);
      const fmt = (b) => (h ? human(b) : String(Math.ceil(b / 1024)));
      const total = (p) => Object.keys(s.fs).filter((k) => k === p || k.startsWith(`${p === '/' ? '' : p}/`)).reduce((n, k) => n + nodeSize(s.fs[k]), 0);
      const out = [];
      for (const p0 of args.length ? args.filter((x) => x !== depthArg) : ['.']) {
        const p = sh.abs(p0); if (!s.fs[p]) throw new ShellError(`du: cannot access '${p0}': No such file or directory`);
        if (!sh.can(s.fs[p], 4) && s.fs[p].t === 'd') { out.push(`du: cannot read directory '${p0}': Permission denied`); continue; }
        if (!sum && depthArg != null && s.fs[p].t === 'd') for (const k of Object.keys(s.fs).filter((k) => parentOf(k) === p && k !== p && s.fs[k].t === 'd').sort()) out.push(`${fmt(total(k))}\t${k}`);
        out.push(`${fmt(total(p))}\t${p0}`);
      }
      return out.join('\n');
    }
    case 'truncate': {
      const sz = a.indexOf('-s') >= 0 ? a[a.indexOf('-s') + 1] : null; const fs0 = args.filter((x) => x !== sz);
      if (sz !== '0') throw new ShellError('truncate: this lab supports truncate -s 0 FILE');
      for (const f of fs0) { const n = s.fs[sh.abs(f)]; if (!n) throw new ShellError(`truncate: cannot open '${f}' for writing: No such file or directory`); if (!sh.can(n, 2)) throw new ShellError(`truncate: cannot open '${f}' for writing: Permission denied`); n.content = ''; n.size = 0; }
      changed(); return '';
    }
    case 'setfacl': {
      const rm = a.indexOf('-x'); const m = a.indexOf('-m'); const spec = m >= 0 ? a[m + 1] : rm >= 0 ? a[rm + 1] : null; const rec = flags.includes('-R');
      const targets = args.filter((x) => x !== spec); if (!spec || !targets.length) throw new ShellError('Usage: setfacl -m u:USER:rwx FILE   (or -x u:USER FILE)');
      const [kind, who, perm] = spec.split(':'); const key = `${kind.startsWith('g') ? 'g' : 'u'}:${who}`;
      if (kind.startsWith('u') && !s.users[who]) throw new ShellError(`setfacl: Option -m: Invalid argument near character 3`);
      if (kind.startsWith('g') && !s.groups[who]) throw new ShellError(`setfacl: Option -m: Invalid argument near character 3`);
      for (const f of targets) {
        const p = sh.abs(f); const n = s.fs[p]; if (!n) throw new ShellError(`setfacl: ${f}: No such file or directory`);
        if (!sh.root && n.owner !== sh.me()) throw new ShellError(`setfacl: ${f}: Operation not permitted`);
        for (const k of Object.keys(s.fs).filter((k) => k === p || (rec && k.startsWith(`${p}/`)))) { const x = s.fs[k]; x.acl ||= {}; if (m >= 0) x.acl[key] = (perm || '').replace(/[^rwx-]/g, '').padEnd(3, '-').replace(/^([rwx-]{0,3}).*/, (q) => { const set = new Set(q); return `${set.has('r') ? 'r' : '-'}${set.has('w') ? 'w' : '-'}${set.has('x') ? 'x' : '-'}`; }); else delete x.acl[key]; }
      }
      changed(); return '';
    }
    case 'getfacl': return args.map((f) => { const n = s.fs[sh.abs(f)]; if (!n) return `getfacl: ${f}: No such file or directory`; const p = (d) => `${+d & 4 ? 'r' : '-'}${+d & 2 ? 'w' : '-'}${+d & 1 ? 'x' : '-'}`;
      return `# file: ${sh.abs(f).slice(1)}\n# owner: ${n.owner}\n# group: ${n.group}\nuser::${p(n.mode[0])}\n${Object.entries(n.acl || {}).filter(([k]) => k.startsWith('u:')).map(([k, v]) => `user:${k.slice(2)}:${v}`).join('\n')}${Object.keys(n.acl || {}).some((k) => k.startsWith('u:')) ? '\n' : ''}group::${p(n.mode[1])}\n${Object.entries(n.acl || {}).filter(([k]) => k.startsWith('g:')).map(([k, v]) => `group:${k.slice(2)}:${v}\n`).join('')}${n.acl && Object.keys(n.acl).length ? 'mask::rwx\n' : ''}other::${p(n.mode[2])}`; }).join('\n\n');
    default: return undefined;
  }
}

// ── Reboot: only persistent configuration survives ──────────────────────────
export function reboot(sh) {
  const s = sh.s; s.boots = (s.boots || 0) + 1; sh.rootShell = false; sh.root = false;
  s.hostname = (s.fs['/etc/hostname']?.content || s.hostname).trim() || s.hostname;
  for (const [n, x] of Object.entries(s.services)) { x.active = !!x.enabled && !x.masked; x.failed = false; if (x.active) { const err = webStart(s, n) || reqFail(s, n); if (err) { x.active = false; x.failed = true; } } }
  for (const t of Object.values(s.timers)) t.active = !!t.enabled;
  if (s.fw) { s.fw.running = !!s.services.firewalld?.active; s.fw.runtime = JSON.parse(JSON.stringify(s.fw.permanent)); }
  if (s.selinux) { const cfg = (s.fs['/etc/selinux/config']?.content.match(/^SELINUX=(\w+)/m) || [])[1] || 'enforcing'; s.selinux.mode = cfg; for (const b of Object.values(s.selinux.bools)) b.cur = b.perm; }
  if (s.nm) { s.ipDown = false; const c = Object.values(s.nm.cons).find((x) => x.dev === 'eth0' && x.autoconnect !== 'no'); if (c) applyCon(s, c); }
  s.bootArgs = s.kernelArgs.join(' '); s.chrony.sources = chronySources(s); s.atJobs = s.atJobs.filter(() => true);
  bootStorage(sh);
  s.cwd = s.users[s.user]?.home || `/home/${s.user}`;
  const os = s.distro === 'rhel' ? 'Red Hat Enterprise Linux 10.0 (Coughlan)\nKernel 6.12.0-55.el10.x86_64 on x86_64' : 'Ubuntu 24.04.1 LTS';
  sh.opts.onChange?.();
  if (s.emergency) { sh.rootShell = true; return `Rebooting...\n\n[  OK  ] Reached target Local File Systems (Pre).\n[FAILED] Failed to mount ${s.emergency.split(' ')[1] || 'a file system'}.\n[DEPEND] Dependency failed for Local File Systems.\n\nYou are in emergency mode. After logging in, type "journalctl -xb" to view\nsystem logs, "systemctl reboot" to reboot, or "exit" to continue bootup.\n\nProblem in /etc/fstab: ${s.emergency}\nFix /etc/fstab, then run: systemctl reboot\n\nGive root password for maintenance\n(or press Control-D to continue): \n[root@${s.hostname.split('.')[0]} ~]# (emergency shell)`; }
  return `Rebooting...\n\n${os}\n\n${s.hostname} login: ${s.user}\nLast login: Thu Oct 29 10:51:02 2026 from 172.25.250.250\n(The system restarted. Settings that weren't saved persistently are gone.)`;
}

// ── State queries used by lab checks ({lq: [device, query, arg]}) ───────────
export function linuxQuery(s, q, arg) {
  switch (q) {
    case 'http': return httpGet(s, arg, 'remote').code;
    case 'httpLocal': return httpGet(s, arg, 'local').code;
    case 'httpBody': return httpGet(s, arg, 'remote').body || '';
    case 'resolve': return resolveName(s, arg);
    case 'ping': return reachable(s, resolveName(s, arg) || arg);
    case 'canSudo': return canSudo(s, arg);
    case 'ctx': return ctxOf(s, arg);
    case 'mountSrc': { const m = s.mounts.find((x) => x.dir === arg); return m ? canon(m.src) : null; }
    case 'mountType': return s.mounts.find((x) => x.dir === arg)?.type || null;
    case 'fstabMounts': { const t = s.fs['/etc/fstab']?.content || ''; return t.split('\n').some((l) => !/^\s*#/.test(l) && l.split(/\s+/)[1] === arg); }
    case 'fstabSpec': { const l = (s.fs['/etc/fstab']?.content || '').split('\n').find((x) => !/^\s*#/.test(x) && x.split(/\s+/)[1] === arg); return l ? l.trim().split(/\s+/)[0] : null; }
    case 'lvSize': { const [vg, lv] = arg.split('/'); return s.vgs[vg]?.lvs[lv]?.size ?? null; }
    case 'fsSize': { const m = s.mounts.find((x) => x.dir === arg); return m ? s.blk[canon(m.src)]?.fsSize ?? null : null; }
    case 'devFs': return s.blk[canon(arg)]?.fs || null;
    case 'swapMiB': return s.swaps.reduce((n, d) => n + (s.blk[d]?.fsSize || 0), 0);
    case 'swapOn': return s.swaps.includes(canon(resolveSpec(s, arg) || arg));
    case 'cron': return s.crontabs[arg] || '';
    case 'userHasGroup': { const [u, g] = arg.split(':'); return !!s.users[u]?.groups.includes(g); }
    case 'shell': return s.users[arg]?.shell || null;
    case 'emergency': return !!s.emergency;
    case 'portType': return Object.entries(s.selinux?.ports || {}).find(([, ps]) => ps.includes(String(arg)))?.[0] || null;
    case 'fwOpen': { const fw = s.fw; if (!fw) return false; const [where, item] = arg.split(':'); const z = fw[where]; return z.services.includes(item) || z.ports.includes(item); }
    case 'repos': return repos(s).filter((r) => repoOk(s, r)).length;
    case 'policyCtx': return policyCtx(s, arg);
    case 'sshLogin': return (s.sshLogins || []).includes(arg);
    case 'archiveComp': { const n = s.fs[arg]; return n?.archive ? n.archive.comp || 'none' : null; }
    case 'archiveHas': { const [f, entry] = arg.split('::'); return Object.keys(s.fs[f]?.archive?.entries || {}).some((k) => k === entry || k.startsWith(`${entry}/`)); }
    case 'size': { const n = s.fs[arg]; return n ? n.size ?? (n.content || '').length : null; }
    case 'proc': return s.procs.some((p) => p.cmd.includes(arg));
    case 'procNice': return s.procs.find((p) => p.cmd.includes(arg))?.nice ?? 0;
    case 'rootUse': { const m = s.mounts.find((x) => x.dir === '/'); const total = s.blk[m.src]?.fsSize || 1; return Math.round((rootUsed(s) / total) * 100); }
    default: return null;
  }
}

// Dispatch for commands the core shell doesn't handle itself.
export function admin(sh, cmd, a, input) {
  if (cmd === 'systemctl') return systemctl(sh, a);
  if (cmd === 'journalctl') return journalctl(sh, a);
  if (cmd === 'reboot' || cmd === 'shutdown' && a.includes('-r')) { if (!sh.root) throw new ShellError('Call to Reboot failed: Access denied (try sudo)'); return reboot(sh); }
  if (cmd === 'grubby') {
    if (a.some((x) => x.startsWith('--info'))) return `index=0\nkernel="/boot/vmlinuz-6.12.0-55.el10.x86_64"\nargs="${sh.s.kernelArgs.join(' ')}"\nroot="UUID=${sh.s.blk['/dev/vda2'].uuid}"`;
    if (a.includes('--default-kernel')) return '/boot/vmlinuz-6.12.0-55.el10.x86_64';
    if (!sh.root) throw new ShellError('grubby: Permission denied (try sudo)');
    const add = (a.find((x) => x.startsWith('--args=')) || '').slice(7); const rm = (a.find((x) => x.startsWith('--remove-args=')) || '').slice(14);
    if (!add && !rm) throw new ShellError('grubby: use --update-kernel=ALL --args="ARG" or --remove-args="ARG"');
    for (const x of add.split(/\s+/).filter(Boolean)) { const k = x.split('=')[0]; sh.s.kernelArgs = sh.s.kernelArgs.filter((y) => y.split('=')[0] !== k).concat(x); }
    for (const x of rm.split(/\s+/).filter(Boolean)) sh.s.kernelArgs = sh.s.kernelArgs.filter((y) => y !== x && y.split('=')[0] !== x);
    sh.opts.onChange?.(); return '';
  }
  if (cmd === 'grub2-mkconfig') { if (!sh.root) throw new ShellError('grub2-mkconfig: Permission denied'); const m = (sh.s.fs['/etc/default/grub']?.content || '').match(/GRUB_CMDLINE_LINUX="([^"]*)"/); if (m) sh.s.kernelArgs = m[1].split(/\s+/).filter(Boolean); return 'Generating grub configuration file ...\ndone'; }
  if (cmd === 'uname') return a.includes('-r') ? (sh.s.distro === 'rhel' ? '6.12.0-55.el10.x86_64' : '6.8.0-45-generic') : a.includes('-m') ? 'x86_64' : a.includes('-a') ? `Linux ${sh.s.hostname} ${sh.s.distro === 'rhel' ? '6.12.0-55.el10.x86_64' : '6.8.0-45-generic'} #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux` : 'Linux';
  if (cmd === 'uptime') return ' 10:42:13 up  2:41,  1 user,  load average: 0.08, 0.05, 0.01';
  if (cmd === 'date') return `Thu Oct 29 10:42:13 ${sh.s.tz === 'UTC' ? 'UTC' : 'EDT'} 2026`;
  if (cmd === 'nproc') return '2';
  if (cmd === 'lscpu') return 'Architecture:             x86_64\nCPU(s):                   2\nModel name:               Intel Xeon Processor (Icelake)\nVirtualization features:\n  Hypervisor vendor:      KVM';
  if (cmd === 'which' || cmd === 'type') return a.map((x) => `/usr/bin/${x}`).join('\n');
  if (cmd === 'man') { if (!a.length) throw new ShellError('What manual page do you want?'); if (a[0] === '-k') return `${a[1]} (1)        - (search results are limited in this lab)`; return `${a[a.length - 1].toUpperCase()}(${/^\d$/.test(a[0]) ? a[0] : '1'})  — manual pages aren't installed in this lab. Try '${a[a.length - 1]} --help' or the hints panel.`; }
  for (const fn of [storage, sec]) { const r = fn(sh, cmd, a, input); if (r !== undefined) return r; }
  for (const fn of [users, sched, net, files]) { const r = fn(sh, cmd, a, input); if (r !== undefined) return r; }
  if (['dnf', 'yum', 'rpm', 'flatpak'].includes(cmd)) return packages(sh, cmd, a);
  return undefined;
}

// Security for the Linux lab simulator: SELinux (modes, file contexts, port types, booleans,
// AVC denials), firewalld, and a tiny web server model (httpd/nginx) so labs can test
// "can a browser reach this page?" end to end.
import { ShellError, policyCtx } from './labs-linux-base.js';

const FW_SERVICES = { ssh: ['22/tcp'], http: ['80/tcp'], https: ['443/tcp'], cockpit: ['9090/tcp'], 'dhcpv6-client': ['546/udp'], dns: ['53/tcp', '53/udp'], nfs: ['2049/tcp'], mountd: ['20048/tcp'], 'rpc-bind': ['111/tcp'], samba: ['139/tcp', '445/tcp'], ftp: ['21/tcp'], mysql: ['3306/tcp'], postgresql: ['5432/tcp'], ntp: ['123/udp'], smtp: ['25/tcp'], imaps: ['993/tcp'], ldap: ['389/tcp'], ldaps: ['636/tcp'], 'kerberos': ['88/tcp'], 'squid': ['3128/tcp'], 'redis': ['6379/tcp'] };
const PORT_TYPES = { http_port_t: ['80', '81', '443', '488', '8008', '8009', '8443', '9000'], ssh_port_t: ['22'], mysqld_port_t: ['1186', '3306', '63132-63164'], postgresql_port_t: ['5432', '9898'], smtp_port_t: ['25', '465', '587'] };
export const DEFAULT_BOOLS = { httpd_can_network_connect: false, httpd_can_network_connect_db: false, httpd_enable_homedirs: false, httpd_use_nfs: false, httpd_read_user_content: false, samba_enable_home_dirs: false, use_nfs_home_dirs: false, ftpd_anon_write: false, ssh_sysadm_login: false, virt_use_nfs: false, container_manage_cgroup: false };

export function secState(def) {
  const rhel = def.distro === 'rhel';
  const bools = {}; for (const [k, v] of Object.entries({ ...DEFAULT_BOOLS, ...(def.booleans || {}) })) bools[k] = { cur: !!v, perm: !!v };
  const fw = def.firewalld === false || !rhel ? null : { running: true, zone: 'public', runtime: { services: ['cockpit', 'dhcpv6-client', 'ssh'], ports: [], rich: [] }, ...(def.firewalld || {}) };
  if (fw) fw.permanent = JSON.parse(JSON.stringify(def.firewalld?.permanent || fw.runtime));
  return {
    selinux: rhel ? { mode: def.selinux || 'enforcing', fcontext: [], ports: JSON.parse(JSON.stringify(PORT_TYPES)), bools, avc: [] } : null,
    fw,
  };
}
export const ctxString = (t) => `${/^(user_home|admin_home|httpd_sys_content|var|tmp|default)_t$/.test(t) ? 'unconfined_u' : 'system_u'}:object_r:${t}:s0`;
// Context of an existing node (stored when created; older nodes fall back to policy).
export const ctxOf = (sys, path) => sys.fs[path]?.ctx || policyCtx(sys, path);

// ── Web server model ────────────────────────────────────────────────────────
function webConf(sys) {
  const httpd = sys.fs['/etc/httpd/conf/httpd.conf']?.content;
  const nginx = sys.fs['/etc/nginx/nginx.conf']?.content;
  if (sys.services.httpd && httpd != null) {
    const ports = [...httpd.matchAll(/^\s*Listen\s+(?:[\d.]+:)?(\d+)/gm)].map((m) => m[1]);
    const root = (httpd.match(/^\s*DocumentRoot\s+"?([^"\s]+)"?/m) || [])[1] || '/var/www/html';
    return { svc: 'httpd', ports: ports.length ? ports : ['80'], root };
  }
  if (sys.services.nginx) return { svc: 'nginx', ports: [(nginx?.match(/listen\s+(\d+)/) || [])[1] || '80'], root: (nginx?.match(/root\s+([^;\s]+)/) || [])[1] || '/var/www/html' };
  return null;
}
const portIn = (list, p) => (list || []).some((x) => (x.includes('-') ? +p >= +x.split('-')[0] && +p <= +x.split('-')[1] : x === String(p)));
export function webPorts(sys) { const w = webConf(sys); return w ? w.ports : []; }
// Called when a web service starts; returns an error message or ''.
export function webStart(sys, name) {
  const w = webConf(sys); if (!w || w.svc !== name) return '';
  if (sys.selinux?.mode === 'enforcing') {
    const bad = w.ports.find((p) => !portIn(sys.selinux.ports.http_port_t, p));
    if (bad) {
      sys.selinux.avc.push(`type=AVC msg=audit(1793291412.204:${310 + sys.selinux.avc.length}): avc:  denied  { name_bind } for  pid=2741 comm="httpd" src=${bad} scontext=system_u:system_r:httpd_t:s0 tcontext=system_u:object_r:unreserved_port_t:s0 tclass=tcp_socket permissive=0`);
      sys.journal.push({ unit: 'httpd', prio: 3, msg: `(13)Permission denied: AH00072: make_sock: could not bind to address [::]:${bad}` }, { unit: 'httpd', prio: 3, msg: 'no listening sockets available, shutting down' });
      return `Job for httpd.service failed because the control process exited with error code.\nSee "systemctl status httpd.service" and "journalctl -xeu httpd.service" for details.`;
    }
  }
  return '';
}
// GET a URL as seen from this host ("local") or from another machine on the network ("remote").
export function httpGet(sys, url, from = 'local') {
  const m = String(url).match(/^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/); if (!m) return { code: 0, err: 'curl: (3) URL rejected: Bad hostname' };
  const [, host, portS, pathS] = m; const port = portS || (/^https/.test(url) ? '443' : '80'); const path = decodeURI(pathS || '/');
  const self = ['localhost', '127.0.0.1', sys.hostname, sys.hostname.split('.')[0], sys.ip].includes(host);
  if (!self && from === 'local') return { code: 0, err: `curl: (7) Failed to connect to ${host} port ${port}: Couldn't connect to server` };
  const w = webConf(sys); const svc = w && sys.services[w.svc];
  if (!w || !svc?.active || !w.ports.includes(port)) return { code: 0, err: `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection refused` };
  if (from === 'remote' && sys.fw?.running) {
    const open = sys.fw.runtime.ports.includes(`${port}/tcp`) || sys.fw.runtime.services.some((s) => (FW_SERVICES[s] || []).includes(`${port}/tcp`));
    if (!open) return { code: 0, err: `curl: (7) Failed to connect to ${host} port ${port}: No route to host` };
  }
  const file = `${w.root}${path.endsWith('/') ? `${path}index.html` : path}`.replace(/\/+/g, '/');
  const n = sys.fs[file];
  if (!n || n.t !== 'f') return { code: 404, body: '<!doctype html><title>404 Not Found</title><h1>Not Found</h1>' };
  const forbidden = { code: 403, body: '<!doctype html><title>403 Forbidden</title><h1>Forbidden</h1><p>You don\'t have permission to access this resource.</p>' };
  // apache/nginx run as their own user: they need "other" read on the file and execute on each parent.
  const other = (node, bit) => !!(Number(node.mode[2]) & bit) || node.owner === 'apache' || node.owner === 'nginx';
  let dir = file; while ((dir = dir.slice(0, dir.lastIndexOf('/')) || '/') !== '/') { const d = sys.fs[dir]; if (d && !other(d, 1)) return forbidden; }
  if (!other(n, 4)) return forbidden;
  if (sys.selinux?.mode === 'enforcing' && w.svc === 'httpd') {
    const t = ctxOf(sys, file);
    if (!/^(httpd_sys_content_t|httpd_sys_rw_content_t|public_content_t|public_content_rw_t)$/.test(t) && !(t === 'user_home_t' && sys.selinux.bools.httpd_enable_homedirs?.cur)) {
      sys.selinux.avc.push(`type=AVC msg=audit(1793291530.811:${310 + sys.selinux.avc.length}): avc:  denied  { read } for  pid=2850 comm="httpd" name="${file.split('/').pop()}" dev="vda2" ino=1311 scontext=system_u:system_r:httpd_t:s0 tcontext=${ctxString(t)} tclass=file permissive=0`);
      return forbidden;
    }
  }
  return { code: 200, body: n.content };
}

// ── Commands ────────────────────────────────────────────────────────────────
export function sec(sh, cmd, a) {
  const s = sh.s; const se = s.selinux; const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x));
  const changed = () => sh.opts.onChange?.();
  const root = (what) => { if (!sh.root) throw new ShellError(`${what}: Permission denied (you must be root; try sudo)`); };
  const noSe = () => { if (!se) throw new ShellError(`${cmd}: command not found`); };
  const optVal = (...names) => { for (const n of names) { const i = a.indexOf(n); if (i >= 0) return a[i + 1]; const eq = a.find((x) => x.startsWith(`${n}=`)); if (eq) return eq.slice(n.length + 1); } return null; };
  switch (cmd) {
    case 'getenforce': noSe(); return se.mode[0].toUpperCase() + se.mode.slice(1);
    case 'setenforce': {
      noSe(); root('setenforce'); const v = String(args[0] || '').toLowerCase();
      if (se.mode === 'disabled') throw new ShellError('setenforce: SELinux is disabled');
      if (['1', 'enforcing'].includes(v)) se.mode = 'enforcing'; else if (['0', 'permissive'].includes(v)) se.mode = 'permissive'; else throw new ShellError('usage:  setenforce [ Enforcing | Permissive | 1 | 0 ]');
      changed(); return '';
    }
    case 'sestatus': {
      noSe(); const cfg = (s.fs['/etc/selinux/config']?.content.match(/^SELINUX=(\w+)/m) || [])[1] || 'enforcing';
      return `SELinux status:                 ${se.mode === 'disabled' ? 'disabled' : 'enabled'}\nSELinuxfs mount:                /sys/fs/selinux\nLoaded policy name:             targeted\nCurrent mode:                   ${se.mode}\nMode from config file:          ${cfg}\nPolicy MLS status:              enabled\nMax kernel policy version:      33`;
    }
    case 'semanage': {
      noSe(); const sub = args[0];
      if (sub === 'fcontext') {
        if (flags.includes('-l') || a.includes('--list')) return se.fcontext.map((r) => `${r.spec.padEnd(40)} all files          system_u:object_r:${r.type}:s0`).join('\n') || 'SELinux fcontext                                   type               Context';
        root('semanage'); const t = optVal('-t', '--type'); const spec = args.filter((x) => x !== 'fcontext' && x !== t).pop();
        if (flags.includes('-d') || a.includes('--delete')) { se.fcontext = se.fcontext.filter((r) => r.spec !== spec); changed(); return ''; }
        if (!(flags.includes('-a') || a.includes('--add') || flags.includes('-m'))) throw new ShellError('usage: semanage fcontext -a -t TYPE \'/path(/.*)?\'');
        if (!t || !/_t$/.test(t)) throw new ShellError('ValueError: SELinux type is required (-t TYPE)');
        if (!spec || !spec.startsWith('/')) throw new ShellError('ValueError: File spec must begin with /');
        try { new RegExp(`^${spec}$`); } catch { throw new ShellError(`ValueError: File spec ${spec} is not a valid regular expression`); }
        se.fcontext = se.fcontext.filter((r) => r.spec !== spec).concat({ spec, type: t }); changed(); return '';
      }
      if (sub === 'port') {
        if (flags.includes('-l') || a.includes('--list')) return Object.entries(se.ports).map(([t, ps]) => `${t.padEnd(28)} tcp      ${ps.join(', ')}`).join('\n');
        root('semanage'); const t = optVal('-t', '--type'); const proto = optVal('-p', '--proto') || 'tcp'; const port = args.filter((x) => x !== 'port' && x !== t && x !== proto).pop();
        if (!/^\d+(-\d+)?$/.test(port || '')) throw new ShellError('ValueError: Invalid Port');
        if (flags.includes('-d')) { if (se.ports[t]) se.ports[t] = se.ports[t].filter((x) => x !== port); changed(); return ''; }
        if (!t || !/_t$/.test(t)) throw new ShellError('ValueError: Type is required (-t TYPE)');
        const owner = Object.entries(se.ports).find(([, ps]) => ps.includes(port));
        if (owner && !flags.includes('-m')) { if (owner[0] === t) throw new ShellError(`ValueError: Port ${proto}/${port} already defined`); throw new ShellError(`ValueError: Port ${proto}/${port} already defined (as ${owner[0]}); use -m to modify it`); }
        if (owner) se.ports[owner[0]] = owner[1].filter((x) => x !== port);
        (se.ports[t] ||= []).push(port); changed(); return '';
      }
      if (sub === 'boolean') return Object.entries(se.bools).map(([k, v]) => `${k.padEnd(36)} (${v.cur ? 'on ' : 'off'}  ,  ${v.perm ? 'on ' : 'off'})`).join('\n');
      throw new ShellError('usage: semanage {fcontext|port|boolean} ...');
    }
    case 'restorecon': {
      noSe(); root('restorecon'); const rec = flags.some((f) => /R|r/.test(f)); const v = flags.some((f) => /v/.test(f));
      if (!args.length) throw new ShellError('usage:  restorecon [-RvF] pathname...');
      const out = [];
      for (const p0 of args) {
        const p = sh.abs(p0); if (!s.fs[p]) throw new ShellError(`restorecon: lstat(${p0}) failed: No such file or directory`);
        const targets = Object.keys(s.fs).filter((k) => k === p || (rec && k.startsWith(`${p === '/' ? '' : p}/`))).sort();
        for (const k of targets) { const want = policyCtx(s, k); const had = ctxOf(s, k); if (had !== want) { s.fs[k].ctx = want; if (v) out.push(`Relabeled ${k} from ${ctxString(had)} to ${ctxString(want)}`); } else s.fs[k].ctx = want; }
      }
      changed(); return out.join('\n');
    }
    case 'chcon': {
      noSe(); root('chcon'); const t = optVal('-t', '--type'); const rec = flags.includes('-R'); const paths = args.filter((x) => x !== t);
      if (!t) throw new ShellError('chcon: use chcon -t TYPE FILE (temporary; restorecon resets it)');
      for (const p0 of paths) { const p = sh.abs(p0); if (!s.fs[p]) throw new ShellError(`chcon: cannot access '${p0}': No such file or directory`); for (const k of Object.keys(s.fs)) if (k === p || (rec && k.startsWith(`${p}/`))) s.fs[k].ctx = t; }
      changed(); return '';
    }
    case 'getsebool': {
      noSe(); if (flags.includes('-a') || !args.length) return Object.entries(se.bools).map(([k, v]) => `${k} --> ${v.cur ? 'on' : 'off'}`).join('\n');
      return args.map((k) => { if (!se.bools[k]) throw new ShellError(`Error getting active value for ${k}`); return `${k} --> ${se.bools[k].cur ? 'on' : 'off'}`; }).join('\n');
    }
    case 'setsebool': {
      noSe(); root('setsebool'); const P = flags.includes('-P'); const [k, v] = args;
      if (!se.bools[k]) throw new ShellError(`Boolean ${k} is not defined`);
      const on = ['1', 'on', 'true'].includes(String(v).toLowerCase()); if (!['0', '1', 'on', 'off', 'true', 'false'].includes(String(v).toLowerCase())) throw new ShellError('usage:  setsebool [ -NPV ] boolean value');
      se.bools[k].cur = on; if (P) se.bools[k].perm = on; changed(); return '';
    }
    case 'ausearch': noSe(); root('ausearch'); return se.avc.length ? se.avc.map((x) => `----\ntime->Thu Oct 29 10:${String(10 + se.avc.indexOf(x)).padStart(2, '0')}:12 2026\n${x}`).join('\n') : '<no matches>';
    case 'sealert': noSe(); return se.avc.length ? `SELinux is preventing httpd from access. Check the type of the files or port involved:\n  * Files: semanage fcontext -a -t httpd_sys_content_t '/path(/.*)?' then restorecon -Rv /path\n  * Ports: semanage port -a -t http_port_t -p tcp PORT` : 'No alerts';
    case 'firewall-cmd': {
      const fw = s.fw; if (!fw) throw new ShellError('firewall-cmd: command not found');
      if (a.includes('--state')) return fw.running ? 'running' : 'not running';
      if (!fw.running) throw new ShellError('FirewallD is not running');
      const perm = a.includes('--permanent'); const z = perm ? fw.permanent : fw.runtime;
      if (a.includes('--get-default-zone')) return fw.zone;
      if (a.includes('--get-active-zones')) return `${fw.zone}\n  interfaces: eth0`;
      if (a.includes('--get-services')) return Object.keys(FW_SERVICES).sort().join(' ');
      if (a.includes('--list-services')) return z.services.join(' ');
      if (a.includes('--list-ports')) return z.ports.join(' ');
      if (a.includes('--list-rich-rules')) return z.rich.join('\n');
      if (a.includes('--list-all')) return `${fw.zone} (active)\n  target: default\n  icmp-block-inversion: no\n  interfaces: eth0\n  sources: \n  services: ${z.services.join(' ')}\n  ports: ${z.ports.join(' ')}\n  protocols: \n  forward: yes\n  masquerade: no\n  forward-ports: \n  source-ports: \n  icmp-blocks: \n  rich rules: ${z.rich.map((r) => `\n\t${r}`).join('')}`;
      root('firewall-cmd');
      if (a.includes('--reload')) { fw.runtime = JSON.parse(JSON.stringify(fw.permanent)); changed(); return 'success'; }
      if (a.includes('--runtime-to-permanent')) { fw.permanent = JSON.parse(JSON.stringify(fw.runtime)); changed(); return 'success'; }
      const ops = []; for (let i = 0; i < a.length; i++) { const m = a[i].match(/^--(add|remove)-(service|port|rich-rule)(?:=(.*))?$/); if (m) ops.push([m[1], m[2], m[3] ?? a[++i]]); }
      if (!ops.length) throw new ShellError('usage: see firewall-cmd --help (for example: firewall-cmd --permanent --add-service=http)');
      const out = [];
      for (const [op, kind, v0] of ops) {
        const v = String(v0 || '').replace(/^['"]|['"]$/g, '');
        if (kind === 'service') {
          if (!FW_SERVICES[v]) throw new ShellError(`Error: INVALID_SERVICE: '${v}' not among existing services`);
          if (op === 'add') { if (z.services.includes(v)) out.push(`Warning: ALREADY_ENABLED: ${v}`); else z.services.push(v); } else z.services = z.services.filter((x) => x !== v);
        } else if (kind === 'port') {
          if (!/^\d+(-\d+)?\/(tcp|udp|sctp)$/.test(v)) throw new ShellError(`Error: INVALID_PORT: ${v} (use PORT/tcp, for example 82/tcp)`);
          if (op === 'add') { if (z.ports.includes(v)) out.push(`Warning: ALREADY_ENABLED: ${v}`); else z.ports.push(v); } else z.ports = z.ports.filter((x) => x !== v);
        } else {
          if (!/^rule\s/.test(v)) throw new ShellError(`Error: INVALID_RULE: ${v}`);
          if (op === 'add') z.rich.push(v); else z.rich = z.rich.filter((x) => x !== v);
        }
      }
      changed(); return [...out, 'success'].join('\n');
    }
    default: return undefined;
  }
}

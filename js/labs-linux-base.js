// Shared pieces for the Linux lab simulator: the error type, size parsing and formatting,
// and the SELinux file-context policy (built-in rules plus semanage fcontext rules).

export class ShellError extends Error {}

// "2G", "500M", "2GiB", "1.5G", "100%" → MiB. Plain numbers are MiB for LVM-style sizes.
export function parseSize(s, def = 'M') {
  const m = String(s).trim().match(/^\+?(\d+(?:\.\d+)?)\s*([KMGT]?)(i?B)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]); const u = (m[2] || def).toUpperCase();
  const mib = { K: n / 1024, M: n, G: n * 1024, T: n * 1024 * 1024 }[u];
  return Math.round(mib);
}
export function fmtSize(mib) {
  if (mib >= 1024 * 1024) return `${+(mib / 1024 / 1024).toFixed(1)}T`;
  if (mib >= 1024) return `${+(mib / 1024).toFixed(1)}G`;
  return `${mib}M`;
}
// Stable, readable UUIDs so the same lab shows the same values each time.
export function makeUuid(seed) {
  let h = 2166136261; for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  const a = hex(h); const b = hex(Math.imul(h, 2654435761)); const c = hex(Math.imul(h ^ 0x5bd1e995, 40503)); const d = hex(Math.imul(h, 97));
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-a${c.slice(1, 4)}-${c.slice(4)}${d}`;
}

// SELinux default file contexts (simplified targeted policy). Local rules from
// "semanage fcontext -a" are checked first, newest first.
const BUILTIN_FC = [
  ['/var/www(/.*)?', 'httpd_sys_content_t'],
  ['/var/log(/.*)?', 'var_log_t'],
  ['/etc/shadow', 'shadow_t'],
  ['/etc(/.*)?', 'etc_t'],
  ['/root(/.*)?', 'admin_home_t'],
  ['/home/[^/]+(/.*)?', 'user_home_t'],
  ['/home', 'home_root_t'],
  ['/tmp(/.*)?', 'tmp_t'],
  ['/srv(/.*)?', 'var_t'],
  ['/var(/.*)?', 'var_t'],
  ['/usr/bin(/.*)?', 'bin_t'],
  ['/usr/local/bin(/.*)?', 'bin_t'],
  ['/usr(/.*)?', 'usr_t'],
  ['/mnt(/.*)?', 'mnt_t'],
];
export function policyCtx(sys, path) {
  for (const r of [...(sys.selinux?.fcontext || [])].reverse()) if (new RegExp(`^${r.spec}$`).test(path)) return r.type;
  for (const [re, t] of BUILTIN_FC) if (new RegExp(`^${re}$`).test(path)) return t;
  return 'default_t';
}
export const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

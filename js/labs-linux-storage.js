// Storage for the Linux lab simulator: disks and GPT partitions (parted), LVM (pv/vg/lv),
// file systems (mkfs, labels, UUIDs, growing), mounts and /etc/fstab, swap, and NFS mounts.
// Sizes are whole MiB.
import { ShellError, parseSize, fmtSize, makeUuid } from './labs-linux-base.js';

export function storageState(def) {
  const disks = { vda: { size: 20480, label: 'gpt', parts: { vda1: { start: 1, end: 1025, size: 1024 }, vda2: { start: 1025, end: 20479, size: 19454 } } } };
  for (const [n, d] of Object.entries(def.disks || {})) disks[n] = { size: parseSize(d.size ?? d, 'G') ?? 1024, label: d.label || null, parts: {} };
  const blk = {
    '/dev/vda1': { fs: 'xfs', uuid: makeUuid('boot'), fsSize: 1024 },
    '/dev/vda2': { fs: 'xfs', uuid: makeUuid('root'), fsSize: 19454 },
  };
  return {
    disks, blk, pvs: {}, vgs: {}, swaps: [], nfs: def.nfs || {}, emergency: null,
    mounts: [{ src: '/dev/vda2', dir: '/', type: 'xfs' }, { src: '/dev/vda1', dir: '/boot', type: 'xfs' }],
  };
}
export function defaultFstab(s) {
  return [
    '#',
    '# /etc/fstab',
    "# Accessible filesystems, by reference, are maintained under '/dev/disk/'.",
    '#',
    `UUID=${s.blk['/dev/vda2'].uuid} /                       xfs     defaults        0 0`,
    `UUID=${s.blk['/dev/vda1'].uuid} /boot                   xfs     defaults        0 0`,
    '',
  ].join('\n');
}

// Normalize device names: /dev/mapper/vg-lv → /dev/vg/lv.
export function canon(dev) {
  const m = String(dev).match(/^\/dev\/mapper\/([^-]+)-(.+)$/);
  return m ? `/dev/${m[1]}/${m[2]}` : String(dev);
}
function devInfo(s, path) {
  const p = canon(path); const m = p.match(/^\/dev\/([a-z]+\d*n?\d*?)$/);
  if (s.disks[p.slice(5)]) return { kind: 'disk', size: s.disks[p.slice(5)].size, name: p.slice(5) };
  for (const [dn, d] of Object.entries(s.disks)) if (d.parts[p.slice(5)]) return { kind: 'part', size: d.parts[p.slice(5)].size, disk: dn };
  const lv = p.match(/^\/dev\/([^/]+)\/([^/]+)$/);
  if (lv && s.vgs[lv[1]]?.lvs[lv[2]]) return { kind: 'lv', size: s.vgs[lv[1]].lvs[lv[2]].size, vg: lv[1], lv: lv[2] };
  return m ? null : null;
}
const partName = (disk, n) => `${disk}${/\d$/.test(disk) ? 'p' : ''}${n}`;
// Resolve an fstab/mount source to a device path (or an NFS source).
export function resolveSpec(s, spec) {
  if (/^UUID=/i.test(spec)) { const u = spec.slice(5).replace(/"/g, ''); return Object.keys(s.blk).find((d) => s.blk[d].uuid === u) || null; }
  if (/^LABEL=/i.test(spec)) { const l = spec.slice(6).replace(/"/g, ''); return Object.keys(s.blk).find((d) => s.blk[d].label === l) || null; }
  if (/^[\w.-]+:\//.test(spec)) return s.nfs[spec] ? spec : null;
  const c = canon(spec); return devInfo(s, c) ? c : null;
}
const isMounted = (s, dev) => s.mounts.some((m) => canon(m.src) === canon(dev));
const inUse = (s, dev) => isMounted(s, dev) || s.swaps.includes(canon(dev)) || s.pvs[canon(dev)];
function lvFree(vg) { const used = Object.values(vg.lvs).reduce((n, l) => n + l.size, 0); return vg.size - used; }
function vgSize(s, vg) { return vg.pvs.reduce((n, p) => n + Math.floor((devInfo(s, p)?.size ?? 0) / vg.pe) * vg.pe, 0); }

// Parse /etc/fstab into entries.
export function fstabEntries(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [spec, dir, type, opts = 'defaults'] = l.split(/\s+/); return { spec, dir, type, opts, line: l }; });
}
// Mount one fstab entry; returns an error string or ''.
function mountEntry(sh, e) {
  const s = sh.s;
  if (!e.dir || !e.type) return `mount: ${e.line}: parse error`;
  if (e.type === 'swap') {
    const d = resolveSpec(s, e.spec); if (!d || s.blk[d]?.fs !== 'swap') return `swapon: ${e.spec}: not a swap device`;
    if (!s.swaps.includes(d)) s.swaps.push(d); return '';
  }
  if (s.mounts.some((m) => m.dir === e.dir)) return '';
  const d = resolveSpec(s, e.spec);
  if (!d) return `mount: ${e.dir}: special device ${e.spec} does not exist.`;
  const nfs = /^[\w.-]+:\//.test(d);
  if (!nfs && !s.blk[d]?.fs) return `mount: ${e.dir}: wrong fs type, bad option, bad superblock on ${d}, missing codepage or helper program, or other error.`;
  const want = e.type === 'auto' ? s.blk[d]?.fs : e.type;
  if (!nfs && want !== s.blk[d].fs && !(want === 'vfat' && s.blk[d].fs === 'vfat')) return `mount: ${e.dir}: wrong fs type, bad option, bad superblock on ${d}, missing codepage or helper program, or other error.`;
  if (nfs && !/^nfs4?$/.test(e.type)) return `mount: ${e.dir}: wrong fs type for ${d}.`;
  if (sh.s.fs[e.dir]?.t !== 'd') return `mount: ${e.dir}: mount point does not exist.`;
  s.mounts.push({ src: d, dir: e.dir, type: nfs ? 'nfs4' : s.blk[d].fs, opts: e.opts });
  return '';
}
// At boot: mount / and /boot plus everything in fstab. A bad entry without nofail stops the boot.
export function bootStorage(sh) {
  const s = sh.s; s.mounts = s.mounts.filter((m) => m.dir === '/' || m.dir === '/boot'); s.swaps = []; s.emergency = null;
  for (const e of fstabEntries(sh.s.fs['/etc/fstab']?.content)) {
    if (e.dir === '/' || e.dir === '/boot') continue;
    const err = mountEntry(sh, e);
    if (err && !/\bnofail\b/.test(e.opts)) { s.emergency = `${e.line} — ${err}`; break; }
  }
}

function lsblk(sh, flags) {
  const s = sh.s; const f = flags.some((x) => /f/.test(x));
  const mp = (dev) => s.mounts.filter((m) => canon(m.src) === canon(dev)).map((m) => m.dir).join(',') || (s.swaps.includes(canon(dev)) ? '[SWAP]' : '');
  const row = (pre, name, dev, size, type) => (f
    ? `${(pre + name).padEnd(22)} ${(s.blk[dev]?.fs || '').padEnd(6)} ${(s.blk[dev]?.label || '').padEnd(8)} ${(s.blk[dev]?.uuid || '').padEnd(37)} ${mp(dev)}`
    : `${(pre + name).padEnd(22)} ${fmtSize(size).padStart(6)} ${type.padEnd(5)} ${mp(dev)}`);
  const out = [f ? `${'NAME'.padEnd(22)} FSTYPE LABEL    UUID                                  MOUNTPOINTS` : `${'NAME'.padEnd(22)}   SIZE TYPE  MOUNTPOINTS`];
  const lvRows = (dev, indent) => Object.entries(s.vgs).filter(([, vg]) => vg.pvs.includes(dev)).flatMap(([vn, vg]) => Object.entries(vg.lvs).map(([ln, l]) => row(`${indent}└─`, `${vn}-${ln}`, `/dev/${vn}/${ln}`, l.size, 'lvm')));
  for (const [dn, d] of Object.entries(s.disks)) {
    out.push(row('', dn, `/dev/${dn}`, d.size, 'disk'));
    out.push(...lvRows(`/dev/${dn}`, ''));
    const parts = Object.entries(d.parts);
    parts.forEach(([pn, p], i) => { out.push(row(i === parts.length - 1 ? '└─' : '├─', pn, `/dev/${pn}`, p.size, 'part')); out.push(...lvRows(`/dev/${pn}`, '  ')); });
  }
  return out.join('\n');
}

function parted(sh, a) {
  const s = sh.s; const args = a.filter((x) => x !== '-s' && x !== '--script');
  const dev = args[0]; const name = String(dev || '').replace(/^\/dev\//, ''); const d = s.disks[name];
  if (!dev) throw new ShellError('Usage: parted [-s] DEVICE [COMMAND...]');
  if (!d) throw new ShellError(`Error: Could not stat device ${dev} - No such file or directory.`);
  if (args.length === 1) throw new ShellError("parted: interactive mode isn't available in this lab. Use parted -s DEVICE COMMAND, for example: parted -s /dev/vdb mklabel gpt mkpart data 1MiB 1025MiB");
  const pos = (v) => { if (/%$/.test(v)) return Math.round((d.size * parseFloat(v)) / 100) - (parseFloat(v) >= 100 ? 1 : 0); const n = parseSize(v.replace(/B$/i, '').replace(/i$/, ''), 'M'); return n; };
  const out = []; let i = 1;
  while (i < args.length) {
    const c = args[i++];
    if (c === 'print') {
      out.push(`Model: Virtio Block Device (virtblk)\nDisk ${dev}: ${fmtSize(d.size)}\nPartition Table: ${d.label || 'unknown'}\n\nNumber  Start    End      Size     Name`);
      for (const [pn, p] of Object.entries(d.parts)) out.push(` ${pn.replace(name, '').replace(/^p/, '').padEnd(6)} ${`${p.start}MiB`.padEnd(8)} ${`${p.end}MiB`.padEnd(8)} ${`${p.size}MiB`.padEnd(8)} ${p.name || ''}${p.flags?.length ? `  ${p.flags.join(', ')}` : ''}`);
    } else if (c === 'mklabel') {
      const t = args[i++]; if (!['gpt', 'msdos'].includes(t)) throw new ShellError(`parted: invalid token: ${t}`);
      if (Object.keys(d.parts).some((pn) => inUse(s, `/dev/${pn}`))) throw new ShellError(`Error: Partition(s) on ${dev} are being used.`);
      d.label = t; d.parts = {};
    } else if (c === 'mkpart') {
      if (!d.label) throw new ShellError(`Error: ${dev}: unrecognised disk label`);
      const rest = []; while (i < args.length && !['print', 'mklabel', 'mkpart', 'set', 'rm'].includes(args[i])) rest.push(args[i++]);
      if (rest.length < 2) throw new ShellError('Error: mkpart needs a start and an end, for example: mkpart data 1MiB 1025MiB');
      const start = pos(rest[rest.length - 2]); const end = pos(rest[rest.length - 1]);
      if (start == null || end == null || end <= start) throw new ShellError('Error: Invalid start or end position.');
      if (end > d.size) throw new ShellError(`Error: The location ${rest[rest.length - 1]} is outside of the device ${dev}.`);
      if (Object.values(d.parts).some((p) => start < p.end && end > p.start)) throw new ShellError("Error: You requested a partition that overlaps an existing one. Use parted DEVICE print to see free space.");
      let n = 1; while (d.parts[partName(name, n)]) n++;
      d.parts[partName(name, n)] = { start, end, size: end - start, name: rest.length > 2 ? rest[0] : '', flags: [] };
    } else if (c === 'set') {
      const n = args[i++]; const flag = args[i++]; const on = args[i++];
      const p = d.parts[partName(name, n)]; if (!p) throw new ShellError(`Error: Partition doesn't exist.`);
      p.flags = on === 'on' ? [...new Set([...p.flags, flag])] : p.flags.filter((x) => x !== flag);
    } else if (c === 'rm') {
      const pn = partName(name, args[i++]); if (!d.parts[pn]) throw new ShellError(`Error: Partition doesn't exist.`);
      if (inUse(s, `/dev/${pn}`)) throw new ShellError(`Error: Partition ${pn} is being used. You must unmount it before you modify it with Parted.`);
      delete d.parts[pn]; delete s.blk[`/dev/${pn}`];
    } else throw new ShellError(`parted: invalid token: ${c}`);
  }
  sh.opts.onChange?.(); return out.join('\n');
}

function needRoot(sh, what) { if (!sh.root) throw new ShellError(`${what}: Permission denied (you must be root; try sudo)`); }

export function storage(sh, cmd, a, input) {
  const s = sh.s; const flags = a.filter((x) => /^-/.test(x)); const args = a.filter((x) => !/^-/.test(x));
  const optVal = (...names) => { for (const n of names) { const i = a.indexOf(n); if (i >= 0) return a[i + 1]; const eq = a.find((x) => x.startsWith(`${n}=`)); if (eq) return eq.slice(n.length + 1); const glued = n.length === 2 && a.find((x) => x.startsWith(n) && x.length > 2 && !x.startsWith('--')); if (glued) return glued.slice(2); } return null; };
  const changed = () => sh.opts.onChange?.();
  switch (cmd) {
    case 'lsblk': return lsblk(sh, flags);
    case 'blkid': {
      const list = args.length ? args.map(canon) : Object.keys(s.blk);
      return list.filter((d) => s.blk[d]?.fs).map((d) => `${d}: ${s.blk[d].label ? `LABEL="${s.blk[d].label}" ` : ''}UUID="${s.blk[d].uuid}" TYPE="${s.blk[d].fs}"`).join('\n');
    }
    case 'fdisk': case 'gdisk':
      if (flags.includes('-l')) return Object.entries(s.disks).map(([n, d]) => `Disk /dev/${n}: ${fmtSize(d.size)}\nDisklabel type: ${d.label || '(none)'}`).join('\n\n');
      throw new ShellError(`${cmd}: interactive mode isn't available in this lab. Use parted -s instead, for example: parted -s /dev/vdb mklabel gpt mkpart data 1MiB 1025MiB`);
    case 'parted': needRoot(sh, 'parted'); return parted(sh, a);
    case 'partprobe': case 'udevadm': return '';
    case 'pvcreate': {
      needRoot(sh, 'pvcreate'); if (!args.length) throw new ShellError('Please enter a physical volume path.');
      for (const d of args.map(canon)) {
        const i = devInfo(s, d); if (!i) throw new ShellError(`  No device found for ${d}.`);
        if (i.kind === 'disk' && Object.keys(s.disks[i.name].parts).length) throw new ShellError(`  Cannot use ${d}: device is partitioned`);
        if (isMounted(s, d)) throw new ShellError(`  Can't open ${d} exclusively.  Mounted filesystem?`);
        s.pvs[d] ||= { vg: null }; delete s.blk[d];
      }
      changed(); return args.map((d) => `  Physical volume "${canon(d)}" successfully created.`).join('\n');
    }
    case 'pvs': return `  PV         VG     Fmt  PSize   PFree\n${Object.entries(s.pvs).map(([d, p]) => `  ${d.padEnd(10)} ${(p.vg || '').padEnd(6)} lvm2 ${fmtSize(devInfo(s, d)?.size || 0).padEnd(7)} ${fmtSize(p.vg ? 0 : devInfo(s, d)?.size || 0)}`).join('\n')}`;
    case 'vgcreate': case 'vgextend': {
      needRoot(sh, cmd); const [vn, ...devs] = args.filter((x) => x !== optVal('-s', '--physicalextentsize'));
      if (!vn || !devs.length) throw new ShellError(`  ${cmd === 'vgcreate' ? 'Please provide volume group name and physical volumes' : 'Please enter volume group name and physical volume(s)'}`);
      if (cmd === 'vgcreate' && s.vgs[vn]) throw new ShellError(`  A volume group called ${vn} already exists.`);
      if (cmd === 'vgextend' && !s.vgs[vn]) throw new ShellError(`  Volume group "${vn}" not found`);
      for (const d of devs.map(canon)) {
        const i = devInfo(s, d); if (!i) throw new ShellError(`  No device found for ${d}.`);
        if (s.pvs[d]?.vg) throw new ShellError(`  Physical volume '${d}' is already in volume group '${s.pvs[d].vg}'`);
        if (isMounted(s, d)) throw new ShellError(`  Can't open ${d} exclusively.  Mounted filesystem?`);
      }
      const pe = cmd === 'vgcreate' ? (parseSize(optVal('-s', '--physicalextentsize') || '4M') || 4) : s.vgs[vn].pe;
      if (cmd === 'vgcreate') s.vgs[vn] = { pvs: [], pe, lvs: {} };
      for (const d of devs.map(canon)) { s.pvs[d] = { vg: vn }; delete s.blk[d]; s.vgs[vn].pvs.push(d); }
      s.vgs[vn].size = vgSize(s, s.vgs[vn]);
      changed(); return cmd === 'vgcreate' ? `  Volume group "${vn}" successfully created` : `  Volume group "${vn}" successfully extended`;
    }
    case 'vgs': return `  VG     #PV #LV  VSize   VFree   PE\n${Object.entries(s.vgs).map(([n, v]) => `  ${n.padEnd(6)} ${String(v.pvs.length).padStart(3)} ${String(Object.keys(v.lvs).length).padStart(3)}  ${fmtSize(v.size).padEnd(7)} ${fmtSize(lvFree(v)).padEnd(7)} ${v.pe}M`).join('\n')}`;
    case 'vgdisplay': return Object.entries(s.vgs).filter(([n]) => !args[0] || n === args[0]).map(([n, v]) => `  --- Volume group ---\n  VG Name               ${n}\n  VG Size               ${fmtSize(v.size)}\n  PE Size               ${v.pe} MiB\n  Total PE              ${v.size / v.pe}\n  Free  PE / Size       ${lvFree(v) / v.pe} / ${fmtSize(lvFree(v))}`).join('\n');
    case 'lvs': return `  LV     VG     LSize\n${Object.entries(s.vgs).flatMap(([vn, v]) => Object.entries(v.lvs).map(([ln, l]) => `  ${ln.padEnd(6)} ${vn.padEnd(6)} ${fmtSize(l.size)}`)).join('\n')}`;
    case 'lvdisplay': return Object.entries(s.vgs).flatMap(([vn, v]) => Object.entries(v.lvs).map(([ln, l]) => `  --- Logical volume ---\n  LV Path                /dev/${vn}/${ln}\n  LV Name                ${ln}\n  VG Name                ${vn}\n  LV Size                ${fmtSize(l.size)}\n  Current LE             ${l.size / v.pe}`)).join('\n');
    case 'lvcreate': {
      needRoot(sh, 'lvcreate');
      const n = optVal('-n', '--name'); const L = optVal('-L', '--size'); const l = optVal('-l', '--extents');
      const vn = args.find((x) => x !== n && x !== L && x !== l && s.vgs[x]) || args.filter((x) => x !== n && x !== L && x !== l).pop();
      const vg = s.vgs[vn];
      if (!n) throw new ShellError('  Please specify a name for the logical volume with -n NAME.');
      if (!vg) throw new ShellError(`  Volume group "${vn || ''}" not found`);
      if (vg.lvs[n]) throw new ShellError(`  Logical Volume "${n}" already exists in volume group "${vn}"`);
      let size;
      if (L) size = parseSize(L, 'M'); else if (l) size = /%FREE$/i.test(l) ? Math.floor((lvFree(vg) * parseFloat(l)) / 100 / vg.pe) * vg.pe : Number(l) * vg.pe;
      if (!size) throw new ShellError('  Please specify either size (-L) or extents (-l).');
      size = Math.ceil(size / vg.pe) * vg.pe;
      if (size > lvFree(vg)) throw new ShellError(`  Volume group "${vn}" has insufficient free space (${lvFree(vg) / vg.pe} extents): ${size / vg.pe} required.`);
      vg.lvs[n] = { size }; changed();
      return `${L && size !== parseSize(L, 'M') ? `  Rounding up size to full physical extent ${fmtSize(size)}\n` : ''}  Logical volume "${n}" created.`;
    }
    case 'lvextend': case 'lvresize': {
      needRoot(sh, cmd); const dev = canon(args.find((x) => /^\/dev\//.test(x)) || ''); const i = devInfo(s, dev);
      if (!i || i.kind !== 'lv') throw new ShellError(`  Logical volume ${dev || '(none)'} not found. Use the path /dev/VG/LV.`);
      const vg = s.vgs[i.vg]; const lv = vg.lvs[i.lv];
      const L = optVal('-L', '--size'); const l = optVal('-l', '--extents'); let size;
      if (L) size = L.startsWith('+') ? lv.size + parseSize(L, 'M') : parseSize(L, 'M');
      else if (l) size = /%FREE$/i.test(l) ? lv.size + Math.floor((lvFree(vg) * parseFloat(l.replace('+', ''))) / 100 / vg.pe) * vg.pe : (l.startsWith('+') ? lv.size + Number(l.slice(1)) * vg.pe : Number(l) * vg.pe);
      if (!size) throw new ShellError('  Please specify either size (-L) or extents (-l).');
      size = Math.ceil(size / vg.pe) * vg.pe;
      if (cmd === 'lvextend' && size <= lv.size) throw new ShellError(`  New size given (${size / vg.pe} extents) not larger than existing size (${lv.size / vg.pe} extents)`);
      if (size < lv.size && s.blk[dev]?.fs === 'xfs') throw new ShellError('  XFS file systems cannot be shrunk. Back up, recreate and restore instead.');
      if (size - lv.size > lvFree(vg)) throw new ShellError(`  Insufficient free space: ${(size - lv.size) / vg.pe} extents needed, but only ${lvFree(vg) / vg.pe} available`);
      lv.size = size;
      const resize = flags.some((x) => x === '-r' || x === '--resizefs' || (/^-[a-zA-Z]*r/.test(x) && !x.startsWith('--')));
      if (resize && s.blk[dev]?.fs) s.blk[dev].fsSize = size;
      changed();
      return `  Size of logical volume ${i.vg}/${i.lv} changed to ${fmtSize(size)}.\n  Logical volume ${i.vg}/${i.lv} successfully resized.${resize && s.blk[dev]?.fs ? `\n${s.blk[dev].fs === 'xfs' ? 'data blocks changed' : 'The filesystem on ' + dev + ' is now resized.'}` : ''}`;
    }
    case 'lvremove': {
      needRoot(sh, 'lvremove'); const dev = canon(args[0] || ''); const i = devInfo(s, dev);
      if (!i || i.kind !== 'lv') throw new ShellError(`  Failed to find logical volume "${args[0]}"`);
      if (isMounted(s, dev)) throw new ShellError(`  Logical volume ${i.vg}/${i.lv} contains a filesystem in use.`);
      delete s.vgs[i.vg].lvs[i.lv]; delete s.blk[dev]; changed(); return `  Logical volume "${i.lv}" successfully removed.`;
    }
    case 'mkfs': case 'mkfs.xfs': case 'mkfs.ext4': case 'mkfs.vfat': case 'mkfs.fat': case 'mkswap': {
      needRoot(sh, cmd);
      const type = cmd === 'mkswap' ? 'swap' : cmd === 'mkfs' ? optVal('-t') : cmd.slice(5).replace('fat', 'vfat').replace('vvfat', 'vfat');
      const label = optVal('-L', '-n'); const dev = canon(args.filter((x) => x !== type && x !== label).pop() || '');
      if (!type) throw new ShellError('mkfs: use mkfs -t TYPE DEVICE or mkfs.xfs DEVICE');
      if (!['xfs', 'ext4', 'vfat', 'swap'].includes(type)) throw new ShellError(`mkfs: ${type}: file system type not available in this lab`);
      const i = devInfo(s, dev); if (!i) throw new ShellError(`${cmd}: cannot open ${dev || '(no device)'}: No such file or directory`);
      if (i.kind === 'disk' && Object.keys(s.disks[i.name].parts).length) throw new ShellError(`${cmd}: ${dev} is partitioned; format a partition such as ${dev}1 instead`);
      if (inUse(s, dev)) throw new ShellError(`${cmd}: ${dev} is in use (mounted, swap or an LVM physical volume)`);
      if (type === 'xfs' && s.blk[dev]?.fs && !flags.includes('-f')) throw new ShellError(`mkfs.xfs: ${dev} appears to contain an existing filesystem (${s.blk[dev].fs}).\nmkfs.xfs: Use the -f option to force overwrite.`);
      const n = (s.mkfsCount = (s.mkfsCount || 0) + 1);
      s.blk[dev] = { fs: type, uuid: makeUuid(`${dev}:${type}:${n}`), label: label || undefined, fsSize: i.size };
      changed();
      return type === 'swap' ? `Setting up swapspace version 1, size = ${fmtSize(i.size)}\nno label, UUID=${s.blk[dev].uuid}` : type === 'xfs' ? `meta-data=${dev}              isize=512    agcount=4\ndata     =                       bsize=4096   blocks=${i.size * 256}\nDiscarding blocks...Done.` : `Creating filesystem with ${i.size * 256} 4k blocks\nFilesystem UUID: ${s.blk[dev].uuid}\nWriting superblocks and filesystem accounting information: done`;
    }
    case 'xfs_admin': case 'e2label': case 'tune2fs': {
      needRoot(sh, cmd); const label = cmd === 'e2label' ? args[1] : optVal('-L'); const dev = canon(cmd === 'e2label' ? args[0] : args.filter((x) => x !== label).pop());
      if (!s.blk[dev]?.fs) throw new ShellError(`${cmd}: ${dev}: no file system found`);
      if (isMounted(s, dev) && cmd === 'xfs_admin') throw new ShellError(`xfs_admin: ${dev} contains a mounted filesystem; unmount it first`);
      if (label != null) s.blk[dev].label = label; changed(); return '';
    }
    case 'mount': {
      if (!a.length) return s.mounts.map((m) => `${m.src} on ${m.dir} type ${m.type} (rw,relatime${m.opts && m.opts !== 'defaults' ? `,${m.opts}` : ''})`).join('\n');
      needRoot(sh, 'mount');
      if (flags.includes('-a')) {
        const errs = []; for (const e of fstabEntries(sh.s.fs['/etc/fstab']?.content)) { if (e.type === 'swap') continue; const err = mountEntry(sh, e); if (err) errs.push(err); }
        changed(); return errs.join('\n');
      }
      const t = optVal('-t'); const o = optVal('-o'); const pos = args.filter((x) => x !== t && x !== o);
      let e;
      if (pos.length === 1) { e = fstabEntries(sh.s.fs['/etc/fstab']?.content).find((x) => x.dir === pos[0] || x.spec === pos[0]); if (!e) throw new ShellError(`mount: ${pos[0]}: can't find in /etc/fstab.`); }
      else { const dev = pos[0]; const r = resolveSpec(s, dev); e = { spec: dev, dir: sh.abs(pos[1]), type: t || (r && s.blk[r]?.fs) || (/:\//.test(dev) ? 'nfs' : 'auto'), opts: o || 'defaults', line: `${dev} ${pos[1]}` }; }
      if (s.mounts.some((m) => m.dir === e.dir)) throw new ShellError(`mount: ${e.dir}: ${e.spec} already mounted or mount point busy.`);
      const err = mountEntry(sh, e); if (err) throw new ShellError(err);
      changed(); return '';
    }
    case 'umount': {
      needRoot(sh, 'umount'); const t = args[0]; if (!t) throw new ShellError('Usage: umount DIRECTORY|DEVICE');
      const m = s.mounts.find((x) => x.dir === sh.abs(t) || canon(x.src) === canon(t));
      if (!m) throw new ShellError(`umount: ${t}: not mounted.`);
      if (m.dir === '/' || m.dir === '/boot') throw new ShellError(`umount: ${m.dir}: target is busy.`);
      if (sh.s.cwd === m.dir || sh.s.cwd.startsWith(`${m.dir}/`)) throw new ShellError(`umount: ${m.dir}: target is busy.`);
      s.mounts = s.mounts.filter((x) => x !== m); changed(); return '';
    }
    case 'findmnt': {
      if (flags.includes('--verify')) {
        const errs = []; const seen = new Set();
        for (const e of fstabEntries(sh.s.fs['/etc/fstab']?.content)) {
          if (!e.type) { errs.push(`${e.spec}\n   [E] parse error`); continue; }
          if (e.type !== 'swap' && e.dir !== '/' && sh.s.fs[e.dir]?.t !== 'd') errs.push(`${e.dir}\n   [E] target does not exist`);
          if (!resolveSpec(s, e.spec)) errs.push(`${e.dir}\n   [E] unreachable source: ${e.spec}`);
          else if (e.type !== 'swap' && !/^nfs/.test(e.type) && e.type !== 'auto' && s.blk[resolveSpec(s, e.spec)]?.fs !== e.type) errs.push(`${e.dir}\n   [E] ${e.type} does not match with on-disk ${s.blk[resolveSpec(s, e.spec)]?.fs || 'nothing'}`);
          if (seen.has(e.dir) && e.type !== 'swap') errs.push(`${e.dir}\n   [E] duplicate target`); seen.add(e.dir);
        }
        return `${errs.join('\n')}${errs.length ? '\n\n' : ''}${errs.length} parse errors, ${errs.length} errors, 0 warnings`;
      }
      const ms = args[0] ? s.mounts.filter((m) => m.dir === sh.abs(args[0])) : s.mounts;
      if (args[0] && !ms.length) throw new ShellError('');
      return `TARGET   SOURCE               FSTYPE OPTIONS\n${ms.map((m) => `${m.dir.padEnd(8)} ${m.src.padEnd(20)} ${m.type.padEnd(6)} rw,relatime`).join('\n')}`;
    }
    case 'df': {
      const h = flags.some((x) => /h/.test(x)); const T = flags.some((x) => /T/.test(x)); const fmt = (n) => (h ? fmtSize(n) : String(n * 1024));
      const pick = args.map((x) => sh.abs(x)); const within = (m) => !pick.length || pick.some((p) => m.dir === [...s.mounts].map((x) => x.dir).filter((d) => p === d || p.startsWith(d === '/' ? '/' : `${d}/`)).sort((a, b) => b.length - a.length)[0]);
      const rows = s.mounts.filter(within).map((m) => { const total = /:\//.test(m.src) ? 51200 : s.blk[m.src]?.fsSize ?? 0; const used = m.dir === '/' ? Math.min(total, Math.round((s.rootBase ?? total * 0.38) + Object.values(s.fs).reduce((n, x) => n + (x.size || 0), 0) / 1048576)) : m.dir === '/boot' ? 312 : Math.min(total, 40 + Math.round(total * 0.01));
        return `${m.src.replace(/^\/dev\/([^/]+)\/([^/]+)$/, (x, v, l) => (s.vgs[v] ? `/dev/mapper/${v}-${l}` : x)).padEnd(26)} ${T ? `${m.type.padEnd(6)} ` : ''}${fmt(total).padStart(6)} ${fmt(used).padStart(6)} ${fmt(total - used).padStart(6)} ${`${Math.round((used / Math.max(total, 1)) * 100)}%`.padStart(4)} ${m.dir}`; });
      return `${'Filesystem'.padEnd(26)} ${T ? 'Type   ' : ''}${h ? '  Size   Used  Avail' : '1K-blocks  Used Available'} Use% Mounted on\n${rows.join('\n')}`;
    }
    case 'xfs_growfs': case 'resize2fs': {
      needRoot(sh, cmd); const t = args[0]; const m = s.mounts.find((x) => x.dir === sh.abs(t || '')) || { src: canon(t || '') };
      const dev = canon(m.src); const i = devInfo(s, dev);
      if (!i || !s.blk[dev]) throw new ShellError(`${cmd}: ${t} is not a mounted ${cmd === 'xfs_growfs' ? 'XFS' : 'ext4'} filesystem`);
      if ((cmd === 'xfs_growfs') !== (s.blk[dev].fs === 'xfs')) throw new ShellError(`${cmd}: ${t}: wrong file system type (${s.blk[dev].fs}); use ${s.blk[dev].fs === 'xfs' ? 'xfs_growfs MOUNTPOINT' : 'resize2fs DEVICE'}`);
      s.blk[dev].fsSize = i.size; changed(); return `data blocks changed to ${i.size * 256}`;
    }
    case 'swapon': {
      if (flags.includes('--show') || flags.includes('-s') || !a.length) return s.swaps.length ? `NAME       TYPE      SIZE USED PRIO\n${s.swaps.map((d) => `${d.padEnd(10)} partition ${fmtSize(devInfo(s, d)?.size || 0).padStart(4)}   0B   -2`).join('\n')}` : '';
      needRoot(sh, 'swapon');
      if (flags.includes('-a')) { for (const e of fstabEntries(sh.s.fs['/etc/fstab']?.content).filter((x) => x.type === 'swap')) { const err = mountEntry(sh, e); if (err) return err; } changed(); return ''; }
      const d = resolveSpec(s, args[0]); if (!d || s.blk[d]?.fs !== 'swap') throw new ShellError(`swapon: ${args[0]}: read swap header failed`);
      if (s.swaps.includes(d)) throw new ShellError(`swapon: ${args[0]}: swapon failed: Device or resource busy`);
      s.swaps.push(d); changed(); return '';
    }
    case 'swapoff': { needRoot(sh, 'swapoff'); const d = resolveSpec(s, args[0] || ''); s.swaps = s.swaps.filter((x) => x !== d); changed(); return ''; }
    case 'free': {
      const sw = s.swaps.reduce((n, d) => n + (devInfo(s, d)?.size || 0), 0); const h = flags.some((x) => /h/.test(x));
      const f = (n) => (h ? fmtSize(n) : String(n * 1024));
      return `               total        used        free      shared  buff/cache   available\nMem:   ${f(3840).padStart(12)} ${f(812).padStart(11)} ${f(2310).padStart(11)} ${f(9).padStart(11)} ${f(718).padStart(11)} ${f(2780).padStart(11)}\nSwap:  ${f(sw).padStart(12)} ${f(0).padStart(11)} ${f(sw).padStart(11)}`;
    }
    case 'showmount': {
      const host = args[0]; const ex = Object.keys(s.nfs).filter((k) => k.startsWith(`${host}:`));
      if (!ex.length) throw new ShellError(`clnt_create: RPC: Unable to receive`);
      return `Export list for ${host}:\n${ex.map((k) => `${k.split(':')[1]} *`).join('\n')}`;
    }
    default: return undefined;
  }
}

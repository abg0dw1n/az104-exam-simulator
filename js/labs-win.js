// Windows command prompt simulator for troubleshooting labs. The PC sits on a described
// network (subnet, gateway, DHCP, DNS servers, reachable hosts), and ipconfig / ping /
// tracert / nslookup / netsh answer from that model and the PC's current settings.
import { isIp, inNet, maskBits } from './labs-net.js';

export function newWin(def) {
  return {
    name: def.name, platform: 'windows', hostname: def.hostname || def.name,
    adapter: { name: 'Ethernet', dhcp: true, ip: null, mask: null, gw: null, dns: [], mac: '00-1A-2B-3C-4D-5E', ...(def.adapter || {}) },
    network: def.network || {}, dnsCache: false, elevated: def.elevated ?? true,
    users: def.users || { Administrator: { active: false, groups: ['Administrators'] }, student: { active: true, groups: ['Administrators', 'Users'] } },
    procs: def.procs || [{ name: 'explorer.exe', pid: 4412, mem: '98,212 K' }, { name: 'svchost.exe', pid: 1020, mem: '24,180 K' }],
    tasks: def.tasks || [], drives: def.drives || {}, shares: def.shares || {}, log: {},
  };
}

const pad = (label, value) => `   ${label.padEnd(36, ' .').slice(0, 36)}: ${value}`;

export class WinSession {
  constructor(pc, opts = {}) { this.pc = pc; this.opts = opts; this.history = []; }
  prompt() { return 'C:\\Users\\student>'; }
  get a() { return this.pc.adapter; }
  get n() { return this.pc.network; }
  validIp() { return this.a.ip && !this.a.ip.startsWith('169.254.') && this.a.ip !== '0.0.0.0' && inNet(this.a.ip, this.n.subnet, this.n.mask); }
  // Can this PC reach `ip` right now?
  reach(ip) {
    if (!this.a.ip || this.a.ip === '0.0.0.0') return false;
    if (ip === this.a.ip || ip === '127.0.0.1') return true;
    if (!this.validIp()) return false; // APIPA or wrong subnet: nothing on this network answers
    if (inNet(ip, this.a.ip, this.a.mask)) {
      if (!inNet(ip, this.n.subnet, this.n.mask)) return false;
      return (ip === this.n.gateway && this.n.gatewayUp !== false) || !!this.n.hosts?.[ip];
    }
    // Off-subnet: needs the right default gateway, a working gateway, and an internet path.
    if (this.a.gw !== this.n.gateway || this.n.gatewayUp === false) return false;
    if (this.n.remoteHosts?.[ip]) return true;
    return !!this.n.internet && !!this.n.remote?.[ip];
  }
  resolve(name, server) {
    const servers = server ? [server] : this.a.dns;
    for (const s of servers) {
      // A server answers when the PC can reach it and it actually runs DNS (dnsServers[ip] !== false).
      if (!this.reach(s) || this.n.dnsServers?.[s] === false) continue;
      const rec = this.n.records?.[name.toLowerCase()];
      return { server: s, ip: rec || null, answered: true };
    }
    return { server: servers[0] || null, ip: null, answered: false };
  }
  run(raw) {
    const line = raw.trim(); if (!line) return '';
    this.history.push(line);
    const [cmd0, ...args] = line.split(/\s+/); const cmd = cmd0.toLowerCase().replace(/\.exe$/, '');
    const flags = args.map((x) => x.toLowerCase());
    switch (cmd) {
      case 'cls': this.opts.clear?.(); return '';
      case 'hostname': return this.pc.hostname;
      case 'help': return 'Commands in this lab: ipconfig, ping, tracert, nslookup, netsh, arp, netstat, getmac, hostname, whoami, net user, net localgroup, net use, tasklist, taskkill, schtasks, sfc, DISM, chkdsk, gpupdate, gpresult, dir, cls';
      case 'getmac': return `Physical Address    Transport Name\n=================== ==========================================================\n${this.a.mac}   \\Device\\Tcpip_{4D36E972}`;
      case 'ipconfig': return this.ipconfig(flags);
      case 'ping': return this.ping(args);
      case 'tracert': return this.tracert(args);
      case 'nslookup': return this.nslookup(args);
      case 'netsh': return this.netsh(line);
      case 'arp': {
        if (!flags.includes('-a')) return 'Displays and modifies the IP-to-Physical address translation tables. Try: arp -a';
        const rows = [];
        if (this.validIp() && this.reach(this.n.gateway)) rows.push([this.n.gateway, 'a4-91-b1-22-0c-01']);
        for (const h of Object.keys(this.n.hosts || {})) if (this.reach(h)) rows.push([h, '3c-52-82-10-aa-4f']);
        return `\nInterface: ${this.a.ip || '0.0.0.0'} --- 0x7\n  Internet Address      Physical Address      Type\n${rows.map(([i, m]) => `  ${i.padEnd(22)}${m.padEnd(22)}dynamic`).join('\n')}`;
      }
      case 'whoami': return `${this.pc.hostname.toLowerCase()}\\student`;
      case 'winver': case 'ver': return 'Microsoft Windows [Version 10.0.22631.4317]';
      case 'net': return this.net(args, flags);
      case 'tasklist': return `\nImage Name                     PID Session Name        Mem Usage\n========================= ======== ================ ============\n${this.pc.procs.map((p) => `${p.name.padEnd(26)}${String(p.pid).padStart(8)} Console          ${p.mem.padStart(12)}`).join('\n')}`;
      case 'taskkill': {
        const im = args[args.findIndex((x) => x.toLowerCase() === '/im') + 1]; const pid = args[args.findIndex((x) => x.toLowerCase() === '/pid') + 1];
        const hit = this.pc.procs.filter((p) => (im && p.name.toLowerCase() === im.toLowerCase()) || (pid && String(p.pid) === pid));
        if (!hit.length) return `ERROR: The process "${im || pid}" not found.`;
        if (hit.some((p) => p.protected) && !flags.includes('/f')) return `ERROR: The process "${hit[0].name}" with PID ${hit[0].pid} could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).`;
        this.pc.procs = this.pc.procs.filter((p) => !hit.includes(p)); this.opts.onChange?.();
        return hit.map((p) => `SUCCESS: The process "${p.name}" with PID ${p.pid} has been terminated.`).join('\n');
      }
      case 'schtasks': {
        if (flags.includes('/query') || !args.length) return `\nFolder: \\\nTaskName                                 Next Run Time          Status\n======================================== ====================== ===============\n${this.pc.tasks.map((t) => `${t.name.padEnd(41)}${(t.next || 'N/A').padEnd(23)}${t.enabled === false ? 'Disabled' : 'Ready'}`).join('\n')}`;
        if (flags.includes('/delete')) {
          if (!this.pc.elevated) return 'ERROR: Access is denied.';
          const tn = args[args.findIndex((x) => x.toLowerCase() === '/tn') + 1]?.replace(/"/g, '');
          const t = this.pc.tasks.find((x) => x.name.toLowerCase() === (tn || '').toLowerCase());
          if (!t) return 'ERROR: The system cannot find the file specified.';
          this.pc.tasks = this.pc.tasks.filter((x) => x !== t); this.opts.onChange?.();
          return `SUCCESS: The scheduled task "${t.name}" was successfully deleted.`;
        }
        return 'Usage: schtasks /query  |  schtasks /delete /tn "TaskName" /f';
      }
      case 'sfc':
        if (!flags.includes('/scannow')) return 'Usage: sfc /scannow';
        if (!this.pc.elevated) return 'You must be an administrator running a console session in order to use the sfc utility.';
        this.pc.log.sfc = true; this.opts.onChange?.();
        return '\nBeginning system scan.  This process will take some time.\n\nVerification 100% complete.\n\nWindows Resource Protection found corrupt files and successfully repaired them.';
      case 'dism':
        if (!/restorehealth/i.test(line)) return 'Example: DISM /Online /Cleanup-Image /RestoreHealth';
        this.pc.log.dism = true; this.opts.onChange?.(); return '\n[==========================100.0%==========================]\nThe restore operation completed successfully.\nThe operation completed successfully.';
      case 'chkdsk':
        if (flags.includes('/f') || flags.includes('/r')) { this.pc.log.chkdsk = true; this.opts.onChange?.(); return 'Chkdsk cannot run because the volume is in use by another\nprocess.  Would you like to schedule this volume to be\nchecked the next time the system restarts? (Y/N) Y\n\nThis volume will be checked the next time the system restarts.'; }
        return 'The type of the file system is NTFS.\nWindows has scanned the file system and found no problems.\nNo further action is required.';
      case 'gpupdate': this.pc.log.gpupdate = true; this.opts.onChange?.(); return 'Updating policy...\n\nComputer Policy update has completed successfully.\nUser Policy update has completed successfully.';
      case 'gpresult': return `\nRSOP data for ${this.pc.hostname}\\student on ${this.pc.hostname} : Logging Mode\n\nCOMPUTER SETTINGS\n    Applied Group Policy Objects\n        Default Domain Policy\n        Workstation Security Baseline\n\nUSER SETTINGS\n    Applied Group Policy Objects\n        Default Domain Policy`;
      case 'shutdown': return flags.includes('/r') ? 'The system will restart (simulated; the lab keeps running).' : 'Usage: shutdown /r /t 0';
      case 'dir': return ' Volume in drive C is Windows\n Directory of C:\\Users\\student\n\n10/29/2026  08:02 AM    <DIR>          Desktop\n10/29/2026  08:02 AM    <DIR>          Documents\n10/29/2026  08:02 AM    <DIR>          Downloads';
      case 'netstat': {
        const list = this.n.netstat || [];
        return `\nActive Connections\n\n  Proto  Local Address          Foreign Address        State\n${list.map((r) => `  ${r.proto.padEnd(7)}${r.local.padEnd(23)}${r.remote.padEnd(23)}${r.state || ''}`).join('\n')}`;
      }
      default:
        return `'${cmd0}' is not recognized as an internal or external command,\noperable program or batch file.`;
    }
  }
  ipconfig(f) {
    const a = this.a;
    if (f.includes('/release')) {
      if (!a.dhcp) return `\nWindows IP Configuration\n\nThe operation failed as no adapter is in the state permissible for\nthis operation.`;
      a.ip = '0.0.0.0'; a.mask = '0.0.0.0'; a.gw = null; a.dns = [];
      return `\nWindows IP Configuration\n\nEthernet adapter ${a.name}:\n\n   Connection-specific DNS Suffix  . :\n   Default Gateway . . . . . . . . . :`;
    }
    if (f.includes('/renew')) {
      if (!a.dhcp) return `\nWindows IP Configuration\n\nAn error occurred while renewing interface ${a.name} : DHCP is not enabled on this adapter.`;
      const d = this.n.dhcp;
      if (!d?.available) {
        a.ip = '169.254.37.112'; a.mask = '255.255.0.0'; a.gw = null; a.dns = [];
        return `\nWindows IP Configuration\n\nAn error occurred while renewing interface ${a.name} : unable to contact your DHCP server. Request has timed out.`;
      }
      a.ip = d.ip; a.mask = d.mask || this.n.mask; a.gw = d.gw; a.dns = [...(d.dns || [])];
      this.opts.onChange?.();
      return this.ipconfig([]);
    }
    if (f.includes('/flushdns')) { this.pc.dnsCache = false; return '\nWindows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.'; }
    if (f.includes('/displaydns')) return '\nWindows IP Configuration\n\n';
    const ip4 = a.ip && a.ip !== '0.0.0.0' ? a.ip : null;
    if (f.includes('/all')) {
      return [`\nWindows IP Configuration\n`, pad('Host Name', this.pc.hostname), pad('Primary Dns Suffix', ''), pad('Node Type', 'Hybrid'),
        pad('IP Routing Enabled', 'No'), `\nEthernet adapter ${a.name}:\n`, pad('Connection-specific DNS Suffix', ''),
        pad('Description', 'Intel(R) Ethernet Connection I219-LM'), pad('Physical Address', a.mac), pad('DHCP Enabled', a.dhcp ? 'Yes' : 'No'),
        pad('Autoconfiguration Enabled', 'Yes'),
        ...(ip4 ? [pad(a.ip.startsWith('169.254.') ? 'Autoconfiguration IPv4 Address' : 'IPv4 Address', `${a.ip}(Preferred)`), pad('Subnet Mask', a.mask)] : []),
        ...(a.dhcp && ip4 && !a.ip.startsWith('169.254.') ? [pad('Lease Obtained', 'Thursday, October 29, 2026 8:02:11 AM'), pad('Lease Expires', 'Friday, October 30, 2026 8:02:11 AM')] : []),
        pad('Default Gateway', a.gw || ''),
        ...(a.dhcp && ip4 && !a.ip.startsWith('169.254.') && this.n.dhcp?.server ? [pad('DHCP Server', this.n.dhcp.server)] : []),
        pad('DNS Servers', a.dns[0] || ''), ...a.dns.slice(1).map((s) => `${' '.repeat(41)}${s}`),
        pad('NetBIOS over Tcpip', 'Enabled')].join('\n');
    }
    return [`\nWindows IP Configuration\n\n\nEthernet adapter ${a.name}:\n`, pad('Connection-specific DNS Suffix', ''),
      ...(ip4 ? [pad(a.ip.startsWith('169.254.') ? 'Autoconfiguration IPv4 Address' : 'IPv4 Address', a.ip), pad('Subnet Mask', a.mask)] : []),
      pad('Default Gateway', a.gw || '')].join('\n');
  }
  target(args) {
    const t = args.find((x) => !x.startsWith('-') && !/^\d+$/.test(x));
    if (!t) return { err: 'usage' };
    if (isIp(t)) return { ip: t, name: t };
    const r = this.resolve(t);
    return r.ip ? { ip: r.ip, name: t } : { err: 'host', name: t };
  }
  ping(args) {
    const t = this.target(args);
    if (t.err === 'usage') return 'Usage: ping [-t] [-n count] target_name';
    if (t.err === 'host') { this.opts.onPing?.(t.name, false); return `Ping request could not find host ${t.name}. Please check the name and try again.`; }
    const ok = this.reach(t.ip);
    this.opts.onPing?.(t.name, ok); if (t.name !== t.ip) this.opts.onPing?.(t.ip, ok);
    const head = `\nPinging ${t.name !== t.ip ? `${t.name} [${t.ip}]` : t.ip} with 32 bytes of data:`;
    if (ok) return `${head}\n${Array(4).fill(`Reply from ${t.ip}: bytes=32 time=${t.ip.startsWith('192.168') || t.ip.startsWith('10.') ? '1' : '14'}ms TTL=${inNet(t.ip, this.a.ip || '0.0.0.0', this.a.mask || '255.255.255.255') ? 128 : 117}`).join('\n')}\n\nPing statistics for ${t.ip}:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),`;
    const noRoute = !this.validIp() || (!inNet(t.ip, this.a.ip, this.a.mask) && !this.a.gw);
    return `${head}\n${Array(4).fill(noRoute ? 'PING: transmit failed. General failure.' : 'Request timed out.').join('\n')}\n\nPing statistics for ${t.ip}:\n    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),`;
  }
  tracert(args) {
    const t = this.target(args);
    if (t.err === 'usage') return 'Usage: tracert [-d] target_name';
    if (t.err === 'host') return `Unable to resolve target system name ${t.name}.`;
    const hops = [];
    const local = this.a.ip && inNet(t.ip, this.a.ip, this.a.mask || '255.255.255.255');
    if (!local && this.validIp() && this.a.gw === this.n.gateway && this.n.gatewayUp !== false) {
      hops.push(this.n.gateway);
      if (this.n.internet) hops.push(...(this.n.isp || ['100.64.0.1']));
    }
    const ok = this.reach(t.ip);
    if (ok) hops.push(t.ip);
    const lines = hops.map((h, i) => `  ${String(i + 1).padStart(2)}    ${i + 1} ms    ${i + 1} ms    ${i + 2} ms  ${h}`);
    if (!ok) for (let i = hops.length; i < hops.length + 3; i++) lines.push(`  ${String(i + 1).padStart(2)}     *        *        *     Request timed out.`);
    return `\nTracing route to ${t.name !== t.ip ? `${t.name} [${t.ip}]` : t.ip}\nover a maximum of 30 hops:\n\n${lines.join('\n')}\n\n${ok ? 'Trace complete.' : ''}`;
  }
  nslookup(args) {
    const name = args[0]; const server = args[1];
    if (!name) return 'Default Server:  UnKnown\nAddress:  ' + (this.a.dns[0] || '') + '\n\n(Interactive mode isn\'t available in this lab. Try: nslookup www.example.com)';
    const r = this.resolve(name, server);
    this.opts.onLookup?.(name, !!r.ip);
    if (!r.answered) return `DNS request timed out.\n    timeout was 2 seconds.\nDefault Server:  UnKnown\nAddress:  ${r.server || ''}\n\n*** Request to UnKnown timed-out`;
    if (!r.ip) return `Server:  UnKnown\nAddress:  ${r.server}\n\n*** UnKnown can't find ${name}: Non-existent domain`;
    return `Server:  UnKnown\nAddress:  ${r.server}\n\nNon-authoritative answer:\nName:    ${name}\nAddress:  ${r.ip}`;
  }
  netsh(line) {
    // netsh interface ip(v4) set address name="Ethernet" static IP MASK GW | dhcp
    // netsh interface ip(v4) set dns(servers) name="Ethernet" static IP [primary] | dhcp
    // netsh interface ip(v4) add dns(servers) name="Ethernet" IP [index=2]
    const m = line.match(/^netsh\s+(?:int|interface)\s+(?:ip|ipv4)\s+(set|add)\s+(address|dns|dnsservers)\s+(?:name=)?("?)([^"]+?)\3\s+(.*)$/i);
    if (!m) return 'The following command was not found or is incomplete. Examples:\n  netsh interface ip set address name="Ethernet" static 192.168.1.50 255.255.255.0 192.168.1.1\n  netsh interface ip set address name="Ethernet" dhcp\n  netsh interface ip set dns name="Ethernet" static 192.168.1.1\n  netsh interface ip set dns name="Ethernet" dhcp';
    const [, verb, what, , ifname, restRaw] = m;
    if (ifname.toLowerCase() !== this.a.name.toLowerCase()) return `The filename, directory name, or volume label syntax is incorrect.\n(The adapter in this lab is named "${this.a.name}".)`;
    const rest = restRaw.split(/\s+/).map((x) => x.replace(/^(source|address|mask|gateway|gwmetric|register|index)=/i, ''));
    const a = this.a;
    if (what.toLowerCase() === 'address') {
      if (verb.toLowerCase() !== 'set') return 'Use "set address".';
      if (rest[0].toLowerCase() === 'dhcp') {
        a.dhcp = true;
        const d = this.n.dhcp;
        if (d?.available) { a.ip = d.ip; a.mask = d.mask || this.n.mask; a.gw = d.gw; if (!a.dnsStatic) a.dns = [...(d.dns || [])]; }
        else { a.ip = '169.254.37.112'; a.mask = '255.255.0.0'; a.gw = null; }
        this.opts.onChange?.(); return 'Ok.\n';
      }
      if (rest[0].toLowerCase() !== 'static' || !isIp(rest[1]) || !isIp(rest[2]) || maskBits(rest[2]) === null || (rest[3] && !isIp(rest[3]))) return 'The parameter is incorrect.';
      a.dhcp = false; a.ip = rest[1]; a.mask = rest[2]; a.gw = rest[3] || null;
      this.opts.onChange?.(); return 'Ok.\n';
    }
    // DNS
    if (verb.toLowerCase() === 'add') {
      if (!isIp(rest[0])) return 'The parameter is incorrect.';
      a.dns = [...a.dns.filter((x) => x !== rest[0]), rest[0]]; a.dnsStatic = true; this.opts.onChange?.(); return 'Ok.\n';
    }
    if (rest[0].toLowerCase() === 'dhcp') { a.dnsStatic = false; a.dns = a.dhcp && this.n.dhcp?.available ? [...(this.n.dhcp.dns || [])] : []; this.opts.onChange?.(); return 'Ok.\n'; }
    if (rest[0].toLowerCase() !== 'static' || !isIp(rest[1])) return 'The parameter is incorrect.';
    a.dns = [rest[1]]; a.dnsStatic = true; this.opts.onChange?.(); return 'Ok.\n';
  }
  // net user / net localgroup / net use
  net(args, flags) {
    const [sub, ...rest] = args.map((x) => x); const subL = (sub || '').toLowerCase(); const pc = this.pc;
    const deny = () => 'System error 5 has occurred.\n\nAccess is denied.';
    const words = rest.filter((x) => !x.startsWith('/'));
    if (subL === 'user') {
      if (!words.length) return `\nUser accounts for \\\\${pc.hostname}\n\n-------------------------------------------------------------------------------\n${Object.keys(pc.users).join('    ')}\nThe command completed successfully.`;
      const [name, pw] = words; const u = pc.users[name];
      const add = flags.includes('/add'); const del = flags.includes('/delete');
      const active = flags.find((f) => f.startsWith('/active:'));
      if (add) { if (!pc.elevated) return deny(); if (u) return 'The account already exists.'; pc.users[name] = { active: true, groups: ['Users'], hasPassword: !!pw }; this.opts.onChange?.(); return 'The command completed successfully.'; }
      if (!u) return 'The user name could not be found.\n\nMore help is available by typing NET HELPMSG 2221.';
      if (del) { if (!pc.elevated) return deny(); delete pc.users[name]; this.opts.onChange?.(); return 'The command completed successfully.'; }
      if (active) { if (!pc.elevated) return deny(); u.active = active.endsWith(':yes'); this.opts.onChange?.(); return 'The command completed successfully.'; }
      if (pw) { if (!pc.elevated) return deny(); u.hasPassword = true; this.opts.onChange?.(); return 'The command completed successfully.'; }
      return `User name                    ${name}\nAccount active               ${u.active ? 'Yes' : 'No'}\nPassword required            Yes\n\nLocal Group Memberships      ${u.groups.map((g) => `*${g}`).join('  ')}\nThe command completed successfully.`;
    }
    if (subL === 'localgroup') {
      const groups = [...new Set(Object.values(pc.users).flatMap((u) => u.groups))];
      if (!words.length) return `\nAliases for \\\\${pc.hostname}\n\n-------------------------------------------------------------------------------\n${['Administrators', 'Remote Desktop Users', 'Users', 'Guests', ...groups].filter((g, i, a) => a.indexOf(g) === i).map((g) => `*${g}`).join('\n')}\nThe command completed successfully.`;
      const [g, user] = [words[0], words.slice(1).join(' ')];
      const gname = ['Administrators', 'Remote Desktop Users', 'Users', 'Guests'].find((x) => x.toLowerCase() === g.toLowerCase()) || g;
      if (flags.includes('/add') || flags.includes('/delete')) {
        if (!pc.elevated) return deny();
        const u = pc.users[user]; if (!u) return 'There is no such global user or group.';
        if (flags.includes('/add')) { if (u.groups.includes(gname)) return 'System error 1378 has occurred.\n\nThe specified account name is already a member of the group.'; u.groups.push(gname); }
        else { if (!u.groups.includes(gname)) return 'System error 1377 has occurred.\n\nThe specified account name is not a member of the group.'; u.groups = u.groups.filter((x) => x !== gname); }
        this.opts.onChange?.(); return 'The command completed successfully.';
      }
      const members = Object.entries(pc.users).filter(([, u]) => u.groups.includes(gname)).map(([n]) => n);
      return `Alias name     ${gname}\n\nMembers\n\n-------------------------------------------------------------------------------\n${members.join('\n')}\nThe command completed successfully.`;
    }
    if (subL === 'use') {
      if (!words.length) return `New connections will be remembered.\n\nStatus       Local     Remote\n-------------------------------------------------------------------------------\n${Object.entries(pc.drives).map(([d, r]) => `OK           ${d.padEnd(10)}${r}`).join('\n')}\nThe command completed successfully.`;
      const [drive, unc] = words;
      if (flags.includes('/delete')) { delete pc.drives[drive.toUpperCase()]; this.opts.onChange?.(); return `${drive} was deleted successfully.`; }
      if (!/^[a-z]:$/i.test(drive) || !/^\\\\[^\\]+\\.+/.test(unc || '')) return 'The syntax of this command is:\n\nNET USE [devicename:] [\\\\computername\\sharename]';
      const share = pc.shares[unc.toLowerCase()];
      if (!share) return 'System error 53 has occurred.\n\nThe network path was not found.';
      pc.drives[drive.toUpperCase()] = unc; this.opts.onChange?.(); return 'The command completed successfully.';
    }
    return 'The syntax of this command is:\n\nNET [ USE | USER | LOCALGROUP ]';
  }
  complete(line) { return line; }
}

// Cisco IOS-style command interpreter for labs. Supports the usual modes, keyword
// abbreviations ("conf t", "int g0/1", "sh ip int br"), "?" help, Tab completion, and the
// configuration commands Network+/CCNA labs need. Errors mirror IOS wording.
import { canonIf, shortIf, isIp, maskBits, netOf, ip2n, n2ip, newIf, vlanSet } from './labs-net.js';

// Keyword tables: { keyword: [help, subtable?] }. Used for parsing, "?" help and Tab completion.
const SHOW = {
  'running-config': ['Current operating configuration'], 'startup-config': ['Contents of startup configuration'],
  ip: ['IP information', { interface: ['IP interface status and configuration', { brief: ['Brief summary of IP status and configuration'] }],
    route: ['IP routing table'], ospf: ['OSPF information', { neighbor: ['Neighbor list'] }], ssh: ['Information on SSH'] }],
  vlan: ['VTP VLAN status', { brief: ['VTP all VLAN status in brief'] }],
  interfaces: ['Interface status and configuration', { trunk: ['Show interface trunk information'], status: ['Show interface line status'] }],
  'access-lists': ['List access lists'], version: ['System hardware and software status'], history: ['Display the session command history'],
};
const EXEC_USER = { enable: ['Turn on privileged commands'], ping: ['Send echo messages'], show: ['Show running system information', SHOW],
  traceroute: ['Trace route to destination'], exit: ['Exit from the EXEC'] };
const EXEC_PRIV = { ...EXEC_USER, configure: ['Enter configuration mode', { terminal: ['Configure from the terminal'] }],
  copy: ['Copy from one file to another', { 'running-config': ['Copy from current system configuration'] }],
  write: ['Write running configuration to memory', { memory: ['Write to NV memory'] }], disable: ['Turn off privileged commands'] };
delete EXEC_PRIV.enable;
const GLOBAL = {
  hostname: ['Set system\'s network name'], interface: ['Select an interface to configure'], vlan: ['VLAN commands'],
  ip: ['Global IP configuration subcommands', { route: ['Establish static routes'], 'domain-name': ['Define the default domain name'],
    domain: ['IP DNS Resolver', { name: ['Define the default domain name'] }], ssh: ['Configure ssh options', { version: ['Specify protocol version to be supported'] }],
    'default-gateway': ['Specify default gateway (if not routing IP)'], routing: ['Enable IP routing'] }],
  router: ['Enable a routing process', { ospf: ['Open Shortest Path First (OSPF)'] }],
  enable: ['Modify enable password parameters', { secret: ['Assign the privileged level secret'], password: ['Assign the privileged level password'] }],
  username: ['Establish User Name Authentication'], crypto: ['Encryption module', { key: ['Long term key operations', { generate: ['Generate new keys', { rsa: ['Generate RSA keys'] }] }] }],
  line: ['Configure a terminal line', { vty: ['Virtual terminal'], console: ['Primary terminal line'] }],
  'access-list': ['Add an access list entry'], service: ['Modify use of network based services', { 'password-encryption': ['Encrypt system passwords'] }],
  banner: ['Define a login banner'], no: ['Negate a command or set its defaults'], do: ['To run exec commands in config mode'],
  end: ['Exit from configure mode'], exit: ['Exit from configure mode'],
};
const IFACE = {
  ip: ['Interface Internet Protocol config commands', { address: ['Set the IP address of an interface'], 'access-group': ['Specify access control for packets'],
    'helper-address': ['Specify a destination address for UDP broadcasts'], ospf: ['OSPF interface commands'] }],
  shutdown: ['Shutdown the selected interface'], description: ['Interface specific description'],
  switchport: ['Set switching mode characteristics', { mode: ['Set trunking mode of the interface', { access: ['Set trunking mode to ACCESS unconditionally'], trunk: ['Set trunking mode to TRUNK unconditionally'] }],
    access: ['Set access mode characteristics of the interface', { vlan: ['Set VLAN when interface is in access mode'] }],
    trunk: ['Set trunking characteristics of the interface', { allowed: ['Set allowed VLAN characteristics when interface is in trunking mode', { vlan: ['Set allowed VLANs'] }],
      native: ['Set trunking native characteristics', { vlan: ['Set native VLAN'] }], encapsulation: ['Set trunking encapsulation'] }] }],
  encapsulation: ['Set encapsulation type for an interface', { dot1q: ['IEEE 802.1Q Virtual LAN'] }],
  speed: ['Configure speed operation'], duplex: ['Configure duplex operation'],
  no: ['Negate a command or set its defaults'], do: ['To run exec commands in config mode'], exit: ['Exit from interface configuration mode'], end: ['Exit to privileged EXEC mode'],
};
const VLANM = { name: ['Ascii name of the VLAN'], exit: ['Apply changes, bump revision number, and exit mode'], end: ['Exit to privileged EXEC mode'], do: ['To run exec commands in config mode'] };
const ROUTER = { network: ['Enable routing on an IP network'], 'router-id': ['router-id for this OSPF process'], 'passive-interface': ['Suppress routing updates on an interface'],
  'default-information': ['Control distribution of default information'], no: ['Negate a command or set its defaults'], do: ['To run exec commands in config mode'],
  exit: ['Exit from routing protocol configuration mode'], end: ['Exit to privileged EXEC mode'] };
const LINE = { login: ['Enable password checking'], 'access-class': ['Filter connections based on an IP access list'], password: ['Set a password'], transport: ['Define transport protocols for line', { input: ['Define which protocols to use when connecting to the terminal server'] }],
  'exec-timeout': ['Set the EXEC timeout'], no: ['Negate a command or set its defaults'], do: ['To run exec commands in config mode'],
  exit: ['Exit from line configuration mode'], end: ['Exit to privileged EXEC mode'] };

class CliError extends Error { constructor(kind, at) { super(kind); this.kind = kind; this.at = at; } }

// Token cursor with IOS-style keyword prefix matching.
class P {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  get left() { return this.t.length - this.i; }
  peek() { return this.t[this.i]; }
  next() { if (this.i >= this.t.length) throw new CliError('incomplete'); return this.t[this.i++]; }
  kw(table) {
    const tok = this.next(); const low = tok.toLowerCase();
    const keys = Object.keys(table);
    if (keys.includes(low)) return low;
    const hits = keys.filter((k) => k.startsWith(low));
    if (hits.length === 1) return hits[0];
    throw new CliError(hits.length ? 'ambiguous' : 'invalid', this.i - 1);
  }
  ip() { const t = this.next(); if (!isIp(t)) throw new CliError('invalid', this.i - 1); return t; }
  num(min = 0, max = 4294967295) { const t = this.next(); if (!/^\d+$/.test(t) || +t < min || +t > max) throw new CliError('invalid', this.i - 1); return +t; }
  rest() { if (!this.left) throw new CliError('incomplete'); const r = this.t.slice(this.i).join(' '); this.i = this.t.length; return r; }
  end() { if (this.left) throw new CliError('invalid', this.i); }
}

export class IosSession {
  constructor(dev, net, opts = {}) {
    this.d = dev; this.net = net; this.opts = opts;
    this.mode = 'user'; this.ifs = []; this.vlan = null; this.lineName = null; this.pending = null;
    this.history = [];
  }
  prompt() {
    if (this.pending) return this.pending.prompt;
    const h = this.d.hostname;
    return { user: `${h}>`, priv: `${h}#`, config: `${h}(config)#`, if: `${h}(config-${this.ifs.length > 1 ? 'if-range' : this.ifs[0]?.includes('.') ? 'subif' : 'if'})#`,
      vlan: `${h}(config-vlan)#`, router: `${h}(config-router)#`, line: `${h}(config-line)#` }[this.mode];
  }
  table() {
    return { user: EXEC_USER, priv: EXEC_PRIV, config: GLOBAL, if: IFACE, vlan: VLANM, router: ROUTER, line: LINE }[this.mode];
  }
  // Run one line; returns output text (may be '').
  run(raw) {
    const line = raw.replace(/\s+$/, '');
    if (this.pending) { const p = this.pending; this.pending = null; return p.answer(line.trim()); }
    if (!line.trim()) return '';
    this.history.push(line.trim());
    if (line.trim().endsWith('?')) return this.help(line.trim());
    const tokens = line.trim().split(/\s+/);
    try {
      return this.exec(tokens) ?? '';
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.kind === 'incomplete') return '% Incomplete command.';
      if (e.kind === 'ambiguous') return `% Ambiguous command:  "${line.trim()}"`;
      // Caret under the first character of the bad token, offset by the prompt like IOS.
      const offs = []; let pos = 0; const s = line.trim();
      for (const t of tokens) { pos = s.indexOf(t, pos); offs.push(pos); pos += t.length; }
      const col = this.prompt().length + (offs[e.at ?? tokens.length - 1] ?? s.length);
      return `${' '.repeat(col)}^\n% Invalid input detected at '^' marker.`;
    }
  }
  exec(tokens, viaDo = false) {
    const p = new P(tokens);
    if (this.mode === 'user' || this.mode === 'priv' || viaDo) return this.execMode(p, viaDo);
    // In a sub-mode, try its commands first, then fall back to global config commands like IOS does.
    if (this.mode !== 'config') {
      const tbl = this.table(); const low = tokens[0].toLowerCase();
      const own = Object.keys(tbl).filter((k) => k.startsWith(low));
      if (own.length) return this[`cmd_${this.mode}`](p);
      const glob = Object.keys(GLOBAL).filter((k) => k.startsWith(low));
      if (!glob.length) throw new CliError('invalid', 0);
      this.mode = 'config'; this.ifs = []; this.vlan = null; this.lineName = null;
    }
    return this.cmd_config(p);
  }
  execMode(p, viaDo) {
    const k = p.kw(viaDo ? EXEC_PRIV : this.table());
    switch (k) {
      case 'enable': p.end(); this.mode = 'priv'; return '';
      case 'disable': p.end(); this.mode = 'user'; return '';
      case 'exit': p.end(); if (this.mode === 'priv' || this.mode === 'user') { this.mode = 'user'; return '\n\nPress RETURN to get started.'; } return '';
      case 'configure': {
        if (p.left) p.kw(EXEC_PRIV.configure[1]);
        p.end(); this.mode = 'config';
        return 'Enter configuration commands, one per line.  End with CNTL/Z.';
      }
      case 'copy': {
        p.kw({ 'running-config': [] }); const dst = p.next().toLowerCase();
        if (!'startup-config'.startsWith(dst)) throw new CliError('invalid', 1);
        p.end();
        this.pending = { prompt: 'Destination filename [startup-config]? ', answer: () => this.saveConfig() };
        return '';
      }
      case 'write': if (p.left) p.kw({ memory: [] }); p.end(); return this.saveConfig();
      case 'ping': return this.ping(p);
      case 'traceroute': return this.traceroute(p);
      case 'show': return this.show(p);
      default: throw new CliError('invalid', 0);
    }
  }
  saveConfig() {
    this.d.savedAt = Date.now(); this.d.dirty = false; this.d.startup = this.runningConfig();
    return 'Building configuration...\n[OK]';
  }

  // ── Global configuration ───────────────────────────────────────────────────
  cmd_config(p) {
    const k = p.kw(GLOBAL);
    const d = this.d; d.dirty = true;
    switch (k) {
      case 'end': p.end(); this.mode = 'priv'; return '';
      case 'exit': p.end(); this.mode = 'priv'; return '';
      case 'do': return this.exec(p.t.slice(1), true);
      case 'hostname': { const h = p.next(); p.end(); if (!/^[A-Za-z][\w-]{0,62}$/.test(h)) throw new CliError('invalid', 1); d.hostname = h; return ''; }
      case 'interface': return this.enterIf(p.rest());
      case 'vlan': {
        const ids = p.next(); p.end();
        const set = vlanSet(ids); if (!set || ![...set].every((v) => v >= 1 && v <= 4094)) throw new CliError('invalid', 1);
        for (const v of set) d.vlans[v] ||= `VLAN${String(v).padStart(4, '0')}`;
        this.mode = 'vlan'; this.vlan = [...set]; return '';
      }
      case 'ip': return this.cfgIp(p);
      case 'router': {
        p.kw(GLOBAL.router[1]); const pid = p.num(1, 65535); p.end();
        d.ospf ||= { pid, rid: null, networks: [], passive: [] };
        this.mode = 'router'; return '';
      }
      case 'enable': { const t = p.kw(GLOBAL.enable[1]); if (/^\d$/.test(p.peek() || '')) p.next(); const pw = p.next(); p.end();
        if (t === 'secret') d.enableSecret = pw; else d.enablePassword = pw; return ''; }
      case 'username': {
        const name = p.next(); let priv = 1;
        const kw = p.kw({ privilege: [], secret: [], password: [] });
        let type = kw;
        if (kw === 'privilege') { priv = p.num(0, 15); type = p.kw({ secret: [], password: [] }); }
        if (/^\d$/.test(p.peek() || '') && p.left > 1) p.next();
        const pw = p.next(); p.end();
        d.users[name] = { priv, type, pw }; return '';
      }
      case 'crypto': {
        p.kw(GLOBAL.crypto[1]); p.kw({ generate: [] }); p.kw({ rsa: [] });
        let bits = null;
        while (p.left) { const o = p.kw({ modulus: [], 'general-keys': [], label: [] }); if (o === 'modulus') bits = p.num(360, 4096); else if (o === 'label') p.next(); }
        if (!d.domainName) return '% Please define a domain-name first.';
        const finish = (b) => {
          if (!/^\d+$/.test(b) || +b < 360 || +b > 4096) return '% A decimal number between 360 and 4096.';
          d.rsa = +b; d.dirty = true;
          return `The name for the keys will be: ${d.hostname}.${d.domainName}\n\n% The key modulus size is ${b} bits\n% Generating ${b} bit RSA keys, keys will be non-exportable...\n[OK] (elapsed time was 1 seconds)\n\n%SSH-5-ENABLED: SSH 1.99 has been enabled`;
        };
        if (bits) return finish(String(bits));
        this.pending = { prompt: 'How many bits in the modulus [512]: ', answer: (a) => finish(a || '512') };
        return `The name for the keys will be: ${d.hostname}.${d.domainName}\nChoose the size of the key modulus in the range of 360 to 4096 for your\n  General Purpose Keys. Choosing a key modulus greater than 512 may take\n  a few minutes.\n`;
      }
      case 'line': {
        const which = p.kw(GLOBAL.line[1]);
        const a = p.num(0, 15); if (which === 'vty') { if (p.left) p.num(a, 15); } p.end();
        this.mode = 'line'; this.lineName = which === 'vty' ? 'vty' : 'con'; return '';
      }
      case 'access-list': return this.cfgAcl(p);
      case 'service': p.kw(GLOBAL.service[1]); p.end(); d.passwordEncryption = true; return '';
      case 'banner': p.rest(); return '';
      case 'no': return this.cfgNo(p);
      default: throw new CliError('invalid', 0);
    }
  }
  cfgIp(p) {
    const d = this.d; const k = p.kw(GLOBAL.ip[1]);
    if (k === 'route') {
      const net = p.ip(); const mask = p.ip(); if (maskBits(mask) === null) throw new CliError('invalid', 3);
      const hop = p.next(); let via = null, iface = null;
      if (isIp(hop)) via = hop; else { iface = canonIf(hop); if (!iface || !d.interfaces[iface]) throw new CliError('invalid', p.i - 1); if (p.left && isIp(p.peek())) via = p.next(); }
      if (p.left && /^\d+$/.test(p.peek())) p.next(); // administrative distance
      p.end();
      if (netOf(net, mask) !== net) return '%Inconsistent address and mask';
      d.routes = d.routes.filter((r) => !(r.net === net && r.mask === mask && r.via === via && r.iface === iface));
      d.routes.push({ net, mask, via, iface }); return '';
    }
    if (k === 'domain-name' || k === 'domain') { if (k === 'domain') p.kw({ name: [] }); d.domainName = p.next(); p.end(); return ''; }
    if (k === 'ssh') { p.kw({ version: [] }); const v = p.num(1, 2); p.end(); d.sshVersion = v; return ''; }
    if (k === 'default-gateway') { d.defaultGateway = p.ip(); p.end(); return ''; }
    if (k === 'routing') { p.end(); d.ipRouting = true; return ''; }
    throw new CliError('invalid', 1);
  }
  cfgAcl(p) {
    const num = p.num(1, 199);
    if (num > 99) return '% This simulator supports standard numbered ACLs (1-99) in this lab.';
    const action = p.kw({ permit: [], deny: [], remark: [] });
    if (action === 'remark') { p.rest(); return ''; }
    const src = p.next().toLowerCase(); let entry;
    if (src === 'any') entry = { action, any: true };
    else if (src === 'host') { entry = { action, net: p.ip(), wild: '0.0.0.0' }; }
    else if (isIp(src)) { const wild = p.left ? p.ip() : '0.0.0.0'; entry = { action, net: n2ip((ip2n(src) & ~ip2n(wild)) >>> 0), wild }; }
    else throw new CliError('invalid', 3);
    if (p.left) p.kw({ log: [] });
    p.end();
    (this.d.acls[num] ||= []).push(entry); return '';
  }
  cfgNo(p) {
    const d = this.d; const k = p.kw(GLOBAL);
    if (k === 'ip') {
      const s = p.kw(GLOBAL.ip[1]);
      if (s === 'route') { const net = p.ip(), mask = p.ip(); const via = p.left ? p.next() : null; d.routes = d.routes.filter((r) => !(r.net === net && r.mask === mask && (!via || r.via === via || shortIf(r.iface || '') === via))); return ''; }
      if (s === 'domain-name' || s === 'domain') { d.domainName = null; return ''; }
      if (s === 'default-gateway') { d.defaultGateway = null; return ''; }
      return '';
    }
    if (k === 'vlan') { for (const v of vlanSet(p.next())) if (v !== 1) delete d.vlans[v]; return ''; }
    if (k === 'router') { p.kw(GLOBAL.router[1]); p.num(); d.ospf = null; return ''; }
    if (k === 'access-list') { delete d.acls[p.num(1, 199)]; return ''; }
    if (k === 'username') { delete d.users[p.next()]; return ''; }
    if (k === 'enable') { const t = p.kw(GLOBAL.enable[1]); if (t === 'secret') d.enableSecret = null; else d.enablePassword = null; return ''; }
    if (k === 'hostname') { d.hostname = 'Router'; return ''; }
    if (k === 'service') { d.passwordEncryption = false; return ''; }
    if (k === 'interface') { const n = canonIf(p.rest()); if (n && (n.includes('.') || n.startsWith('Loopback') || n.startsWith('Vlan'))) delete d.interfaces[n]; return ''; }
    throw new CliError('invalid', 1);
  }
  enterIf(spec) {
    const d = this.d;
    // interface range f0/1 - 4 , f0/7  -> several interfaces at once
    const rng = spec.match(/^ra(?:n(?:g(?:e)?)?)?\s+(.+)$/i);
    if (rng) {
      const names = [];
      for (const part of rng[1].split(',')) {
        const m = part.replace(/\s+/g, '').match(/^([a-z]+[\d/]*?)(\d+)(?:-(\d+))?$/i);
        if (!m) throw new CliError('invalid', 1);
        const [, prefix, a, b] = m;
        for (let n = +a; n <= +(b || a); n++) {
          const nm = canonIf(`${prefix}${n}`);
          if (!nm || !d.interfaces[nm]) throw new CliError('invalid', 1);
          names.push(nm);
        }
      }
      this.mode = 'if'; this.ifs = names; return '';
    }
    const name = canonIf(spec.replace(/\s+/g, ''));
    if (!name) throw new CliError('invalid', 1);
    const virtual = name.startsWith('Loopback') || (name.startsWith('Vlan') && d.kind === 'switch') || (name.includes('.') && d.interfaces[name.split('.')[0]]);
    if (!d.interfaces[name]) {
      if (!virtual) throw new CliError('invalid', 1);
      d.interfaces[name] = newIf(d, name);
      if (name.includes('.')) d.interfaces[name].shutdown = false; // subinterfaces follow their parent
    }
    this.mode = 'if'; this.ifs = [name]; return '';
  }

  // ── Interface configuration ────────────────────────────────────────────────
  cmd_if(p) {
    const d = this.d; d.dirty = true;
    const neg = p.peek()?.toLowerCase() === 'no' ? (p.next(), true) : false;
    const k = p.kw(neg ? IFACE : IFACE);
    const each = (fn) => { for (const n of this.ifs) fn(d.interfaces[n], n); return ''; };
    switch (k) {
      case 'exit': p.end(); this.mode = 'config'; this.ifs = []; return '';
      case 'end': p.end(); this.mode = 'priv'; this.ifs = []; return '';
      case 'do': return this.exec(p.t.slice(1), true);
      case 'shutdown': p.end(); return each((i, n) => {
        i.shutdown = !neg;
        this.opts.log?.(`%LINK-5-CHANGED: Interface ${n}, changed state to ${neg ? 'up' : 'administratively down'}`);
      });
      case 'description': if (neg) { p.t.length = p.i; return each((i) => { i.description = null; }); } { const t = p.rest(); return each((i) => { i.description = t; }); }
      case 'speed': case 'duplex': p.rest(); return '';
      case 'encapsulation': {
        p.kw({ dot1q: [] }); const v = p.num(1, 4094); if (p.left) p.kw({ native: [] }); p.end();
        if (!this.ifs[0].includes('.')) return '% Configuring IEEE 802.1Q encapsulation on the main interface is not supported in this lab; use a subinterface.';
        return each((i) => { i.encap = neg ? null : v; });
      }
      case 'ip': {
        const s = p.kw(IFACE.ip[1]);
        if (s === 'address') {
          if (neg) { p.t.length = p.i; return each((i) => { i.ip = null; i.mask = null; }); }
          const ip = p.ip(); const mask = p.ip(); p.end();
          const bits = maskBits(mask);
          if (bits === null || bits === 0) return `Bad mask /${mask} for address ${ip}`;
          if (bits < 31 && (netOf(ip, mask) === ip || ip2n(ip) === ((ip2n(netOf(ip, mask)) | (~ip2n(mask) >>> 0)) >>> 0))) return `Bad mask /${bits} for address ${ip}`;
          if (this.ifs[0].includes('.') && d.interfaces[this.ifs[0]].encap == null) return '% Configure encapsulation on the subinterface first.';
          for (const [n, other] of Object.entries(d.interfaces)) {
            if (n !== this.ifs[0] && other.ip && netOf(other.ip, other.mask) === netOf(ip, mask)) return `% ${netOf(ip, mask)} overlaps with ${n}`;
          }
          return each((i) => { i.ip = ip; i.mask = mask; });
        }
        if (s === 'access-group') { const num = p.num(1, 199); const dir = p.kw({ in: [], out: [] }); p.end();
          return each((i) => { if (dir === 'in') i.aclIn = neg ? null : num; else i.aclOut = neg ? null : num; }); }
        if (s === 'helper-address') { const h = neg && !p.left ? null : p.ip(); p.end(); return each((i) => { i.helper = neg ? null : h; }); }
        if (s === 'ospf') { const pid = p.num(1, 65535); p.kw({ area: [] }); const area = p.num(0); p.end();
          d.ospf ||= { pid, rid: null, networks: [], passive: [] }; return each((i) => { i.ospfArea = neg ? null : area; }); }
        throw new CliError('invalid', 1);
      }
      case 'switchport': {
        if (d.kind !== 'switch') throw new CliError('invalid', neg ? 1 : 0);
        const s = p.kw(IFACE.switchport[1]);
        if (s === 'mode') { const m = p.kw(IFACE.switchport[1].mode[1]); p.end(); return each((i) => { i.mode = neg ? 'access' : m; }); }
        if (s === 'access') {
          p.kw({ vlan: [] }); const v = neg && !p.left ? 1 : p.num(1, 4094); p.end();
          let msg = '';
          if (!d.vlans[v]) { d.vlans[v] = `VLAN${String(v).padStart(4, '0')}`; msg = `% Access VLAN does not exist. Creating vlan ${v}`; }
          each((i) => { i.accessVlan = neg ? 1 : v; }); return msg;
        }
        if (s === 'trunk') {
          const t = p.kw(IFACE.switchport[1].trunk[1]);
          if (t === 'encapsulation') { p.kw({ dot1q: [] }); p.end(); return ''; }
          if (t === 'native') { p.kw({ vlan: [] }); const v = neg ? 1 : p.num(1, 4094); p.end(); return each((i) => { i.nativeVlan = v; }); }
          p.kw({ vlan: [] });
          if (neg) { p.end(); return each((i) => { i.allowed = 'all'; }); }
          const first = p.next(); let list = first;
          if (['add', 'remove', 'except', 'all', 'none'].includes(first.toLowerCase())) {
            const op = first.toLowerCase();
            if (op === 'all' || op === 'none') list = op;
            else {
              const arg = vlanSet(p.next()); p.end();
              return each((i) => {
                const cur = vlanSet(i.allowed) || new Set(Array.from({ length: 4094 }, (_, x) => x + 1));
                if (op === 'add') arg.forEach((v) => cur.add(v));
                if (op === 'remove') arg.forEach((v) => cur.delete(v));
                if (op === 'except') { cur.clear(); for (let v = 1; v <= 4094; v++) if (!arg.has(v)) cur.add(v); }
                i.allowed = cur.size === 4094 ? 'all' : compact(cur);
              });
            }
          }
          p.end();
          if (list !== 'all' && list !== 'none' && !/^[\d,-]+$/.test(list)) throw new CliError('invalid', p.i - 1);
          return each((i) => { i.allowed = list; });
        }
        throw new CliError('invalid', 1);
      }
      default: throw new CliError('invalid', 0);
    }
  }
  cmd_vlan(p) {
    const k = p.kw(VLANM);
    if (k === 'exit') { p.end(); this.mode = 'config'; return ''; }
    if (k === 'end') { p.end(); this.mode = 'priv'; return ''; }
    if (k === 'do') return this.exec(p.t.slice(1), true);
    const name = p.next(); p.end();
    for (const v of this.vlan) this.d.vlans[v] = name;
    this.d.dirty = true; return '';
  }
  cmd_router(p) {
    const o = this.d.ospf; this.d.dirty = true;
    const neg = p.peek()?.toLowerCase() === 'no' ? (p.next(), true) : false;
    const k = p.kw(ROUTER);
    switch (k) {
      case 'exit': p.end(); this.mode = 'config'; return '';
      case 'end': p.end(); this.mode = 'priv'; return '';
      case 'do': return this.exec(p.t.slice(1), true);
      case 'network': {
        const net = p.ip(); const wild = p.ip(); p.kw({ area: [] }); const area = p.num(0); p.end();
        o.networks = o.networks.filter((s) => !(s.net === net && s.wild === wild));
        if (!neg) o.networks.push({ net, wild, area });
        return '';
      }
      case 'router-id': { const id = neg ? null : p.ip(); p.end(); o.rid = id; return id ? 'Reload or use "clear ip ospf process" command, for this to take effect' : ''; }
      case 'passive-interface': {
        const n = canonIf(p.rest()); if (!n || !this.d.interfaces[n]) throw new CliError('invalid', neg ? 2 : 1);
        o.passive = o.passive.filter((x) => x !== n); if (!neg) o.passive.push(n); return '';
      }
      case 'default-information': p.rest(); o.originate = !neg; return '';
      default: throw new CliError('invalid', 0);
    }
  }
  cmd_line(p) {
    const l = this.lineName === 'vty' ? this.d.vty : this.d.con; this.d.dirty = true;
    const neg = p.peek()?.toLowerCase() === 'no' ? (p.next(), true) : false;
    const k = p.kw(LINE);
    switch (k) {
      case 'exit': p.end(); this.mode = 'config'; return '';
      case 'end': p.end(); this.mode = 'priv'; return '';
      case 'do': return this.exec(p.t.slice(1), true);
      case 'login': { const local = p.left ? (p.kw({ local: [] }), true) : false; p.end(); l.login = neg ? null : local ? 'local' : 'password'; return ''; }
      case 'password': { if (/^\d$/.test(p.peek() || '') && p.left > 1) p.next(); l.password = neg ? null : p.next(); p.end(); return ''; }
      case 'transport': {
        p.kw({ input: [] });
        const opts = []; while (p.left) opts.push(p.kw({ ssh: [], telnet: [], all: [], none: [] }));
        if (!opts.length) throw new CliError('incomplete');
        l.transport = opts.includes('all') ? 'all' : opts.includes('none') ? 'none' : opts.sort().join(' ');
        return '';
      }
      case 'exec-timeout': p.rest(); return '';
      case 'access-class': { const num = p.num(1, 199); p.kw({ in: [], out: [] }); p.end(); l.accessClass = neg ? null : num; return ''; }
      default: throw new CliError('invalid', 0);
    }
  }

  // ── Help and completion ────────────────────────────────────────────────────
  help(line) {
    const body = line.slice(0, -1); const endsWithSpace = /\s$/.test(body) || body === '';
    const tokens = body.trim() ? body.trim().split(/\s+/) : [];
    let tbl = this.mode === 'priv' || this.mode === 'user' ? this.table() : { ...GLOBAL, ...this.table() };
    const walk = endsWithSpace ? tokens : tokens.slice(0, -1);
    for (const t of walk) {
      const low = t.toLowerCase(); const keys = Object.keys(tbl || {});
      const k = keys.includes(low) ? low : keys.filter((x) => x.startsWith(low)).length === 1 ? keys.find((x) => x.startsWith(low)) : null;
      if (k === 'do') { tbl = EXEC_PRIV; continue; }
      if (!k) return '% Unrecognized command';
      tbl = tbl[k][1];
      if (!tbl) return '  <cr>  (or an argument; see the lab instructions)';
    }
    const partial = endsWithSpace ? '' : (tokens[tokens.length - 1] || '').toLowerCase();
    const opts = Object.entries(tbl).filter(([k]) => k.startsWith(partial));
    if (!opts.length) return '% Unrecognized command';
    const w = Math.max(...opts.map(([k]) => k.length)) + 2;
    return opts.map(([k, [h]]) => `  ${k.padEnd(w)}${h}`).join('\n');
  }
  complete(line) {
    const m = line.match(/^(.*?)(\S*)$/); const before = m[1]; const last = m[2].toLowerCase();
    if (!last) return line;
    let tbl = this.mode === 'priv' || this.mode === 'user' ? this.table() : { ...GLOBAL, ...this.table() };
    for (const t of before.trim() ? before.trim().split(/\s+/) : []) {
      const keys = Object.keys(tbl || {}); const low = t.toLowerCase();
      const k = keys.includes(low) ? low : keys.filter((x) => x.startsWith(low)).length === 1 ? keys.find((x) => x.startsWith(low)) : null;
      if (k === 'do') { tbl = EXEC_PRIV; continue; }
      tbl = k ? tbl[k][1] : null; if (!tbl) return line;
    }
    const hits = Object.keys(tbl).filter((k) => k.startsWith(last));
    return hits.length === 1 ? `${before}${hits[0]} ` : line;
  }

  // ── show / ping / traceroute ───────────────────────────────────────────────
  show(p) {
    const k = p.kw(SHOW); const d = this.d; const net = this.net.build();
    switch (k) {
      case 'running-config': p.end(); return `Building configuration...\n\nCurrent configuration : ${this.runningConfig().length} bytes\n${this.runningConfig()}`;
      case 'startup-config': p.end(); return d.startup ? `Using ${d.startup.length} bytes\n${d.startup}` : 'startup-config is not present';
      case 'version': p.end(); return `Cisco IOS Software, Lab Simulator\n${d.hostname} uptime is 1 hour, 4 minutes\nThis is a simulated device for practice. Not every command or output is identical to real IOS.`;
      case 'history': p.end(); return this.history.slice(-20).map((h) => `  ${h}`).join('\n');
      case 'access-lists': p.end(); return Object.entries(d.acls).map(([n, es]) => `Standard IP access list ${n}\n${es.map((e, i) => `    ${(i + 1) * 10} ${e.action} ${e.any ? 'any' : e.wild === '0.0.0.0' ? e.net : `${e.net}, wildcard bits ${e.wild}`}`).join('\n')}`).join('\n') || '';
      case 'vlan': {
        if (p.left) p.kw({ brief: [] }); p.end();
        if (d.kind !== 'switch') throw new CliError('invalid', 1);
        const rows = Object.keys(d.vlans).map(Number).sort((a, b) => a - b).map((v) => {
          const ports = Object.entries(d.interfaces).filter(([n, i]) => !n.startsWith('Vlan') && i.mode !== 'trunk' && i.accessVlan === v).map(([n]) => shortIf(n));
          const chunks = []; for (let x = 0; x < ports.length; x += 4) chunks.push(ports.slice(x, x + 4).join(', '));
          return `${String(v).padEnd(5)}${d.vlans[v].padEnd(33)}active    ${chunks[0] || ''}${chunks.slice(1).map((c) => `\n${' '.repeat(48)}${c}`).join('')}`;
        });
        return `VLAN Name                             Status    Ports\n---- -------------------------------- --------- -------------------------------\n${rows.join('\n')}`;
      }
      case 'interfaces': {
        const s = p.kw(SHOW.interfaces[1]); p.end();
        if (s === 'trunk') {
          const tr = Object.entries(d.interfaces).filter(([n, i]) => i.mode === 'trunk' && net.physUp(d, n));
          if (!tr.length) return '';
          return `Port        Mode         Encapsulation  Status        Native vlan\n${tr.map(([n, i]) => `${shortIf(n).padEnd(12)}on           802.1q         trunking      ${i.nativeVlan}`).join('\n')}\n\nPort        Vlans allowed on trunk\n${tr.map(([n, i]) => `${shortIf(n).padEnd(12)}${i.allowed === 'all' ? '1-4094' : i.allowed}`).join('\n')}`;
        }
        return `Port      Name               Status       Vlan\n${Object.entries(d.interfaces).filter(([n]) => !n.startsWith('Vlan')).map(([n, i]) =>
          `${shortIf(n).padEnd(10)}${(i.description || '').slice(0, 18).padEnd(19)}${(i.shutdown ? 'disabled' : net.physUp(d, n) ? 'connected' : 'notconnect').padEnd(13)}${i.mode === 'trunk' ? 'trunk' : i.accessVlan}`).join('\n')}`;
      }
      case 'ip': {
        const s = p.kw(SHOW.ip[1]);
        if (s === 'interface') {
          if (p.left) p.kw({ brief: [] }); p.end();
          return `Interface              IP-Address      OK? Method Status                Protocol\n${Object.entries(d.interfaces).map(([n, i]) => {
            const st = i.shutdown ? 'administratively down' : net.ifUp(d, n) ? 'up' : 'down';
            const pr = net.ifUp(d, n) ? 'up' : 'down';
            return `${n.padEnd(23)}${(i.ip || 'unassigned').padEnd(16)}YES ${(i.ip ? 'manual' : 'unset').padEnd(7)}${st.padEnd(22)}${pr}`;
          }).join('\n')}`;
        }
        if (s === 'route') {
          p.end();
          const t = net.table(d); const def = t.find((r) => r.net === '0.0.0.0' && r.mask === '0.0.0.0');
          const legend = 'Codes: L - local, C - connected, S - static, O - OSPF, * - candidate default\n';
          const gw = def ? `Gateway of last resort is ${def.via || 'directly connected'} to network 0.0.0.0\n` : 'Gateway of last resort is not set\n';
          const lines = t.sort((a, b) => ip2n(a.net) - ip2n(b.net) || maskBits(a.mask) - maskBits(b.mask)).map((r) => {
            const pfx = `${r.net}/${maskBits(r.mask)}`;
            if (r.code === 'C' || r.code === 'L') return `${r.code.padEnd(9)}${pfx} is directly connected, ${r.iface}`;
            if (r.code === 'O') return `O        ${pfx} [110/${r.cost}] via ${r.via}, 00:01:12, ${r.iface}`;
            return `${r.code.padEnd(9)}${pfx} [1/0] via ${r.via || ''}${r.iface ? `${r.via ? ', ' : 'is directly connected, '}${r.iface}` : ''}`;
          });
          return `${legend}\n${gw}\n${lines.join('\n')}`;
        }
        if (s === 'ospf') {
          p.kw({ neighbor: [] }); p.end();
          if (!d.ospf) return '';
          const n = net.nbrs[d.name] || [];
          return `Neighbor ID     Pri   State           Dead Time   Address         Interface\n${n.map((x) => `${x.id.padEnd(16)}1     FULL/  -        00:00:35    ${x.ip.padEnd(16)}${x.iface}`).join('\n')}`;
        }
        if (s === 'ssh') {
          p.end();
          return d.rsa && d.sshVersion === 2 ? 'SSH Enabled - version 2.0\nAuthentication timeout: 120 secs; Authentication retries: 3'
            : d.rsa ? 'SSH Enabled - version 1.99\nAuthentication timeout: 120 secs; Authentication retries: 3' : '%SSH has not been enabled';
        }
        throw new CliError('invalid', 1);
      }
      default: throw new CliError('invalid', 1);
    }
  }
  ping(p) {
    const dst = p.ip(); p.end();
    const r = this.net.build().ping(this.d.name, dst);
    this.opts.onPing?.(dst, r.ok);
    return `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${dst}, timeout is 2 seconds:\n${r.ok ? '!!!!!' : r.reason === 'noroute' ? 'UUUUU' : '.....'}\nSuccess rate is ${r.ok ? '100 percent (5/5), round-trip min/avg/max = 1/2/4 ms' : '0 percent (0/5)'}`;
  }
  traceroute(p) {
    const dst = p.ip(); p.end();
    const r = this.net.build().ping(this.d.name, dst);
    const hops = r.ok ? [...r.hops.slice(0, -1), dst] : r.hops;
    const out = hops.map((h, i) => `  ${i + 1} ${h} ${4 + i} msec ${3 + i} msec ${5 + i} msec`);
    if (!r.ok) out.push(`  ${hops.length + 1}  *  *  *`);
    return `Type escape sequence to abort.\nTracing the route to ${dst}\n\n${out.join('\n')}`;
  }
  runningConfig() {
    const d = this.d; const L = ['!', `hostname ${d.hostname}`, '!'];
    if (d.passwordEncryption) L.splice(1, 0, 'service password-encryption');
    if (d.enableSecret) L.push('enable secret 9 $9$simulated$hash');
    for (const [u, x] of Object.entries(d.users)) L.push(`username ${u}${x.priv !== 1 ? ` privilege ${x.priv}` : ''} ${x.type === 'secret' ? 'secret 9 $9$simulated$hash' : `password ${d.passwordEncryption ? '7 0822455D0A16' : x.pw}`}`);
    if (d.domainName) L.push(`ip domain name ${d.domainName}`);
    if (d.sshVersion) L.push(`ip ssh version ${d.sshVersion}`);
    if (L[L.length - 1] !== '!') L.push('!');
    for (const [n, i] of Object.entries(d.interfaces)) {
      L.push(`interface ${n}`);
      if (i.description) L.push(` description ${i.description}`);
      if (i.encap != null) L.push(` encapsulation dot1Q ${i.encap}`);
      if (d.kind === 'switch' && !n.startsWith('Vlan') && !n.startsWith('Loopback')) {
        if (i.mode === 'trunk') { if (i.nativeVlan !== 1) L.push(` switchport trunk native vlan ${i.nativeVlan}`); if (i.allowed !== 'all') L.push(` switchport trunk allowed vlan ${i.allowed}`); L.push(' switchport mode trunk'); }
        else { if (i.accessVlan !== 1) L.push(` switchport access vlan ${i.accessVlan}`); L.push(' switchport mode access'); }
      }
      if (i.ip) L.push(` ip address ${i.ip} ${i.mask}`);
      else if (d.kind !== 'switch' || n.startsWith('Vlan')) L.push(' no ip address');
      if (i.helper) L.push(` ip helper-address ${i.helper}`);
      if (i.aclIn) L.push(` ip access-group ${i.aclIn} in`);
      if (i.aclOut) L.push(` ip access-group ${i.aclOut} out`);
      if (i.ospfArea != null && d.ospf) L.push(` ip ospf ${d.ospf.pid} area ${i.ospfArea}`);
      if (i.shutdown) L.push(' shutdown');
      L.push('!');
    }
    if (d.ospf) {
      L.push(`router ospf ${d.ospf.pid}`);
      if (d.ospf.rid) L.push(` router-id ${d.ospf.rid}`);
      for (const n of d.ospf.passive) L.push(` passive-interface ${n}`);
      for (const s of d.ospf.networks) L.push(` network ${s.net} ${s.wild} area ${s.area}`);
      if (d.ospf.originate) L.push(' default-information originate');
      L.push('!');
    }
    if (d.defaultGateway) L.push(`ip default-gateway ${d.defaultGateway}`);
    for (const r of d.routes) L.push(`ip route ${r.net} ${r.mask}${r.iface ? ` ${r.iface}` : ''}${r.via ? ` ${r.via}` : ''}`);
    for (const [n, es] of Object.entries(d.acls)) for (const e of es) L.push(`access-list ${n} ${e.action} ${e.any ? 'any' : e.wild === '0.0.0.0' ? `host ${e.net}` : `${e.net} ${e.wild}`}`);
    L.push('!', 'line con 0');
    if (d.con.password) L.push(` password ${d.con.password}`);
    if (d.con.login) L.push(d.con.login === 'local' ? ' login local' : ' login');
    L.push('line vty 0 4');
    if (d.vty.password) L.push(` password ${d.vty.password}`);
    if (d.vty.login) L.push(d.vty.login === 'local' ? ' login local' : ' login');
    if (d.vty.accessClass) L.push(` access-class ${d.vty.accessClass} in`);
    if (d.vty.transport !== 'all') L.push(` transport input ${d.vty.transport}`);
    L.push('!', 'end');
    return L.join('\n');
  }
}

function compact(set) {
  const v = [...set].sort((a, b) => a - b); const out = [];
  for (let i = 0; i < v.length; i++) {
    let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(j > i ? `${v[i]}-${v[j]}` : String(v[i])); i = j;
  }
  return out.join(',') || 'none';
}

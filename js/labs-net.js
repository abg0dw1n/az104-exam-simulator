// Simulated network for command-line labs: Cisco IOS-style routers/switches, plain hosts,
// and the reachability math behind ping, traceroute, "show ip route" and OSPF neighbors.
// Everything is computed from device state, so a lab's result depends on what the
// learner actually configured.

// ── IPv4 helpers ─────────────────────────────────────────────────────────────
export const ip2n = (ip) => {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3];
};
export const n2ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const isIp = (s) => ip2n(s) !== null;
export const maskBits = (mask) => {
  const n = ip2n(mask); if (n === null) return null;
  const bits = n.toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : null;
};
export const bitsMask = (b) => n2ip(b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0);
export const netOf = (ip, mask) => n2ip((ip2n(ip) & ip2n(mask)) >>> 0);
export const inNet = (ip, net, mask) => ((ip2n(ip) & ip2n(mask)) >>> 0) === ((ip2n(net) & ip2n(mask)) >>> 0);
// Wildcard match (ACLs, OSPF network statements): bits set in the wildcard are "don't care".
export const wildMatch = (ip, net, wild) => {
  const w = ip2n(wild);
  return ((ip2n(ip) & ~w) >>> 0) === ((ip2n(net) & ~w) >>> 0);
};

// ── Interface names ──────────────────────────────────────────────────────────
const IFTYPES = ['GigabitEthernet', 'FastEthernet', 'Ethernet', 'Serial', 'Loopback', 'Vlan', 'TenGigabitEthernet'];
const SHORT = { GigabitEthernet: 'Gi', FastEthernet: 'Fa', Ethernet: 'Et', Serial: 'Se', Loopback: 'Lo', Vlan: 'Vl', TenGigabitEthernet: 'Te' };
// "g0/0", "gi 0/0", "GigabitEthernet0/0.10", "vlan 10" -> canonical name, or null.
export function canonIf(raw) {
  const m = String(raw).replace(/\s+/g, '').match(/^([a-z]+)([\d/.:]+)$/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const hits = IFTYPES.filter((t) => t.toLowerCase().startsWith(word));
  const type = hits.length === 1 ? hits[0] : hits.find((t) => t.toLowerCase() === word)
    || (word === 'g' ? 'GigabitEthernet' : word === 'f' ? 'FastEthernet' : word === 'e' ? 'Ethernet' : word === 'te' ? 'TenGigabitEthernet' : null);
  return type ? type + m[2] : null;
}
export const shortIf = (name) => {
  const t = IFTYPES.find((x) => name.startsWith(x));
  return t ? SHORT[t] + name.slice(t.length) : name;
};
const isSub = (name) => name.includes('.');
const parentIf = (name) => name.split('.')[0];

// ── Device state ─────────────────────────────────────────────────────────────
export function newIos(def) {
  const d = {
    name: def.name, platform: 'ios', kind: def.kind || 'router', hostname: def.hostname || def.name,
    enableSecret: null, users: {}, domainName: null, rsa: false, sshVersion: null,
    vty: { login: null, transport: 'all', password: null }, con: { login: null, password: null },
    interfaces: {}, vlans: { 1: 'default' }, routes: [], ospf: null, acls: {}, defaultGateway: null,
    savedAt: null, dirty: false,
  };
  for (const n of def.interfaces || []) d.interfaces[n] = newIf(d, n);
  if (def.state) deepMerge(d, def.state);
  return d;
}
export function newIf(d, name) {
  const sw = d.kind === 'switch' && !name.startsWith('Vlan') && !name.startsWith('Loopback');
  return {
    ip: null, mask: null, description: null,
    // Router ports and SVIs start administratively down; switch ports start up, like real gear.
    shutdown: !(sw || name.startsWith('Loopback')),
    mode: sw ? 'access' : null, accessVlan: 1, allowed: 'all', nativeVlan: 1, encap: null,
    aclIn: null, aclOut: null, ospfArea: null, helper: null,
  };
}
function deepMerge(t, s) {
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object') deepMerge(t[k], v);
    else t[k] = v;
  }
}

// Expand "10,20,30-32" / "all" / "none" into a Set (null = all).
export function vlanSet(spec) {
  if (spec == null || spec === 'all') return null;
  const out = new Set();
  if (spec === 'none') return out;
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let v = a; v <= (b || a); v++) out.add(v);
  }
  return out;
}

// ── Topology: links -> broadcast domains ─────────────────────────────────────
// devices: { name: device }   links: [["R1 g0/0", "SW1 g0/1"], ["SW1 f0/1", "PC1"]]
export class Net {
  constructor(devices, links) { this.dev = devices; this.links = (links || []).map(([a, b]) => [this.end(a), this.end(b)]); }
  end(s) {
    const [name, ...rest] = String(s).trim().split(/\s+/);
    return { name, iface: rest.length ? canonIf(rest.join('')) : null };
  }
  ifUp(dev, name) {
    if (!dev || dev.platform === 'host') return true;
    const i = dev.interfaces[name]; if (!i) return false;
    if (i.shutdown) return false;
    if (isSub(name)) return this.ifUp(dev, parentIf(name));
    if (name.startsWith('Loopback')) return true;
    if (name.startsWith('Vlan')) {
      // An SVI is up when its VLAN exists and at least one up port carries it.
      const v = Number(name.slice(4));
      if (!dev.vlans[v]) return false;
      return Object.entries(dev.interfaces).some(([n, p]) => !n.startsWith('Vlan') && this.physUp(dev, n)
        && (p.mode === 'trunk' ? (vlanSet(p.allowed)?.has(v) ?? true) : p.accessVlan === v));
    }
    return this.physUp(dev, name);
  }
  // A physical port is up/up when it's not shut down and its cable goes to a port that isn't shut down.
  physUp(dev, name) {
    const i = dev.interfaces[name]; if (!i || i.shutdown) return false;
    const peer = this.peerOf(dev.name, name);
    if (!peer) return false;
    const pd = this.dev[peer.name];
    if (!pd || pd.platform === 'host' || pd.platform === 'windows') return true;
    const pi = pd.interfaces[peer.iface];
    return !!pi && !pi.shutdown;
  }
  peerOf(name, iface) {
    for (const [a, b] of this.links) {
      if (a.name === name && (a.iface === iface || (!a.iface && !iface))) return b;
      if (b.name === name && (b.iface === iface || (!b.iface && !iface))) return a;
    }
    return null;
  }
  // Union-find over (switch, vlan) and link segments; returns endpoints [{dev, iface, ip, mask, dom}].
  build() {
    const parent = {};
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]] ?? parent[x]; x = parent[x]; } return x; };
    const add = (x) => { if (!(x in parent)) parent[x] = x; return x; };
    const join = (a, b) => { parent[find(add(a))] = find(add(b)); };
    const eps = [];
    const swPortDomains = (dev, port, tag) => {
      // Which (switch,vlan) domain a frame entering this switch port lands in. tag = 802.1Q tag or null.
      const p = dev.interfaces[port]; if (!p || !this.physUp(dev, port)) return null;
      if (p.mode === 'trunk') {
        const v = tag ?? p.nativeVlan;
        const allowed = vlanSet(p.allowed);
        return (allowed ? allowed.has(v) : true) && dev.vlans[v] ? `${dev.name}|v${v}` : null;
      }
      return tag == null && dev.vlans[p.accessVlan] ? `${dev.name}|v${p.accessVlan}` : null;
    };
    this.links.forEach(([a, b], li) => {
      const da = this.dev[a.name], db = this.dev[b.name];
      if (!da || !db) return;
      const swA = da.kind === 'switch', swB = db.kind === 'switch';
      if (swA && swB) {
        // Trunk-to-trunk: join each VLAN allowed on both ends; access-to-access: join the two access VLANs.
        const pa = da.interfaces[a.iface], pb = db.interfaces[b.iface];
        if (!pa || !pb || !this.physUp(da, a.iface)) return;
        if (pa.mode === 'trunk' && pb.mode === 'trunk') {
          for (let v = 1; v <= 4094; v++) {
            if (!da.vlans[v] || !db.vlans[v]) continue;
            const okA = vlanSet(pa.allowed)?.has(v) ?? true, okB = vlanSet(pb.allowed)?.has(v) ?? true;
            if (okA && okB) join(`${da.name}|v${v}`, `${db.name}|v${v}`);
          }
        } else if (pa.mode !== 'trunk' && pb.mode !== 'trunk') {
          if (da.vlans[pa.accessVlan] && db.vlans[pb.accessVlan]) join(`${da.name}|v${pa.accessVlan}`, `${db.name}|v${pb.accessVlan}`);
        }
        return;
      }
      if (swA || swB) {
        const [sw, swEnd, other, otherEnd] = swA ? [da, a, db, b] : [db, b, da, a];
        if (other.platform === 'host' || other.platform === 'windows') {
          const dom = swPortDomains(sw, swEnd.iface, null);
          if (dom) eps.push({ dev: other.name, iface: null, ip: other.ip, mask: other.mask, dom: add(dom) });
          return;
        }
        // Router (or L3 device) port on a switch: physical = untagged/native, subinterfaces = tagged.
        for (const [n, i] of Object.entries(other.interfaces)) {
          if (parentIf(n) !== otherEnd.iface || !this.ifUp(other, n) || !i.ip) continue;
          const tag = isSub(n) ? i.encap : null;
          if (isSub(n) && tag == null) continue;
          const dom = swPortDomains(sw, swEnd.iface, tag);
          if (dom) eps.push({ dev: other.name, iface: n, ip: i.ip, mask: i.mask, dom: add(dom) });
        }
        return;
      }
      // Point-to-point between two L3 devices / hosts.
      const dom = add(`link${li}`);
      for (const [d, e] of [[da, a], [db, b]]) {
        if (d.platform === 'host' || d.platform === 'windows') { eps.push({ dev: d.name, iface: null, ip: d.ip, mask: d.mask, dom }); continue; }
        const i = d.interfaces[e.iface];
        if (i?.ip && this.ifUp(d, e.iface)) eps.push({ dev: d.name, iface: e.iface, ip: i.ip, mask: i.mask, dom });
      }
    });
    // Switch SVIs and loopbacks.
    for (const d of Object.values(this.dev)) {
      if (d.platform !== 'ios') continue;
      for (const [n, i] of Object.entries(d.interfaces)) {
        if (!i.ip || !this.ifUp(d, n)) continue;
        if (n.startsWith('Vlan') && d.kind === 'switch') eps.push({ dev: d.name, iface: n, ip: i.ip, mask: i.mask, dom: add(`${d.name}|v${n.slice(4)}`) });
        if (n.startsWith('Loopback')) eps.push({ dev: d.name, iface: n, ip: i.ip, mask: i.mask, dom: add(`${d.name}|${n}`) });
      }
    }
    for (const e of eps) e.dom = find(e.dom);
    this.eps = eps;
    this.computeOspf();
    return this;
  }

  // ── Routing ────────────────────────────────────────────────────────────────
  ospfOn(d, n, i) {
    if (!d.ospf || !i.ip) return null;
    if (i.ospfArea != null) return String(i.ospfArea);
    const st = d.ospf.networks.find((s) => wildMatch(i.ip, s.net, s.wild));
    return st ? String(st.area) : null;
  }
  computeOspf() {
    this.nbrs = {}; this.ospfRoutes = {};
    const rtrs = Object.values(this.dev).filter((d) => d.platform === 'ios' && d.ospf);
    const ospfEps = this.eps.filter((e) => {
      const d = this.dev[e.dev]; if (!d?.ospf || !e.iface) return false;
      e.area = this.ospfOn(d, e.iface, d.interfaces[e.iface]);
      return e.area != null;
    });
    for (const a of ospfEps) for (const b of ospfEps) {
      if (a.dev === b.dev || a.dom !== b.dom || a.area !== b.area) continue;
      const da = this.dev[a.dev], db = this.dev[b.dev];
      if (da.ospf.passive.includes(a.iface) || db.ospf.passive.includes(b.iface)) continue;
      if (netOf(a.ip, a.mask) !== netOf(b.ip, b.mask) || a.mask !== b.mask) continue;
      (this.nbrs[a.dev] ||= []).push({ id: this.routerId(db), dev: b.dev, ip: b.ip, iface: a.iface });
    }
    // Each router learns every OSPF-enabled subnet in its connected OSPF domain, via the first hop on a shortest path.
    for (const r of rtrs) {
      const routes = {}; const seen = new Set([r.name]);
      let frontier = (this.nbrs[r.name] || []).map((n) => ({ dev: n.dev, via: n.ip, iface: n.iface, cost: 2 }));
      while (frontier.length) {
        const next = [];
        for (const f of frontier) {
          if (seen.has(f.dev)) continue;
          seen.add(f.dev);
          for (const e of ospfEps.filter((x) => x.dev === f.dev)) {
            const key = `${netOf(e.ip, e.mask)}/${maskBits(e.mask)}`;
            if (!routes[key] && !this.connectedNet(r, e.ip)) routes[key] = { net: netOf(e.ip, e.mask), mask: e.mask, via: f.via, iface: f.iface, cost: f.cost };
          }
          for (const n of this.nbrs[f.dev] || []) next.push({ dev: n.dev, via: f.via, iface: f.iface, cost: f.cost + 1 });
        }
        frontier = next;
      }
      this.ospfRoutes[r.name] = Object.values(routes);
    }
  }
  routerId(d) {
    if (d.ospf?.rid) return d.ospf.rid;
    const ips = Object.entries(d.interfaces).filter(([n, i]) => i.ip && this.ifUp(d, n));
    const loops = ips.filter(([n]) => n.startsWith('Loopback'));
    const pool = (loops.length ? loops : ips).map(([, i]) => ip2n(i.ip));
    return pool.length ? n2ip(Math.max(...pool)) : '0.0.0.0';
  }
  connectedNet(d, ip) {
    return Object.entries(d.interfaces || {}).some(([n, i]) => i.ip && this.ifUp(d, n) && inNet(ip, i.ip, i.mask));
  }
  // Full routing table: [{code, net, mask, via, iface}]
  table(d) {
    if (d.platform === 'host' || d.platform === 'windows') {
      const t = d.ip ? [{ code: 'C', net: netOf(d.ip, d.mask), mask: d.mask, iface: null }] : [];
      if (d.gw) t.push({ code: 'S', net: '0.0.0.0', mask: '0.0.0.0', via: d.gw });
      return t;
    }
    const t = [];
    for (const [n, i] of Object.entries(d.interfaces)) {
      if (!i.ip || !this.ifUp(d, n)) continue;
      t.push({ code: 'C', net: netOf(i.ip, i.mask), mask: i.mask, iface: n });
      t.push({ code: 'L', net: i.ip, mask: '255.255.255.255', iface: n });
    }
    for (const r of d.routes) {
      // A static route is installed only when its next hop is reachable (or its exit interface is up).
      if (r.via && !this.connectedNet(d, r.via)) continue;
      if (r.iface && !this.ifUp(d, r.iface)) continue;
      t.push({ code: r.net === '0.0.0.0' && r.mask === '0.0.0.0' ? 'S*' : 'S', net: r.net, mask: r.mask, via: r.via, iface: r.iface });
    }
    for (const r of this.ospfRoutes[d.name] || []) {
      if (!t.some((x) => x.net === r.net && x.mask === r.mask)) t.push({ code: 'O', net: r.net, mask: r.mask, via: r.via, iface: r.iface, cost: r.cost });
    }
    if (d.kind === 'switch' && d.defaultGateway) t.push({ code: 'S*', net: '0.0.0.0', mask: '0.0.0.0', via: d.defaultGateway });
    return t;
  }
  lookup(d, dst) {
    let best = null;
    for (const r of this.table(d)) {
      if (!inNet(dst, r.net, r.mask)) continue;
      if (!best || maskBits(r.mask) > maskBits(best.mask)) best = r;
    }
    return best;
  }
  owns(d, ip) {
    if (d.platform === 'host' || d.platform === 'windows') return d.ip === ip;
    return Object.entries(d.interfaces).some(([n, i]) => i.ip === ip && this.ifUp(d, n));
  }
  epFor(dev, ip) { return this.eps.find((e) => e.dev === dev && e.ip === ip); }
  // Standard ACL check on an interface for a packet's source.
  aclPermits(d, iface, dir, src) {
    const i = d.interfaces?.[iface]; const num = i && (dir === 'in' ? i.aclIn : i.aclOut);
    if (!num) return true;
    const acl = d.acls[num]; if (!acl) return true; // an applied-but-empty ACL permits (IOS behavior)
    for (const e of acl) if (e.any || wildMatch(src, e.net, e.wild)) return e.action === 'permit';
    return false; // implicit deny
  }
  // One-way trip from device `from` (sourcing from `src`) to `dst`. Returns { ok, hops, reason }.
  trip(fromName, src, dst) {
    let cur = this.dev[fromName]; let inIf = null; const hops = [];
    for (let ttl = 0; ttl < 16; ttl++) {
      if (this.owns(cur, dst)) {
        if (inIf && !this.aclPermits(cur, inIf, 'in', src)) return { ok: false, hops, reason: 'acl' };
        return { ok: true, hops };
      }
      if (inIf && !this.aclPermits(cur, inIf, 'in', src)) return { ok: false, hops, reason: 'acl' };
      if (ttl > 0 && cur.platform !== 'ios') return { ok: false, hops, reason: 'host' };
      const r = this.lookup(cur, dst);
      if (!r) return { ok: false, hops, reason: 'noroute' };
      // Connected routes and exit-interface static routes deliver straight to the destination.
      const nh = r.code === 'C' || !r.via ? dst : r.via;
      const out = this.egress(cur, r, nh);
      if (!out) return { ok: false, hops, reason: 'noroute' };
      if (out.iface && !this.aclPermits(cur, out.iface, 'out', src)) return { ok: false, hops, reason: 'acl' };
      const peer = this.eps.find((e) => e.dom === out.dom && e.ip === nh && e.dev !== cur.name);
      if (!peer) return { ok: false, hops, reason: r.code === 'C' ? 'arp' : 'nexthop' };
      hops.push(peer.ip);
      cur = this.dev[peer.dev]; inIf = peer.iface;
    }
    return { ok: false, hops, reason: 'ttl' };
  }
  // Source address a device uses toward dst (its egress interface address).
  srcFor(d, dst) {
    if (d.platform === 'host' || d.platform === 'windows') return d.ip;
    const r = this.lookup(d, dst); if (!r) return null;
    return this.egress(d, r, r.code === 'C' || !r.via ? dst : r.via)?.ip || null;
  }
  // The endpoint a packet leaves from: the route's exit interface, else the one sharing a subnet with the next hop.
  egress(d, r, nh) {
    if (r.iface && r.code !== 'C') return this.eps.find((e) => e.dev === d.name && e.iface === r.iface) || null;
    return this.eps.find((e) => e.dev === d.name && e.ip && inNet(nh, e.ip, e.mask)) || null;
  }
  ping(fromName, dst) {
    const d = this.dev[fromName];
    if (this.owns(d, dst)) return { ok: true, hops: [] };
    const src = this.srcFor(d, dst);
    if (!src) return { ok: false, reason: 'noroute', hops: [] };
    const there = this.trip(fromName, src, dst);
    if (!there.ok) return there;
    const owner = Object.values(this.dev).find((x) => this.owns(x, dst));
    const back = this.trip(owner.name, dst, src);
    return back.ok ? { ok: true, hops: there.hops } : { ok: false, hops: there.hops, reason: 'return' };
  }
}

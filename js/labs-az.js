// Azure CLI simulator for AZ-104 labs. Models one subscription in memory: resource groups,
// virtual networks and subnets, NSGs and rules, VNet peering, storage accounts and
// containers, role assignments, virtual machines and disks, and resource locks. Commands
// validate like the real CLI (required arguments, address overlaps, naming rules).
import { ip2n } from './labs-net.js';

const LOCATIONS = ['eastus', 'eastus2', 'centralus', 'westus2', 'westus3', 'northcentralus', 'southcentralus', 'canadacentral', 'northeurope', 'westeurope', 'uksouth', 'australiaeast', 'japaneast', 'southeastasia'];
const ROLES = ['Owner', 'Contributor', 'Reader', 'User Access Administrator', 'Virtual Machine Contributor', 'Network Contributor',
  'Storage Account Contributor', 'Storage Blob Data Reader', 'Storage Blob Data Contributor', 'Storage Blob Data Owner', 'Backup Operator', 'Monitoring Reader'];
const SKUS = ['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS', 'Standard_GZRS', 'Standard_RAGZRS', 'Premium_LRS', 'Premium_ZRS'];
const SIZES = ['Standard_DS1_v2', 'Standard_B1s', 'Standard_B1ms', 'Standard_B2s', 'Standard_B2ms', 'Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_D8s_v5', 'Standard_E2s_v5', 'Standard_E4s_v5', 'Standard_F2s_v2'];
const IMAGES = ['Ubuntu2204', 'Ubuntu2404', 'Debian12', 'Win2022Datacenter', 'Win2025Datacenter', 'Win2019Datacenter', 'RHELRaw8LVMGen2'];

export function newAz(def) {
  const s = {
    name: def.name || 'cloud', platform: 'az', sub: { id: '6f1c2a9e-3b4d-4e5f-9a8b-7c6d5e4f3a21', name: def.subscription || 'Contoso-Lab' },
    principals: def.principals || [], takenStorage: def.takenStorage || ['storage', 'test', 'contoso'],
    rgs: {}, vnets: {}, nsgs: {}, storage: {}, roles: [], vms: {}, locks: [], disks: {},
  };
  for (const [k, v] of Object.entries(def.state || {})) s[k] = typeof v === 'object' && !Array.isArray(v) ? { ...s[k], ...v } : v;
  return s;
}

class AzError extends Error {}
const cidr = (c) => { const m = String(c).match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/); if (!m || ip2n(m[1]) === null || +m[2] > 32) return null;
  const bits = +m[2]; const mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0; return { net: (ip2n(m[1]) & mask) >>> 0, bits, aligned: ((ip2n(m[1]) & mask) >>> 0) === ip2n(m[1]) }; };
const within = (inner, outer) => inner.bits >= outer.bits && ((inner.net & (outer.bits ? (0xffffffff << (32 - outer.bits)) >>> 0 : 0)) >>> 0) === outer.net;
const overlap = (a, b) => within(a, b) || within(b, a);
const bool = (v) => (v === undefined ? undefined : /^(true|yes|1)$/i.test(v));

function tokenize(s) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (const ch of s.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

export class AzSession {
  constructor(state, opts = {}) { this.s = state; this.opts = opts; this.history = []; }
  prompt() { return 'student@cloudshell:~$ '; }
  complete(line) { return line; }
  run(raw) {
    const line = raw.trim(); if (!line) return '';
    this.history.push(line);
    const t = tokenize(line);
    if (t[0] === 'clear') { this.opts.clear?.(); return ''; }
    if (t[0] !== 'az') return t[0] === 'help' ? 'Run Azure CLI commands starting with "az", for example: az group list -o table' : `bash: ${t[0]}: command not found`;
    try { const r = this.exec(t.slice(1)); this.opts.onChange?.(); return r; } catch (e) { if (e instanceof AzError) return `ERROR: ${e.message}`; throw e; }
  }
  // Split "network vnet subnet create --name x -g y" into words and options.
  parse(argv) {
    const words = []; const o = {}; let i = 0;
    while (i < argv.length && !argv[i].startsWith('-')) words.push(argv[i++]);
    while (i < argv.length) {
      const k = argv[i++];
      if (!k.startsWith('-')) throw new AzError(`unrecognized arguments: ${k}`);
      const vals = []; while (i < argv.length && !argv[i].startsWith('--') && !(argv[i].startsWith('-') && argv[i].length === 2 && /[a-z]/i.test(argv[i][1]))) vals.push(argv[i++]);
      o[k] = vals.length === 0 ? 'true' : vals.length === 1 ? vals[0] : vals;
    }
    return { words, o };
  }
  get(o, names, required, label) {
    for (const n of names) if (o[n] !== undefined) return o[n];
    if (required) throw new AzError(`the following arguments are required: ${label || names.join('/')}`);
    return undefined;
  }
  rg(o) {
    const g = this.get(o, ['-g', '--resource-group'], true, '--resource-group/-g');
    if (!this.s.rgs[g]) throw new AzError(`(ResourceGroupNotFound) Resource group '${g}' could not be found.`);
    return g;
  }
  loc(o, rg) {
    const l = (this.get(o, ['-l', '--location']) || this.s.rgs[rg]?.location || 'eastus').toLowerCase();
    if (!LOCATIONS.includes(l)) throw new AzError(`(LocationNotAvailableForResourceGroup) The provided location '${l}' is not available for resource group. List of available regions is '${LOCATIONS.join(',')}'.`);
    return l;
  }
  locked(rg, kind) { return this.s.locks.some((l) => l.rg === rg && (kind === 'delete' ? true : l.level === 'ReadOnly')); }
  id(rg, type, name) { return `/subscriptions/${this.s.sub.id}/resourceGroups/${rg}/providers/${type}/${name}`; }
  json(x) { return JSON.stringify(x, null, 2); }
  table(rows, cols) {
    if (!rows.length) return '';
    const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
    return [cols.map((c, i) => c.padEnd(w[i])).join('  '), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map((r) => cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '))].join('\n');
  }
  out(o, rows, cols) { return o['-o'] === 'table' || o['--output'] === 'table' ? this.table(rows, cols) : this.json(rows); }
  prefixes(o, names) { const v = this.get(o, names); return v === undefined ? undefined : Array.isArray(v) ? v : [v]; }

  exec(argv) {
    const { words, o } = this.parse(argv); const cmd = words.join(' ');
    const S = this.s;
    switch (cmd) {
      case 'login': return 'You are already signed in to Cloud Shell.';
      case 'account show': return this.json({ id: S.sub.id, name: S.sub.name, state: 'Enabled', isDefault: true, user: { name: 'student@contoso.com', type: 'user' } });
      case 'group create': {
        const n = this.get(o, ['-n', '--name'], true, '--name/--resource-group/-n/-g'); const l = this.loc(o);
        S.rgs[n] = { location: l, tags: tags(o) || S.rgs[n]?.tags || {} };
        return this.json({ id: `/subscriptions/${S.sub.id}/resourceGroups/${n}`, location: l, name: n, properties: { provisioningState: 'Succeeded' }, tags: S.rgs[n].tags });
      }
      case 'group list': return this.out(o, Object.entries(S.rgs).map(([n, g]) => ({ Name: n, Location: g.location, Status: 'Succeeded' })), ['Name', 'Location', 'Status']);
      case 'group show': { const n = this.get(o, ['-n', '--name'], true); if (!S.rgs[n]) throw new AzError(`(ResourceGroupNotFound) Resource group '${n}' could not be found.`); return this.json({ name: n, ...S.rgs[n] }); }
      case 'group update': {
        const n = this.get(o, ['-n', '--name'], true); if (!S.rgs[n]) throw new AzError(`(ResourceGroupNotFound) Resource group '${n}' could not be found.`);
        const t = tags(o) || setTags(o); if (t) S.rgs[n].tags = { ...(o['--tags'] ? {} : S.rgs[n].tags), ...t };
        return this.json({ name: n, ...S.rgs[n] });
      }
      case 'group delete': {
        const n = this.get(o, ['-n', '--name'], true);
        if (!S.rgs[n]) throw new AzError(`(ResourceGroupNotFound) Resource group '${n}' could not be found.`);
        if (this.locked(n, 'delete')) throw new AzError(`(ScopeLocked) The scope '/subscriptions/${S.sub.id}/resourceGroups/${n}' cannot perform delete operation because following scope(s) are locked: '/subscriptions/${S.sub.id}/resourceGroups/${n}'. Please remove the lock and try again.`);
        if (o['--yes'] === undefined && o['-y'] === undefined) return 'Are you sure you want to perform this operation? (y/n): (add --yes to confirm in this lab)';
        delete S.rgs[n];
        for (const coll of ['vnets', 'nsgs', 'storage', 'vms']) for (const [k, v] of Object.entries(S[coll])) if (v.rg === n) delete S[coll][k];
        return '';
      }
      case 'network vnet create': {
        const g = this.rg(o); const n = this.get(o, ['-n', '--name'], true, '--name/-n'); const l = this.loc(o, g);
        if (this.locked(g)) throw new AzError(`(ScopeLocked) The scope cannot perform write operation because the resource group '${g}' is read-only locked.`);
        const pf = this.prefixes(o, ['--address-prefixes', '--address-prefix']) || ['10.0.0.0/16'];
        for (const p of pf) { const c = cidr(p); if (!c || !c.aligned) throw new AzError(`(InvalidAddressPrefixFormat) Address prefix ${p} has an invalid format.`); }
        S.vnets[n] = { rg: g, location: l, prefixes: pf, subnets: {}, peerings: {} };
        const sn = this.get(o, ['--subnet-name']);
        if (sn) this.addSubnet(n, sn, (this.prefixes(o, ['--subnet-prefixes', '--subnet-prefix']) || [pf[0].replace(/\/\d+$/, '/24')])[0]);
        return this.json({ newVNet: { name: n, location: l, addressSpace: { addressPrefixes: pf }, subnets: Object.entries(S.vnets[n].subnets).map(([k, v]) => ({ name: k, addressPrefix: v.prefix })), provisioningState: 'Succeeded' } });
      }
      case 'network vnet list': return this.out(o, Object.entries(S.vnets).filter(([, v]) => !o['-g'] || v.rg === o['-g']).map(([n, v]) => ({ Name: n, ResourceGroup: v.rg, Location: v.location, AddressPrefixes: v.prefixes.join(', ') })), ['Name', 'ResourceGroup', 'Location', 'AddressPrefixes']);
      case 'network vnet show': { this.rg(o); const n = this.vnet(this.get(o, ['-n', '--name'], true)); return this.json({ name: n, ...S.vnets[n] }); }
      case 'network vnet subnet create': {
        this.rg(o); const v = this.vnet(this.get(o, ['--vnet-name'], true, '--vnet-name')); const n = this.get(o, ['-n', '--name'], true, '--name/-n');
        const p = (this.prefixes(o, ['--address-prefixes', '--address-prefix']) || [])[0];
        if (!p) throw new AzError('the following arguments are required: --address-prefixes');
        this.addSubnet(v, n, p);
        const nsg = this.get(o, ['--network-security-group', '--nsg']); if (nsg) S.vnets[v].subnets[n].nsg = this.nsg(nsg);
        return this.json({ name: n, addressPrefix: p, networkSecurityGroup: S.vnets[v].subnets[n].nsg ? { id: this.id(S.vnets[v].rg, 'Microsoft.Network/networkSecurityGroups', S.vnets[v].subnets[n].nsg) } : null, provisioningState: 'Succeeded' });
      }
      case 'network vnet subnet update': {
        this.rg(o); const v = this.vnet(this.get(o, ['--vnet-name'], true, '--vnet-name')); const n = this.get(o, ['-n', '--name'], true);
        const sn = S.vnets[v].subnets[n]; if (!sn) throw new AzError(`(NotFound) Subnet '${n}' not found in virtual network '${v}'.`);
        const nsg = this.get(o, ['--network-security-group', '--nsg']); if (nsg !== undefined) sn.nsg = nsg === '' || nsg === 'null' ? null : this.nsg(nsg);
        return this.json({ name: n, addressPrefix: sn.prefix, networkSecurityGroup: sn.nsg ? { id: this.id(S.vnets[v].rg, 'Microsoft.Network/networkSecurityGroups', sn.nsg) } : null });
      }
      case 'network vnet subnet list': { this.rg(o); const v = this.vnet(this.get(o, ['--vnet-name'], true)); return this.out(o, Object.entries(S.vnets[v].subnets).map(([n, x]) => ({ Name: n, AddressPrefix: x.prefix, NSG: x.nsg || '' })), ['Name', 'AddressPrefix', 'NSG']); }
      case 'network vnet peering create': {
        this.rg(o); const v = this.vnet(this.get(o, ['--vnet-name'], true, '--vnet-name')); const n = this.get(o, ['-n', '--name'], true, '--name/-n');
        const remote = this.vnet(String(this.get(o, ['--remote-vnet'], true, '--remote-vnet')).split('/').pop());
        if (remote === v) throw new AzError('A virtual network cannot be peered with itself.');
        for (const a of S.vnets[v].prefixes) for (const b of S.vnets[remote].prefixes) if (overlap(cidr(a), cidr(b))) throw new AzError(`(VnetAddressSpacesOverlap) Cannot create or update peering ${n} because address space of virtual network ${v} overlaps with address space of virtual network ${remote}.`);
        S.vnets[v].peerings[n] = { remote, allowVnetAccess: bool(o['--allow-vnet-access']) ?? true, allowForwardedTraffic: !!bool(o['--allow-forwarded-traffic']), allowGatewayTransit: !!bool(o['--allow-gateway-transit']), useRemoteGateways: !!bool(o['--use-remote-gateways']) };
        const back = Object.values(S.vnets[remote].peerings).some((p) => p.remote === v);
        return this.json({ name: n, peeringState: back ? 'Connected' : 'Initiated', remoteVirtualNetwork: { id: this.id(S.vnets[remote].rg, 'Microsoft.Network/virtualNetworks', remote) }, ...S.vnets[v].peerings[n] });
      }
      case 'network vnet peering list': { this.rg(o); const v = this.vnet(this.get(o, ['--vnet-name'], true)); return this.out(o, Object.entries(S.vnets[v].peerings).map(([n, p]) => ({ Name: n, Remote: p.remote, PeeringState: Object.values(S.vnets[p.remote]?.peerings || {}).some((x) => x.remote === v) ? 'Connected' : 'Initiated', AllowForwardedTraffic: p.allowForwardedTraffic })), ['Name', 'Remote', 'PeeringState', 'AllowForwardedTraffic']); }
      case 'network nsg create': {
        const g = this.rg(o); const n = this.get(o, ['-n', '--name'], true, '--name/-n'); const l = this.loc(o, g);
        S.nsgs[n] = { rg: g, location: l, rules: [] };
        return this.json({ NewNSG: { name: n, location: l, securityRules: [], defaultSecurityRules: ['AllowVnetInBound', 'AllowAzureLoadBalancerInBound', 'DenyAllInBound', 'AllowVnetOutBound', 'AllowInternetOutBound', 'DenyAllOutBound'].map((x) => ({ name: x })) } });
      }
      case 'network nsg rule create': {
        this.rg(o); const nsg = this.nsg(this.get(o, ['--nsg-name'], true, '--nsg-name')); const n = this.get(o, ['-n', '--name'], true, '--name/-n');
        const pr = +this.get(o, ['--priority'], true, '--priority');
        if (!(pr >= 100 && pr <= 4096)) throw new AzError(`(SecurityRuleInvalidPriority) Security rule has invalid Priority. Value provided: ${pr} Allowed range 100-4096.`);
        if (S.nsgs[nsg].rules.some((r) => r.priority === pr && r.direction === (this.get(o, ['--direction']) || 'Inbound') && r.name !== n)) throw new AzError(`(SecurityRuleConflict) Security rule conflicts with another rule that has the same Priority (${pr}) and Direction.`);
        const arr = (x) => (x === undefined ? undefined : Array.isArray(x) ? x : [x]);
        const rule = { name: n, priority: pr, direction: cap(this.get(o, ['--direction']) || 'Inbound'), access: cap(this.get(o, ['--access']) || 'Allow'),
          protocol: protoName(this.get(o, ['--protocol']) || '*'), sourcePrefixes: arr(this.get(o, ['--source-address-prefixes', '--source-address-prefix'])) || ['*'],
          sourcePorts: arr(this.get(o, ['--source-port-ranges', '--source-port-range'])) || ['*'],
          destinationPrefixes: arr(this.get(o, ['--destination-address-prefixes', '--destination-address-prefix'])) || ['*'],
          destinationPorts: arr(this.get(o, ['--destination-port-ranges', '--destination-port-range'])) || ['80'] };
        S.nsgs[nsg].rules = S.nsgs[nsg].rules.filter((r) => r.name !== n).concat(rule);
        return this.json({ ...rule, provisioningState: 'Succeeded' });
      }
      case 'network nsg rule list': { this.rg(o); const nsg = this.nsg(this.get(o, ['--nsg-name'], true)); return this.out(o, S.nsgs[nsg].rules.map((r) => ({ Name: r.name, Priority: r.priority, Direction: r.direction, Access: r.access, Protocol: r.protocol, Source: r.sourcePrefixes.join(','), DestPorts: r.destinationPorts.join(',') })), ['Name', 'Priority', 'Direction', 'Access', 'Protocol', 'Source', 'DestPorts']); }
      case 'network nsg rule delete': { this.rg(o); const nsg = this.nsg(this.get(o, ['--nsg-name'], true)); const n = this.get(o, ['-n', '--name'], true); S.nsgs[nsg].rules = S.nsgs[nsg].rules.filter((r) => r.name !== n); return ''; }
      case 'storage account create': case 'storage account update': {
        const g = this.rg(o); const n = this.get(o, ['-n', '--name'], true, '--name/-n');
        const exists = !!S.storage[n];
        if (cmd.endsWith('update') && !exists) throw new AzError(`(ResourceNotFound) The Resource 'Microsoft.Storage/storageAccounts/${n}' under resource group '${g}' was not found.`);
        if (!exists) {
          if (!/^[a-z0-9]{3,24}$/.test(n)) throw new AzError(`(AccountNameInvalid) ${n} is not a valid storage account name. Storage account name must be between 3 and 24 characters in length and use numbers and lower-case letters only.`);
          if (S.takenStorage.includes(n)) throw new AzError(`(StorageAccountAlreadyTaken) The storage account named ${n} is already taken.`);
        }
        const sku = this.get(o, ['--sku']);
        if (sku && !SKUS.includes(sku)) throw new AzError(`argument --sku: invalid choice: '${sku}' (choose from ${SKUS.map((x) => `'${x}'`).join(', ')})`);
        const a = S.storage[n] ||= { rg: g, location: this.loc(o, g), sku: 'Standard_RAGRS', kind: 'StorageV2', httpsOnly: true, minTls: 'TLS1_0', publicBlob: true, accessTier: 'Hot', containers: {} };
        if (sku) a.sku = sku;
        const kind = this.get(o, ['--kind']); if (kind) a.kind = kind;
        const https = bool(this.get(o, ['--https-only'])); if (https !== undefined) a.httpsOnly = https;
        const tls = this.get(o, ['--min-tls-version']); if (tls) { if (!['TLS1_0', 'TLS1_1', 'TLS1_2', 'TLS1_3'].includes(tls)) throw new AzError(`argument --min-tls-version: invalid choice: '${tls}'`); a.minTls = tls; }
        const pub = bool(this.get(o, ['--allow-blob-public-access'])); if (pub !== undefined) a.publicBlob = pub;
        const tier = this.get(o, ['--access-tier']); if (tier) a.accessTier = tier;
        return this.json({ name: n, location: a.location, sku: { name: a.sku }, kind: a.kind, enableHttpsTrafficOnly: a.httpsOnly, minimumTlsVersion: a.minTls, allowBlobPublicAccess: a.publicBlob, accessTier: a.accessTier, provisioningState: 'Succeeded' });
      }
      case 'storage account show': { const n = this.get(o, ['-n', '--name'], true); const a = S.storage[n]; if (!a) throw new AzError(`(ResourceNotFound) The Resource 'Microsoft.Storage/storageAccounts/${n}' was not found.`);
        return this.json({ name: n, sku: { name: a.sku }, kind: a.kind, enableHttpsTrafficOnly: a.httpsOnly, minimumTlsVersion: a.minTls, allowBlobPublicAccess: a.publicBlob }); }
      case 'storage account list': return this.out(o, Object.entries(S.storage).map(([n, a]) => ({ Name: n, ResourceGroup: a.rg, Kind: a.kind, Sku: a.sku, MinTls: a.minTls })), ['Name', 'ResourceGroup', 'Kind', 'Sku', 'MinTls']);
      case 'storage container create': {
        const acct = this.get(o, ['--account-name'], true, '--account-name'); const n = this.get(o, ['-n', '--name'], true, '--name/-n');
        const a = S.storage[acct]; if (!a) throw new AzError(`The specified account ${acct} does not exist.`);
        if (!/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(n)) throw new AzError('The specifed resource name contains invalid characters.');
        const access = this.get(o, ['--public-access']) || 'off';
        if (access !== 'off' && !a.publicBlob) throw new AzError('(PublicAccessNotPermitted) Public access is not permitted on this storage account.');
        a.containers[n] = { publicAccess: access };
        return this.json({ created: true });
      }
      case 'role assignment create': {
        const who = this.get(o, ['--assignee', '--assignee-object-id'], true, '--assignee'); const role = this.get(o, ['--role'], true, '--role');
        if (!ROLES.includes(role)) throw new AzError(`Role '${role}' doesn't exist.`);
        if (!this.s.principals.includes(who)) throw new AzError(`Cannot find user or service principal in graph database for '${who}'. If the assignee is an appId, make sure the corresponding service principal is created with 'az ad sp create --id ${who}'.`);
        const scope = this.scope(o);
        if (!this.s.roles.some((r) => r.assignee === who && r.role === role && r.scope === scope)) this.s.roles.push({ assignee: who, role, scope });
        return this.json({ principalName: who, roleDefinitionName: role, scope });
      }
      case 'role assignment list': {
        const who = this.get(o, ['--assignee']); const g = this.get(o, ['-g', '--resource-group']);
        const rows = this.s.roles.filter((r) => (!who || r.assignee === who) && (!g || r.scope.endsWith(`/resourceGroups/${g}`) || r.scope.includes(`/resourceGroups/${g}/`)));
        return this.out(o, rows.map((r) => ({ Principal: r.assignee, Role: r.role, Scope: r.scope })), ['Principal', 'Role', 'Scope']);
      }
      case 'role assignment delete': {
        const who = this.get(o, ['--assignee'], true); const role = this.get(o, ['--role']); const scope = o['--scope'] || o['-g'] || o['--resource-group'] ? this.scope(o) : null;
        const before = this.s.roles.length;
        this.s.roles = this.s.roles.filter((r) => !(r.assignee === who && (!role || r.role === role) && (!scope || r.scope === scope)));
        if (before === this.s.roles.length) throw new AzError('No matched assignments were found to delete');
        return '';
      }
      case 'role definition list': return this.out(o, ROLES.map((r) => ({ RoleName: r })), ['RoleName']);
      case 'ad user list': return this.out(o, this.s.principals.filter((p) => p.includes('@')).map((p) => ({ UserPrincipalName: p })), ['UserPrincipalName']);
      case 'vm create': {
        const g = this.rg(o); const n = this.get(o, ['-n', '--name'], true, '--name/-n');
        const image = this.get(o, ['--image'], true, '--image'); if (!IMAGES.includes(image)) throw new AzError(`Invalid image "${image}". Use a URN or an alias such as: ${IMAGES.join(', ')}`);
        const size = this.get(o, ['--size']) || 'Standard_DS1_v2'; if (!SIZES.includes(size)) throw new AzError(`(InvalidParameter) The requested VM size ${size} is not available in this lab. Try: ${SIZES.join(', ')}`);
        const vnet = this.get(o, ['--vnet-name']); const subnet = this.get(o, ['--subnet']);
        if (vnet) { this.vnet(vnet); if (subnet && !S.vnets[vnet].subnets[subnet]) throw new AzError(`(NotFound) Subnet ${subnet} not found in ${vnet}.`); }
        const pip = this.get(o, ['--public-ip-address']); const nsg = this.get(o, ['--nsg']);
        if (/^Win/.test(image) && !this.get(o, ['--admin-username'])) throw new AzError('Please specify --admin-username and --admin-password for Windows VMs.');
        S.vms[n] = { rg: g, location: this.loc(o, g), image, size, vnet: vnet || `${n}VNET`, subnet: subnet || `${n}Subnet`, publicIp: pip === '' ? null : `${n}PublicIP`, nsg: nsg === '' ? null : `${n}NSG`, power: 'running', zone: this.get(o, ['--zone']) || null, dataDisks: [] };
        return this.json({ id: this.id(g, 'Microsoft.Compute/virtualMachines', n), location: S.vms[n].location, powerState: 'VM running', privateIpAddress: '10.0.1.4', publicIpAddress: S.vms[n].publicIp ? '20.62.14.88' : '', resourceGroup: g });
      }
      case 'vm list': return this.out(o, Object.entries(S.vms).map(([n, v]) => ({ Name: n, ResourceGroup: v.rg, Location: v.location, Size: v.size, Power: v.power })), ['Name', 'ResourceGroup', 'Location', 'Size', 'Power']);
      case 'vm show': { this.rg(o); const n = this.vm(this.get(o, ['-n', '--name'], true)); return this.json({ name: n, ...S.vms[n] }); }
      case 'vm resize': { this.rg(o); const n = this.vm(this.get(o, ['-n', '--name'], true)); const size = this.get(o, ['--size'], true, '--size');
        if (!SIZES.includes(size)) throw new AzError(`(InvalidParameter) The requested VM size ${size} is not available in this lab.`); S.vms[n].size = size; return this.json({ name: n, hardwareProfile: { vmSize: size } }); }
      case 'vm deallocate': case 'vm stop': case 'vm start': { this.rg(o); const n = this.vm(this.get(o, ['-n', '--name'], true)); S.vms[n].power = words[1] === 'start' ? 'running' : words[1] === 'stop' ? 'stopped' : 'deallocated'; return ''; }
      case 'vm disk attach': {
        this.rg(o); const n = this.vm(this.get(o, ['--vm-name'], true, '--vm-name')); const d = this.get(o, ['--name', '-n'], true, '--name');
        if (o['--new'] === undefined && !S.disks[d]) throw new AzError(`(ResourceNotFound) Disk ${d} not found. Use --new to create one.`);
        const size = +(this.get(o, ['--size-gb', '-z']) || 0); if (o['--new'] !== undefined && !size) throw new AzError('usage error: --size-gb required to create an empty disk for attach');
        S.vms[n].dataDisks.push({ name: d, sizeGb: size || S.disks[d]?.sizeGb, sku: this.get(o, ['--sku']) || 'Premium_LRS', lun: S.vms[n].dataDisks.length });
        return '';
      }
      case 'lock create': {
        const n = this.get(o, ['-n', '--name'], true, '--name/-n'); const level = this.get(o, ['--lock-type', '-t'], true, '--lock-type');
        if (!['CanNotDelete', 'ReadOnly'].includes(level)) throw new AzError(`argument --lock-type/-t: invalid choice: '${level}' (choose from 'CanNotDelete', 'ReadOnly')`);
        const g = this.rg(o); S.locks = S.locks.filter((l) => !(l.name === n && l.rg === g)).concat({ name: n, level, rg: g, notes: this.get(o, ['--notes']) || '' });
        return this.json({ name: n, level, notes: this.get(o, ['--notes']) || null });
      }
      case 'lock list': return this.out(o, S.locks.map((l) => ({ Name: l.name, Level: l.level, ResourceGroup: l.rg })), ['Name', 'Level', 'ResourceGroup']);
      case 'lock delete': { const n = this.get(o, ['-n', '--name'], true); const g = this.rg(o); S.locks = S.locks.filter((l) => !(l.name === n && l.rg === g)); return ''; }
      case '': case 'help': return 'Group\n    az\n\nSubgroups used in these labs:\n    account, group, network vnet, network vnet subnet, network vnet peering, network nsg, network nsg rule,\n    storage account, storage container, role assignment, vm, vm disk, lock';
      default:
        throw new AzError(`'${words.join(' ')}' is misspelled or not recognized by the system. Run 'az help' to see the command groups available in this lab.`);
    }
  }
  scope(o) {
    const sc = this.get(o, ['--scope']); const g = this.get(o, ['-g', '--resource-group']);
    if (sc) {
      const m = sc.match(/^\/subscriptions\/([^/]+)(\/resourceGroups\/([^/]+))?/i);
      if (!m || m[1] !== this.s.sub.id) throw new AzError(`Invalid scope '${sc}'. Use /subscriptions/${this.s.sub.id}/resourceGroups/<name> or -g <name>.`);
      if (m[3] && !this.s.rgs[m[3]]) throw new AzError(`(ResourceGroupNotFound) Resource group '${m[3]}' could not be found.`);
      return sc.replace(/\/$/, '');
    }
    if (g) { if (!this.s.rgs[g]) throw new AzError(`(ResourceGroupNotFound) Resource group '${g}' could not be found.`); return `/subscriptions/${this.s.sub.id}/resourceGroups/${g}`; }
    return `/subscriptions/${this.s.sub.id}`;
  }
  vnet(n) { if (!this.s.vnets[n]) throw new AzError(`(ResourceNotFound) The Resource 'Microsoft.Network/virtualNetworks/${n}' was not found.`); return n; }
  nsg(n) { if (!this.s.nsgs[n]) throw new AzError(`(ResourceNotFound) The Resource 'Microsoft.Network/networkSecurityGroups/${n}' was not found.`); return n; }
  vm(n) { if (!this.s.vms[n]) throw new AzError(`(ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachines/${n}' was not found.`); return n; }
  addSubnet(v, n, p) {
    const c = cidr(p); if (!c || !c.aligned) throw new AzError(`(InvalidAddressPrefixFormat) Address prefix ${p} has an invalid format.`);
    const vn = this.s.vnets[v];
    if (!vn.prefixes.some((x) => within(c, cidr(x)))) throw new AzError(`(NetcfgSubnetRangeOutsideVnet) Subnet '${n}' is not valid because its IP address range is outside the IP address range of virtual network '${v}'.`);
    for (const [k, s] of Object.entries(vn.subnets)) if (k !== n && overlap(c, cidr(s.prefix))) throw new AzError(`(NetcfgInvalidSubnet) Subnet '${n}' is not valid in virtual network '${v}' because it overlaps with subnet '${k}'.`);
    vn.subnets[n] = { prefix: p, nsg: vn.subnets[n]?.nsg || null };
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const protoName = (p) => ({ tcp: 'Tcp', udp: 'Udp', icmp: 'Icmp', '*': '*', any: '*' }[String(p).toLowerCase()] || p);
function tags(o) {
  const t = o['--tags']; if (t === undefined) return null;
  const list = Array.isArray(t) ? t : [t]; const out = {};
  for (const kv of list) { const [k, ...v] = kv.split('='); if (k) out[k] = v.join('='); }
  return out;
}
function setTags(o) {
  const s = o['--set']; if (!s) return null; const list = Array.isArray(s) ? s : [s]; const out = {};
  for (const kv of list) { const m = kv.match(/^tags\.([^=]+)=(.*)$/); if (m) out[m[1]] = m[2]; }
  return Object.keys(out).length ? out : null;
}

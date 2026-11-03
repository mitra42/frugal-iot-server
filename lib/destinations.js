/*
 * Where this server may be told to connect.
 *
 * An organization's administrator chooses the address a forwarder sends to, and it is this server
 * that connects, from inside whatever network it sits in. So an address is judged by what it IS, not
 * by how it is spelled: a list of bad names loses to the many ways of writing the same address
 * (IPv4 inside IPv6, a trailing dot, a name that resolves somewhere private).
 *
 *   private, link-local (where cloud metadata lives), shared, reserved, multicast - refused
 *   loopback - allowed, but only on a port the caller names (OpenSearch's 9200), not the server's own
 *              other services; not for Google Sheets at all
 *   public - allowed
 *
 * A name is resolved, and refused if ANY of its addresses is refused. This is checked when a forwarder
 * is saved. A name that resolves somewhere else later (DNS rebinding) is not caught by it, and the
 * reply to a forwarder's request is never shown to the browser - so this limits what an administrator
 * can reach and probe, but is not a replacement for the machine's own firewall.
 */

import net from 'net';
import dns from 'dns';

// Names that mean "the cloud's metadata service", whatever they resolve to
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);

// 16 bytes of an IPv6 address, or null. Handles "::" and a trailing dotted IPv4.
function ipv6Bytes(ip) {
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

// 'public', 'loopback', or 'refused' for an IPv4 or IPv6 address (no brackets)
export function classifyAddress(address) {
  let a = String(address).replace(/^\[|\]$/g, '');
  let o;
  if (net.isIPv4(a)) {
    o = a.split('.').map(Number);
  } else if (net.isIPv6(a)) {
    const b = ipv6Bytes(a.split('%')[0]);
    if (!b) return 'refused';
    const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255; // ::ffff:a.b.c.d
    if (mapped) { o = b.slice(12); }
    else {
      if (b.every((x) => x === 0)) return 'refused';                                       // ::
      if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return 'loopback';          // ::1
      if ((b[0] & 0xfe) === 0xfc) return 'refused';                                        // fc00::/7 unique local
      if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'refused';                       // fe80::/10 link-local
      if (b[0] === 0xff) return 'refused';                                                 // multicast
      if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return 'refused'; // 64:ff9b::/96 NAT64
      if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'refused'; // documentation
      return 'public';
    }
  } else {
    return 'refused'; // not an address at all
  }
  const [a0, a1] = o;
  if (a0 === 127) return 'loopback';
  if (a0 === 0 || a0 === 10) return 'refused';
  if (a0 === 100 && a1 >= 64 && a1 <= 127) return 'refused';              // 100.64/10 shared
  if (a0 === 169 && a1 === 254) return 'refused';                         // link-local, cloud metadata
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return 'refused';
  if (a0 === 192 && a1 === 168) return 'refused';
  if (a0 === 192 && a1 === 0 && o[2] === 0) return 'refused';            // 192.0.0.0/24
  if (a0 === 198 && (a1 === 18 || a1 === 19)) return 'refused';          // benchmarking
  if (a0 >= 224) return 'refused';                                        // multicast and reserved
  return 'public';
}

// The host of a URL as it should be judged: lower case, no brackets, no trailing dot
export function hostOf(urlString) {
  try { return new URL(urlString).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase(); }
  catch { return ''; }
}

// Is this URL's host an address on this machine? "localhost" or a loopback address, however written.
export function isLoopbackUrl(urlString) {
  const h = hostOf(urlString);
  return h === 'localhost' || (net.isIP(h) !== 0 && classifyAddress(h) === 'loopback');
}

// null if the URL may be connected to, otherwise why not.
//   loopbackPorts   ports on this machine that may be used, e.g. [9200]. Empty: nothing on this machine.
//   lookup          dns.promises.lookup, replaceable for tests
export async function checkDestination(urlString, { loopbackPorts = [], lookup = dns.promises.lookup } = {}) {
  let u;
  try { u = new URL(urlString); } catch { return 'is not a valid URL'; }
  const host = hostOf(urlString);
  if (!host) return 'has no host';
  if (METADATA_NAMES.has(host)) return 'points somewhere that is not allowed';
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  let addresses;
  if (net.isIP(host)) { addresses = [host]; }
  else {
    try { addresses = (await lookup(host, { all: true })).map((r) => r.address); }
    catch { return 'is a host that could not be found'; }
    if (!addresses.length) return 'is a host that could not be found';
  }
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === 'refused') return 'points somewhere that is not allowed';
    if (kind === 'loopback' && !loopbackPorts.includes(port)) {
      return loopbackPorts.length
        ? `may only use this machine on port ${loopbackPorts.join(' or ')}`
        : 'may not point at this machine';
    }
  }
  return null;
}

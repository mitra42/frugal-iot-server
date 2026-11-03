/*
 * Where a forwarder may connect. The point is that an address is judged by what it is, so each test
 * is a way of writing an address the previous check (a list of bad spellings) let through.
 */
import { describe, it, expect } from 'vitest';
import { classifyAddress, checkDestination, isLoopbackUrl, hostOf } from '../../lib/destinations.js';

const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address }));
const notFound = async () => { throw new Error('ENOTFOUND'); };

describe('classifyAddress', () => {
  it('refuses private, shared, link-local, reserved and multicast IPv4', () => {
    for (const a of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.100.100.200',
      '169.254.169.254', '0.0.0.0', '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
      expect(classifyAddress(a), a).toBe('refused');
    }
  });
  it('knows the edges: 172.15 and 172.32 are public, 100.63 and 100.128 are public', () => {
    for (const a of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '8.8.8.8', '1.1.1.1']) {
      expect(classifyAddress(a), a).toBe('public');
    }
  });
  it('sees IPv4 hidden in IPv6, however it is written', () => {
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('refused');
    expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('refused');
    expect(classifyAddress('[::ffff:a9fe:a9fe]')).toBe('refused');
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('refused');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAddress('::ffff:8.8.8.8')).toBe('public');
  });
  it('handles IPv6 loopback, unspecified, unique-local, link-local, multicast and NAT64', () => {
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('0:0:0:0:0:0:0:1')).toBe('loopback');
    for (const a of ['::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '64:ff9b::1.2.3.4', '2001:db8::1']) {
      expect(classifyAddress(a), a).toBe('refused');
    }
    expect(classifyAddress('2606:4700:4700::1111')).toBe('public');
  });
  it('refuses what is not an address', () => {
    for (const a of ['', 'localhost', 'example.org', '1.2.3', '1.2.3.4.5', ':::', 'zz::1']) expect(classifyAddress(a), a).toBe('refused');
  });
  it('treats all of 127/8 as loopback', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('127.255.255.254')).toBe('loopback');
  });
});

describe('hostOf and isLoopbackUrl', () => {
  it('normalises the odd spellings first', () => {
    expect(hostOf('http://metadata.google.internal./x')).toBe('metadata.google.internal');
    expect(hostOf('http://EXAMPLE.org')).toBe('example.org');
    expect(hostOf('http://[::1]:9200')).toBe('::1');
    expect(hostOf('http://2130706433/')).toBe('127.0.0.1'); // decimal form
    expect(hostOf('http://0x7f.1/')).toBe('127.0.0.1');
  });
  it('is loopback for localhost and loopback addresses only', () => {
    for (const u of ['http://localhost', 'http://localhost.:9200', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/']) {
      expect(isLoopbackUrl(u), u).toBe(true);
    }
    for (const u of ['http://localhost.evil.example', 'http://127.evil.example', 'http://evil.example/#@localhost', 'http://10.0.0.1']) {
      expect(isLoopbackUrl(u), u).toBe(false);
    }
  });
});

describe('checkDestination', () => {
  const ok = { lookup: resolvesTo('93.184.216.34') };
  it('allows an ordinary host', async () => {
    expect(await checkDestination('https://search.example.org:9200', ok)).toBeNull();
  });
  it('refuses a name that resolves somewhere private - the ones a list of names cannot catch', async () => {
    expect(await checkDestination('http://169.254.169.254.nip.io/', { lookup: resolvesTo('169.254.169.254') })).toMatch(/not allowed/);
    expect(await checkDestination('http://internal.example/', { lookup: resolvesTo('10.0.0.5') })).toMatch(/not allowed/);
  });
  it('refuses a name if ANY of its addresses is private', async () => {
    expect(await checkDestination('http://mixed.example/', { lookup: resolvesTo('93.184.216.34', '192.168.1.1') })).toMatch(/not allowed/);
  });
  it('refuses the metadata names, including a trailing dot, without asking DNS', async () => {
    const lookup = async () => { throw new Error('must not be asked'); };
    for (const u of ['http://metadata.google.internal/', 'http://metadata.google.internal./', 'http://METADATA.GOOGLE.INTERNAL/', 'http://metadata/']) {
      expect(await checkDestination(u, { lookup }), u).toMatch(/not allowed/);
    }
  });
  it('refuses private and hidden addresses written out', async () => {
    for (const u of ['http://10.0.0.5:9200', 'http://192.168.1.1', 'http://[::ffff:a9fe:a9fe]/', 'http://100.100.100.200/', 'http://2852039166/', 'http://[fd00::1]/', 'http://[::]/']) {
      expect(await checkDestination(u, ok), u).toMatch(/not allowed/);
    }
  });
  it('allows this machine only on the port it is told', async () => {
    const opts = { ...ok, loopbackPorts: [9200] };
    expect(await checkDestination('http://localhost:9200', { ...opts, lookup: resolvesTo('127.0.0.1') })).toBeNull();
    expect(await checkDestination('https://127.0.0.1:9200', opts)).toBeNull();
    expect(await checkDestination('http://[::1]:9200', opts)).toBeNull();
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://127.0.0.1', 'https://[::1]']) {
      expect(await checkDestination(u, { ...opts, lookup: resolvesTo('127.0.0.1') }), u).toMatch(/only use this machine on port 9200/);
    }
  });
  it('allows nothing on this machine when no port is named', async () => {
    expect(await checkDestination('http://127.0.0.1:9200', ok)).toMatch(/may not point at this machine/);
  });
  it('a name for this machine is held to the same rule', async () => {
    expect(await checkDestination('http://alias.example:3000', { lookup: resolvesTo('127.0.0.1'), loopbackPorts: [9200] })).toMatch(/port 9200/);
  });
  it('refuses a host that cannot be found, and junk', async () => {
    expect(await checkDestination('http://nonesuch.example/', { lookup: notFound })).toMatch(/could not be found/);
    expect(await checkDestination('not a url', ok)).toMatch(/not a valid URL/);
  });
});

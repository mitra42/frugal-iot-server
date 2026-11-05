/*
 * Counting the languages browsers ask for at sign-in: what is kept from an untrusted form field, how
 * "supported" is decided from the client's own files, and that a second sign-in adds to the count.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'sqlite3';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { countLanguages, isSupported, parseBrowserLanguages } from '../../lib/language-requests.js';

const SCHEMA = readFileSync('./frugal-iot-createdb.sql', 'utf8');

let db, htmldir;
const open = () => new Promise((res) => { const d = new Database(':memory:'); d.exec(SCHEMA, () => res(d)); });
const rows = () => new Promise((res, rej) =>
  db.all('SELECT code, count, supported FROM language_requests ORDER BY code', (e, r) => (e ? rej(e) : res(r))));
const count = (codes) => new Promise((res, rej) => countLanguages(db, htmldir, codes, (e) => (e ? rej(e) : res())));

beforeEach(async () => {
  db = await open();
  // A client with French and Hindi, as htmldir would hold it
  htmldir = mkdtempSync(join(tmpdir(), 'languages-'));
  mkdirSync(join(htmldir, 'languages'));
  for (const c of ['en', 'fr', 'hi']) writeFileSync(join(htmldir, 'languages', `${c}.yaml`), 'Yes: Yes\n');
});
afterEach(() => { db.close(); rmSync(htmldir, { recursive: true, force: true }); });

describe('parseBrowserLanguages', () => {
  it('lower-cases, trims and keeps each code once', () => {
    expect(parseBrowserLanguages(' fr-CA, hi-IN,FR-ca ,en')).toEqual(['fr-ca', 'hi-in', 'en']);
  });
  it('drops anything that is not a language tag', () => {
    expect(parseBrowserLanguages('fr,<script>,x,de-DE-extra-long-subtags-here,;drop table')).toEqual(['fr']);
  });
  it('keeps at most ten, since no browser sends more', () => {
    const many = Array.from({ length: 20 }, (_, i) => `x${String.fromCharCode(97 + i)}`).join(',');
    expect(parseBrowserLanguages(many)).toHaveLength(10);
  });
  it('treats a missing field as none', () => {
    expect(parseBrowserLanguages(undefined)).toEqual([]);
  });
});

describe('isSupported', () => {
  it('is decided by the client having a file, for the code or its language alone', () => {
    expect(isSupported(htmldir, 'fr')).toBe(true);
    expect(isSupported(htmldir, 'fr-ca')).toBe(true);
    expect(isSupported(htmldir, 'de-de')).toBe(false);
  });
  it('counts any English as supported, since the keys are English', () => {
    expect(isSupported(htmldir, 'en-gb')).toBe(true);
  });
});

describe('countLanguages', () => {
  it('adds one per sign-in, and records whether each was supported', async () => {
    await count(['fr-ca', 'de-de']);
    await count(['de-de']);
    expect(await rows()).toEqual([
      { code: 'de-de', count: 2, supported: 0 },
      { code: 'fr-ca', count: 1, supported: 1 },
    ]);
  });
  it('does nothing, and still answers, for no codes', async () => {
    await count([]);
    expect(await rows()).toEqual([]);
  });
});

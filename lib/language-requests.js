/*
 * Which languages people's browsers ask for, counted at each sign-in, so the next language to
 * translate is the one most asked for (frugal-iot-client docs/LANGUAGES_PLAN.md, Phase 3). Codes
 * only - nothing records who asked.
 *
 * To read it: SELECT * FROM language_requests ORDER BY supported, count DESC;
 */
import { existsSync } from 'fs';
import { join } from 'path';

// A browser sends a handful; anything longer is not a browser
const MAX_CODES = 10;
const CODE = /^[a-z]{2,3}(-[a-z0-9]{1,8}){0,3}$/;

// The form field is untrusted: keep only what looks like a language tag, lower-cased, once each
export function parseBrowserLanguages(value) {
  if (typeof value !== 'string') return [];
  const codes = value.split(',').map((c) => c.trim().toLowerCase()).filter((c) => CODE.test(c));
  return [...new Set(codes)].slice(0, MAX_CODES);
}

// The client has a file per language it supports, so whether one exists is the answer, and the
// server keeps no list of its own. fr-CA is served by fr, as the client matches it; English is the
// keys themselves, so it has no file.
export function isSupported(htmldir, code) {
  const primary = code.split('-')[0];
  if (primary === 'en') return true;
  return [code, primary].some((c) => existsSync(join(htmldir, 'languages', `${c}.yaml`)));
}

// One upsert per code. cb(err) - a failure to count must never stand in the way of a login
export function countLanguages(db, htmldir, codes, cb = () => {}) {
  const now = Date.now();
  let pending = codes.length;
  let failed = null;
  if (!pending) { cb(null); return; }
  codes.forEach((code) => {
    db.run(
      `INSERT INTO language_requests (code, count, last_seen, supported) VALUES (?, 1, ?, ?)
       ON CONFLICT(code) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen,
                                       supported = excluded.supported`,
      [code, now, isSupported(htmldir, code) ? 1 : 0],
      (err) => {
        failed = failed || err;
        if (--pending === 0) cb(failed);
      });
  });
}

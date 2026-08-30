/**
 * Password reset codes - the properties the design depends on (CARDS_UX.md §16 in frugal-iot-client).
 *
 * Nothing here touches the database or the mail: a "user" is just the row's four relevant fields.
 */
import crypto from 'crypto';
import { resetCodeMake, resetCodeCheck, resetRateOk, resetRateClear, SLOT_MS } from '../../lib/resetcode.js';

const userOf = (over = {}) => Object.assign({
  id: 7,
  username: 'alice',
  email: 'alice@example.org',
  hashed_password: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
}, over);

describe('the code itself', () => {
  test('is six digits, and keeps a leading zero as a string', () => {
    const { code } = resetCodeMake(userOf());
    expect(code).toMatch(/^[0-9]{6}$/);
  });
  test('the link token is long enough that the rate limit is not what protects it', () => {
    expect(resetCodeMake(userOf()).token).toMatch(/^[0-9a-f]{32}$/);
  });
  test('both forms verify', () => {
    const user = userOf();
    const { code, token } = resetCodeMake(user);
    expect(resetCodeCheck(user, code)).toBe(true);
    expect(resetCodeCheck(user, token)).toBe(true);
  });
  test('a wrong code does not', () => {
    const user = userOf();
    const { code } = resetCodeMake(user);
    const other = String((Number(code) + 1) % 1000000).padStart(6, '0');
    expect(resetCodeCheck(user, other)).toBe(false);
  });
  test('empty, null and undefined are not codes', () => {
    const user = userOf();
    for (const v of ['', null, undefined]) { expect(resetCodeCheck(user, v)).toBe(false); }
  });
});

describe('what a code is bound to', () => {
  test('another account cannot use it', () => {
    const { code } = resetCodeMake(userOf());
    expect(resetCodeCheck(userOf({ id: 8 }), code)).toBe(false);
  });
  test('changing the email invalidates it', () => {
    const { code } = resetCodeMake(userOf());
    expect(resetCodeCheck(userOf({ email: 'mallory@example.org' }), code)).toBe(false);
  });
  // This is what makes a code single-use: the reset changes the hash it was derived from
  test('using it invalidates it, because the password hash is in the material', () => {
    const user = userOf();
    const { code, token } = resetCodeMake(user);
    const after = userOf({ hashed_password: crypto.randomBytes(16) });
    expect(resetCodeCheck(after, code)).toBe(false);
    expect(resetCodeCheck(after, token)).toBe(false);
  });
  test('an account with no password hash still gets a usable code', () => {
    const user = userOf({ hashed_password: null });
    expect(resetCodeCheck(user, resetCodeMake(user).code)).toBe(true);
  });
});

describe('expiry by arithmetic, with nothing stored', () => {
  const withClockAt = (ms, fn) => {
    const real = Date.now;
    Date.now = () => ms;
    try { return fn(); } finally { Date.now = real; }
  };
  const t0 = 1_800_000_000_000;   // some instant, rounded down to a slot below

  test('a code from the previous slot still verifies - that is the 5-to-10 minutes', () => {
    const user = userOf();
    const made = withClockAt(t0, () => resetCodeMake(user));
    expect(withClockAt(t0 + SLOT_MS, () => resetCodeCheck(user, made.code))).toBe(true);
  });
  test('two slots on it does not', () => {
    const user = userOf();
    const made = withClockAt(t0, () => resetCodeMake(user));
    expect(withClockAt(t0 + 2 * SLOT_MS, () => resetCodeCheck(user, made.code))).toBe(false);
    expect(withClockAt(t0 + 2 * SLOT_MS, () => resetCodeCheck(user, made.token))).toBe(false);
  });
});

describe('rate limiting', () => {
  beforeEach(() => resetRateClear());

  // Six digits is a million guesses and a code lives up to ten minutes, so this is not optional
  test('verification attempts run out', () => {
    const allowed = [];
    for (let i = 0; i < 12; i++) { allowed.push(resetRateOk('check', 'alice')); }
    expect(allowed.filter(Boolean).length).toBe(10);
    expect(allowed[11]).toBe(false);
  });
  test('sending runs out sooner', () => {
    const allowed = [];
    for (let i = 0; i < 5; i++) { allowed.push(resetRateOk('send', 'alice')); }
    expect(allowed.filter(Boolean).length).toBe(3);
  });
  test('one identifier running out does not lock anybody else out', () => {
    for (let i = 0; i < 5; i++) { resetRateOk('send', 'alice'); }
    expect(resetRateOk('send', 'bob')).toBe(true);
  });
  test('the two buckets are counted separately', () => {
    for (let i = 0; i < 5; i++) { resetRateOk('send', 'alice'); }
    expect(resetRateOk('check', 'alice')).toBe(true);
  });
});

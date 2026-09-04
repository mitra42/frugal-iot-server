/*
 * What /config.json is allowed to contain.
 *
 * The point of the second test here is the deny list's one weakness: it withholds what it is told
 * to, so a secret added to the configuration later would be served unless somebody remembered to
 * deny it. Rather than trade that for an allowlist - which would be bookkeeping for the many
 * public settings - the guard lives here: anything secret-looking appearing in the served object
 * fails the build.
 */
import { describe, it, expect } from 'vitest';
import { buildConfigFor, hasPermissions, orgFieldsNeverServed } from '../../lib/config-for-user.js';

const user = (...perms) => ({
  id: 2, username: 'fred',
  permissions: perms.map(([capability, org]) => ({ id: 2, capability, org })),
});

// Shaped like a real one, including the secrets section frugal-iot-init generates.
const config = () => ({
  mqtt: { broker: 'wss://example.org/wss' },
  logger: { url: '/data' },
  server: { port: 8080, datadir: './data' },
  schema: { modules: { sht: {} } },
  secrets: { session_secret: 's3ss10n', user_secret: 'u53r' },
  organizations: {
    dev:   { name: 'Development', mqtt_password: 'public' },
    varta: { name: 'Varta',       mqtt_password: 'not-public' },
  },
});

// Every string anywhere in the object, so a secret cannot hide inside a nested section.
function allStrings(o, acc = []) {
  if (typeof o === 'string') acc.push(o);
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => allStrings(v, acc));
  return acc;
}
function allKeys(o, acc = []) {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    Object.entries(o).forEach(([k, v]) => { acc.push(k); allKeys(v, acc); });
  }
  return acc;
}

describe('buildConfigFor', () => {
  it('sends an organization the user can read, and not one they cannot', () => {
    const out = buildConfigFor(config(), user(['READ', 'dev']));
    expect(Object.keys(out.organizations)).toEqual(['dev']);
  });

  it('sends no organizations to a user with no permissions', () => {
    const out = buildConfigFor(config(), user());
    expect(out.organizations).toEqual({});
  });

  it('still sends the public settings a dashboard needs', () => {
    const out = buildConfigFor(config(), user(['READ', 'dev']));
    expect(out.mqtt.broker).toBe('wss://example.org/wss');
    expect(out.logger.url).toBe('/data');
    expect(out.schema.modules.sht).toBeDefined();
  });

  it('never sends the email section - it holds the SMTP password', () => {
    const c = config();
    c.email = { host: 'smtp.gmail.com', user: 'x@example.org', pass: 'app-password' };
    const out = buildConfigFor(c, user(['READ', 'dev'], ['ADMIN', 'dev']));
    expect(out.email).toBeUndefined();
    expect(allStrings(out)).not.toContain('app-password');
  });

  it('never sends the secrets section', () => {
    const out = buildConfigFor(config(), user(['READ', 'dev'], ['ADMIN', 'dev']));
    expect(out.secrets).toBeUndefined();
    expect(allStrings(out)).not.toContain('s3ss10n');
    expect(allStrings(out)).not.toContain('u53r');
  });

  // Any key in the served object whose name suggests a secret, other than the one we knowingly
  // serve. mqtt_password is served until S4 of the security plan gives browsers their own broker
  // credential, and orgFieldsNeverServed is what will withhold it - so this stops allowing it
  // automatically, on the day that list gains the field.
  const secretsIn = (out) => {
    const knowinglyServed = orgFieldsNeverServed.includes('mqtt_password') ? [] : ['mqtt_password'];
    return allKeys(out)
      .filter((k) => /secret|password|token|_key$/i.test(k))
      .filter((k) => !knowinglyServed.includes(k));
  };

  // The guard: everything a real configuration holds today, and nothing secret-looking gets out.
  // This is what noticed config.d/email.yaml's SMTP password was being served.
  it('sends nothing secret-looking from a realistic configuration', () => {
    const c = config();
    c.email = { host: 'smtp.gmail.com', user: 'x@example.org', pass: 'app-password' };
    expect(secretsIn(buildConfigFor(c, user(['READ', 'dev'], ['ADMIN', 'dev'])))).toEqual([]);
  });

  // ... and the guard is worth having, i.e. it does notice a secret nobody remembered to deny.
  // If this ever passes vacuously the test above proves nothing.
  it('would catch a new secret added to a section that is served', () => {
    const c = config();
    c.server.admin_token = 'should-not-be-served';
    expect(secretsIn(buildConfigFor(c, user(['READ', 'dev'])))).toContain('admin_token');
  });
});

describe('hasPermissions', () => {
  it('matches capability and organization', () => {
    expect(hasPermissions(user(['READ', 'dev']), 'dev', 'READ')).toBe(true);
    expect(hasPermissions(user(['READ', 'dev']), 'varta', 'READ')).toBe(false);
    expect(hasPermissions(user(['READ', 'dev']), 'dev', 'WRITE')).toBe(false);
  });

  it('does not imply WRITE from READ or ADMIN', () => {
    expect(hasPermissions(user(['READ', 'dev'], ['ADMIN', 'dev']), 'dev', 'WRITE')).toBe(false);
  });

  it('treats a missing user or permission list as no permissions', () => {
    expect(hasPermissions(undefined, 'dev', 'READ')).toBe(false);
    expect(hasPermissions({}, 'dev', 'READ')).toBe(false);
  });

  it('an organization-wide row satisfies a project-scoped question', () => {
    expect(hasPermissions(user(['READ', 'dev']), 'dev', 'READ', 'lotus')).toBe(true);
  });
});

/*
 * The permissions.project migration.
 *
 * Worth testing more carefully than most things here: it is the only step in the security plan that
 * rewrites an existing table rather than adding to it, and SQLite cannot alter a UNIQUE constraint,
 * so the column could not simply be added. The trap it is written around is that SQLite treats
 * NULLs as DISTINCT in a UNIQUE constraint - so a nullable project column would have let
 * ('READ','dev',NULL) be inserted twice and silently dropped the protection against duplicate
 * organization-wide rows. Hence NOT NULL DEFAULT ''.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'sqlite3';
import { readFileSync } from 'fs';

const MIGRATION = readFileSync('./scripts/migrate-permissions-project.sql', 'utf8');
const OLD_SHAPE = `CREATE TABLE permissions (
  id INTEGER NOT NULL, capability TEXT NOT NULL, org TEXT NOT NULL,
  UNIQUE(id, capability, org));`;

let db;
const exec = (sql) => new Promise((res, rej) => db.exec(sql, (e) => (e ? rej(e) : res())));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));

beforeEach(async () => {
  db = new Database(':memory:');
  await exec(OLD_SHAPE);
  await exec(`INSERT INTO permissions (id, capability, org) VALUES
    (0,'READ','dev'), (1,'ADMIN','dev'), (1,'READ','dev'), (2,'WRITE','varta');`);
});
afterEach(() => new Promise((res) => db.close(() => res())));

const columns = async () => (await all("pragma table_info(permissions);")).map((r) => r.name);

describe('migrate-permissions-project.sql', () => {
  it('adds the column', async () => {
    expect(await columns()).not.toContain('project');
    await exec(MIGRATION);
    expect(await columns()).toContain('project');
  });

  it('keeps every row, organization-wide', async () => {
    await exec(MIGRATION);
    const rows = await all("SELECT id, capability, org, project FROM permissions ORDER BY id, capability;");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.project === '')).toBe(true);
    expect(rows).toContainEqual({ id: 0, capability: 'READ', org: 'dev', project: '' });
    expect(rows).toContainEqual({ id: 2, capability: 'WRITE', org: 'varta', project: '' });
  });

  it('still refuses a duplicate organization-wide row', async () => {
    await exec(MIGRATION);
    await expect(run("INSERT INTO permissions (id,capability,org,project) VALUES (1,'ADMIN','dev','');"))
      .rejects.toThrow(/UNIQUE/);
  });

  it('allows a project-scoped row beside the organization-wide one', async () => {
    await exec(MIGRATION);
    await run("INSERT INTO permissions (id,capability,org,project) VALUES (1,'ADMIN','dev','lotus');");
    const rows = await all("SELECT project FROM permissions WHERE id=1 AND capability='ADMIN' AND org='dev';");
    expect(rows.map((r) => r.project).sort()).toEqual(['', 'lotus']);
  });

  it('refuses a duplicate project-scoped row too', async () => {
    await exec(MIGRATION);
    await run("INSERT INTO permissions (id,capability,org,project) VALUES (1,'ADMIN','dev','lotus');");
    await expect(run("INSERT INTO permissions (id,capability,org,project) VALUES (1,'ADMIN','dev','lotus');"))
      .rejects.toThrow(/UNIQUE/);
  });

  it('defaults project to the organization-wide value when a caller omits it', async () => {
    await exec(MIGRATION);
    await run("INSERT INTO permissions (id,capability,org) VALUES (2,'READ','varta');");
    const rows = await all("SELECT project FROM permissions WHERE id=2 AND capability='READ';");
    expect(rows[0].project).toBe('');
  });

  it('leaves the migrated table alone when createdb.sql is re-run, as every upgrade does', async () => {
    await exec(MIGRATION);
    await exec(readFileSync('./frugal-iot-createdb.sql', 'utf8'));
    expect(await columns()).toContain('project');
    expect(await all("SELECT id FROM permissions;")).toHaveLength(4);
  });
});

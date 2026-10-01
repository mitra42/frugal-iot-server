/*
 * Columns added to a table that already exists, which CREATE TABLE IF NOT EXISTS cannot do.
 */
import { describe, it, expect } from 'vitest';
import { Database } from 'sqlite3';
import { addMissingColumns } from '../../lib/schema-columns.js';

const columns = (db, table, cb) => db.all(`PRAGMA table_info(${table})`, [], (e, cols) => cb(e, cols.map((c) => c.name)));

describe('addMissingColumns', () => {
  it('adds bridges.credential to a table from before it existed, keeping the rows', () => new Promise((resolve, reject) => {
    const db = new Database(':memory:');
    db.serialize(() => {
      db.run('CREATE TABLE bridges (org TEXT NOT NULL, site TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL, last_pull INTEGER, UNIQUE(org, site))');
      db.run("INSERT INTO bridges (org, site, token, created_at) VALUES ('myfarm', 'pi4', 't', 1)");
      addMissingColumns(db, (err) => {
        if (err) return reject(err);
        db.get('SELECT * FROM bridges', [], (e, row) => {
          if (e) return reject(e);
          expect(row).toMatchObject({ site: 'pi4', credential: null });
          // And a second run, as every startup does, changes nothing and does not fail
          addMissingColumns(db, (err2) => {
            if (err2) return reject(err2);
            columns(db, 'bridges', (e3, cols) => {
              if (e3) return reject(e3);
              expect(cols.filter((c) => c === 'credential')).toHaveLength(1);
              db.close(resolve);
            });
          });
        });
      });
    });
  }));

  it('does nothing to a database that has no bridges table', () => new Promise((resolve, reject) => {
    const db = new Database(':memory:');
    addMissingColumns(db, (err) => {
      if (err) return reject(err);
      db.get("SELECT name FROM sqlite_master WHERE name = 'bridges'", [], (e, row) => {
        if (e) return reject(e);
        expect(row).toBeUndefined();
        db.close(resolve);
      });
    });
  }));
});

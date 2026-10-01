/*
 * Columns added to a table after it first shipped.
 *
 * frugal-iot-createdb.sql is all CREATE TABLE IF NOT EXISTS, which creates a new table whole but
 * cannot add a column to one that exists already - so a database from an earlier release would
 * otherwise never get it, and the first INSERT naming it would fail. Each is added here, guarded on
 * its absence, every time the server starts. ADD COLUMN only: anything that changes a constraint
 * needs the table rebuilt, which is what scripts/init.zsh step 3a does for permissions.project.
 */
const ADDED = [
  { table: 'bridges', column: 'credential', type: 'TEXT' },
];

export function addMissingColumns(db, cb) {
  let i = 0;
  const next = (err) => {
    if (err) return cb(err);
    if (i >= ADDED.length) return cb(null);
    const { table, column, type } = ADDED[i++];
    db.all(`PRAGMA table_info(${table})`, [], (e, cols) => {
      if (e) return cb(e);
      // No such table means CREATE TABLE has not run yet, or it is a table this database never had
      if (!cols.length || cols.some((c) => c.name === column)) return next();
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, [], (e2) => {
        if (!e2) console.log(`Database: added ${table}.${column}`);
        next(e2);
      });
    });
  };
  next();
}

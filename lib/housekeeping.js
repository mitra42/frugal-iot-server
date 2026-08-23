/*
 * Housekeeping for the data directory.
 *
 * Readings accumulate one file per topic per day and nothing ever removed them, so a server left
 * running eventually fills its disk - which on a field node running from an SD card takes the whole
 * machine down, and is a good deal more likely than the card wearing out.
 *
 * Two things happen here, once a day:
 *
 *  - Days older than "compressafterdays" are gzipped. A day's file never changes once the day is
 *    over, and they compress to about a third. Nothing needs to know: the server serves a
 *    ".csv.gz" in answer to a request for the ".csv", and lib/data-loader.js reads either.
 *
 *  - Days older than "deleteafterdays" are deleted, and separately, if the disk has less than
 *    "freespacepercent" free, the oldest days are deleted until it has. Deleting is off unless
 *    asked for, except the free space rule, which is there to keep the machine alive.
 *
 * Today's file and yesterday's are never touched, whatever the settings say - the logger is still
 * appending to them.
 */

import { createReadStream, createWriteStream, readdir, rename, stat, unlink, readFile, writeFile } from 'fs';
// statfs arrived in node 18.15, and this package says it needs node 18. Taken off the namespace
// rather than imported by name, because a named import of something a builtin does not have fails
// when the module loads - which would stop the server outright on an 18.x older than that, instead
// of just doing without the one check that needs it (see freePercent below).
import fs from 'fs';
import { createGzip, gunzip, gzip } from 'zlib';
import path from 'path';
import { each, eachSeries, waterfall } from 'async';

const DAY_MS = 24 * 60 * 60 * 1000;
// A file for a day still being written to must never be compressed or deleted. Two days of margin
// covers the server and the reader disagreeing about the timezone, and a node with a slow clock.
const MINIMUM_AGE_DAYS = 2;

// Day-stamped reading files, e.g. "2026-08-19.csv" or "2026-08-19.csv.gz"
const DATAFILE = /^(\d{4}-\d{2}-\d{2})\.csv(\.gz)?$/;

/*
 * Every reading file under a directory, with the day it holds and whether it is compressed.
 * callback(err, [ {filepath, day, ageDays, compressed, size} ])
 */
function findDataFiles(dir, callback) {
  let found = [];
  let today = Date.now();
  function walk(d, cb) {
    readdir(d, {withFileTypes: true}, (err, entries) => {
      if (err) {
        // A directory disappearing under us is not worth stopping for
        if (err.code === 'ENOENT') { cb(null); } else { cb(err); }
        return;
      }
      each(entries, (entry, cb1) => {
        let full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full, cb1);
        } else {
          let m = entry.name.match(DATAFILE);
          if (!m) { cb1(null); return; }
          stat(full, (err1, st) => {
            if (err1) { cb1(null); return; } // Gone, or unreadable - leave it alone
            found.push({
              filepath: full,
              day: m[1],
              ageDays: (today - Date.parse(m[1] + 'T00:00:00Z')) / DAY_MS,
              compressed: !!m[2],
              size: st.size,
            });
            cb1(null);
          });
        }
      }, cb);
    });
  }
  walk(dir, (err) => callback(err, found));
}

/*
 * Compress one day's file. If a compressed file for that day already exists - which happens when a
 * node with a wrong clock reports a reading for a day already dealt with - the two are joined into
 * one, because a request for that day is answered with a single file.
 */
function compressFile(file, callback) {
  let gzpath = file.filepath + '.gz';
  let tmppath = gzpath + '.tmp';
  stat(gzpath, (err) => {
    if (err) {
      // The ordinary case: nothing compressed for this day yet, so stream it out. Streaming rather
      // than reading it all in keeps this affordable on a machine with 512 MB.
      let source = createReadStream(file.filepath);
      let destination = createWriteStream(tmppath);
      source.on('error', callback);
      destination.on('error', callback);
      destination.on('finish', () => {
        // Only once the compressed copy is complete on disk is the original removed, so an
        // interruption anywhere in here leaves the readings intact in one file or the other
        rename(tmppath, gzpath, (err1) => {
          if (err1) { callback(err1); return; }
          unlink(file.filepath, callback);
        });
      });
      source.pipe(createGzip()).pipe(destination);
    } else {
      // Rare: join the existing compressed day and the new rows into a single compressed file
      waterfall([
        (cb) => readFile(gzpath, cb),
        (gzdata, cb) => gunzip(gzdata, cb),
        (existing, cb) => readFile(file.filepath, (err1, added) => cb(err1, existing, added)),
        (existing, added, cb) => gzip(Buffer.concat([existing, added]), cb),
        (combined, cb) => writeFile(tmppath, combined, cb),
        (cb) => rename(tmppath, gzpath, cb),
        (cb) => unlink(file.filepath, cb),
      ], callback);
    }
  });
}

/*
 * Compress every day old enough to be finished with. One file at a time: this runs on a machine
 * with one core, and there is nothing waiting on it.
 */
function compressOldFiles(files, afterDays, callback) {
  let due = files.filter((f) => !f.compressed && (f.ageDays >= Math.max(afterDays, MINIMUM_AGE_DAYS)));
  if (!due.length) { callback(null, 0); return; }
  let done = 0;
  eachSeries(due, (f, cb) => {
    compressFile(f, (err) => {
      if (err) { console.error("Housekeeping could not compress", f.filepath, "-", err.message); } else { done++; }
      cb(null); // One failure should not stop the others
    });
  }, (err) => callback(err, done));
}

/*
 * Delete whole days, oldest first, either because they are older than asked for or because the disk
 * is filling up. Never touches a day recent enough that the logger might still be writing to it.
 */
function deleteFiles(files, callback) {
  let removed = 0;
  let freed = 0;
  eachSeries(files, (f, cb) => {
    unlink(f.filepath, (err) => {
      if (err) { console.error("Housekeeping could not delete", f.filepath, "-", err.message); }
      else { removed++; freed += f.size; }
      cb(null);
    });
  }, (err) => callback(err, removed, freed));
}

/*
 * How much of the filesystem holding "dir" is free, as a percentage, or null if it cannot be told.
 */
function freePercent(dir, callback) {
  if (typeof fs.statfs !== 'function') { callback(null, null); return; } // node older than 18.15
  fs.statfs(dir, (err, st) => {
    if (err || !st || !st.blocks) { callback(null, null); return; }
    callback(null, (st.bavail / st.blocks) * 100);
  });
}

/*
 * One pass. Exported so it can be run on demand and tested without waiting a day.
 * config: { compressafterdays, deleteafterdays, freespacepercent }
 * callback(err, summary)
 */
export function housekeep(datadir, config, callback) {
  callback = callback || (() => {});
  let compressAfter = (config.compressafterdays === undefined) ? 2 : config.compressafterdays;
  let deleteAfter = config.deleteafterdays || 0;          // 0 = keep readings for ever
  let freeWanted = (config.freespacepercent === undefined) ? 10 : config.freespacepercent;

  findDataFiles(datadir, (err, files) => {
    if (err) { console.error("Housekeeping could not read", datadir, "-", err.message); callback(err); return; }
    if (!files.length) { callback(null, {files: 0}); return; }

    // Old enough that the logger has certainly finished with it
    let finished = files.filter((f) => f.ageDays >= MINIMUM_AGE_DAYS);
    // Oldest first, so that freeing space takes the least useful days
    finished.sort((a, b) => (a.day < b.day) ? -1 : (a.day > b.day) ? 1 : 0);

    let byAge = deleteAfter ? finished.filter((f) => f.ageDays >= deleteAfter) : [];

    deleteFiles(byAge, (err1, removedByAge, freedByAge) => {
      // A Set, not "byAge.includes": there can be tens of thousands of these files
      let gone = new Set(byAge.map((f) => f.filepath));
      let left = finished.filter((f) => !gone.has(f.filepath));
      freePercent(datadir, (err2, free) => {
        // Nothing to do about the disk if the amount free cannot be established
        if ((free === null) || (free >= freeWanted)) {
          finish(removedByAge, freedByAge, 0, free);
          return;
        }
        // Delete oldest days until there is enough room. The shortfall is worked out in bytes so
        // that the number of days removed matches what is actually needed.
        console.log(`Housekeeping: ${free.toFixed(1)}% of the disk free, below the ${freeWanted}% wanted - removing the oldest readings`);
        // Reached only when freePercent returned a number, so statfs exists on this node
        fs.statfs(datadir, (err3, st) => {
          let shortfall = (err3 || !st) ? 0 : ((freeWanted / 100) * st.blocks - st.bavail) * st.bsize;
          let toRemove = [];
          let planned = 0;
          for (let f of left) {
            if (planned >= shortfall) break;
            toRemove.push(f);
            planned += f.size;
          }
          deleteFiles(toRemove, (err4, removedForSpace, freedForSpace) => {
            if (toRemove.length === left.length) {
              console.error("Housekeeping deleted every reading it was allowed to and the disk is still short of space");
            }
            finish(removedByAge, freedByAge + freedForSpace, removedForSpace, free);
          });
        });
      });

      function finish(removedByAge, freed, removedForSpace, free) {
        // Compress last, so that anything about to be deleted is not compressed first for nothing
        findDataFiles(datadir, (err5, remaining) => {
          compressOldFiles(remaining || [], compressAfter, (err6, compressed) => {
            let summary = {
              files: files.length,
              compressed: compressed,
              deletedByAge: removedByAge,
              deletedForSpace: removedForSpace,
              freedBytes: freed,
              freePercent: free,
            };
            if (compressed || removedByAge || removedForSpace) {
              console.log("Housekeeping:", compressed, "day(s) compressed,",
                removedByAge + removedForSpace, "deleted,",
                (freed / 1048576).toFixed(1), "MB freed");
            }
            callback(null, summary);
          });
        });
      }
    });
  });
}

/*
 * Run it now and then once a day. Called from the server at startup.
 * The first pass is delayed, because startup is the busiest moment on a small board and none of
 * this is urgent.
 */
export function startHousekeeping(datadir, config) {
  config = config || {};
  if (config.enabled === false) {
    console.log("Housekeeping of", datadir, "turned off in config.d/server.yaml");
    return null;
  }
  let run = () => housekeep(datadir, config);
  setTimeout(run, 5 * 60 * 1000).unref();
  let timer = setInterval(run, DAY_MS);
  timer.unref(); // Never a reason to keep the server alive just for this
  return timer;
}

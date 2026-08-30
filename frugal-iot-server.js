#!/usr/bin/env node
// noinspection NodeCoreCodingAssistance,JSUnresolvedReference

/*
 * Simple server for FrugalIoT
 *
 * It has a few key functions
 * - Static server of UI files (frugal-iot-client) - intentionally agnostic about those files.
 * - Spawn the frugal-iot-logger which listens to MQTT and logs to disk

  Serves up following ....
 * = available to all
 A must be authenticated to see this, but not checking permissions at this point (effectively done through config.json)
 O available only if authenticated in the right organization should be 403 if wrong org
 Δ changed depending on authentication or permissions or organization
 P Tighter permissions than just being in the organization
 X not currently implemented
 *O means currently * should be O

 * /  Static serve frugal-iot-client (TODO-N89 will move to dashboard and put static HTML here).
 O /config.json Return configuration info - depends on user's org
 O /data  Back files from logger for graphing
 A /dashboard serves dashboard via frugal-iot-client
 * /debug repurposed for development
 * /echo  Send back headers etc
 * /login (get) served under default handler - which might go away TODO-N89 make sure not hidden under dashboards Authentication
 * /login (post) login a user, & redirect (to dashboard typically)
 * /node_modules  Javascript libraries (from frugal-iot-client)
 * /ota_update/:org/:project/:node/:attribs  OTA updates - this is what nodes call
 *Δ /admin (get) dashboard for administrators - includes OTA and will include permission management
 P /ota_update (post) protected place to upload new binaries (OTAUPDATE)
 XP /ota_list/:org list all ota files for an organization
 XP /ota_get/:org/*remainingpath download a binary so the client can flash it over USB
 O  /private Serve up private files under authentication - currently unused
 * /register (post) register a new user
 */
 /*
  How permissions work TODO-N89 rewrite

 Permissions from the user flow perspective
  - /dashboard => authenticate => ( server htmldir OR 303:login?tab=signin )
  - /login => form.
  - post/login => check and set session => ✔︎ 303:dashboard ╳ 303:login?tab=register
  - post/register => create user => ︎✔︎ 303:/dashboard ╳ 303:login?tab=register
  - "/dashboard" should be protected (replaces "/")
  - /config => authenticate => serve config.json || 401:fail || 403:wrong org
  - /config needs place to ask what orgs have permissions for - see below for making that real but add hook here
  - GET/ota NOT protected (as accessed by devices)
  - /data/xxx should depend on orgs have permissions for. TODO-S16

  Permissions from code perspective -
  Half the calls to passport set things up, the others use them. The flow is ...
  POST /login -> 'local' which uses 'LocalStrategy'
  LocalStrategy is defined with three outcomes: error;  ✔︎ { id..phone}  ╳ "incorrect"
    LocalStrategy looks up data in permissions table and adds to user
    Because LocalStrategy specifies session, it uses SerializeUser to store session, and redirects to dashboard
  Other calls checks session - (app.use 'passport.authenticate('session')
  which uses DeserializeUser to access {id...permissions} and adds to req.user
  then
    /config.json checks req.user and uses it to filter config
    /dashboard uses req.isAuthenticated() to check if logged in, if not redirects to /login
    /data checks loggedInOrRedirect ╳ 307->/login and can_READ ╳ 403 ✔︎ serve static
    /private uses loggedInOrRedirect ╳ 307->/login, ✔︎ serve static

  OTA and permissions
  - user goes to /dashboard which redirects to login, and creates session
  - displays tabs including OTA
  - data filled in "Submit" goes to POST /ota_update
  - Code in post /ota_update
  - It creates directory and uploads file and sends back message

  === DONE TO HERE TODO-N89====
  - organization on login.html (for register) should be a dropdown
  - organization on dashboard should be a dropdown based on permissions
  - Only connect to mqtt with credentials from /config\
  - POST/ota protected
  - Add email and email verification
  - Add process for approving permissions (esp membership of "org")
  - /logout
  - /index-template.html figure out how to authenticate in an embedded context
  - restart the logger ....
  - remove unnecessary logging
  - add a /index that has dashboard as a link but also info.
  - see if can remove default "/" handler
  - remove unnecessary console.logging
  - can remove this step-by-step
  - tools for managing users - listing, approving etc
  - fix issues with accessing html from localhost and logger on frugaliot.naturalinnovation.org
  */


// This is a workaround for NodeJS DNS resolution order that is causing issues on frugaliot.naturalinnovation.org if tries to use IPv6
import dns from 'dns';
// Put this at the very top of your `index.js` (before any network/fetch/firebase imports)
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

import express from 'express'; // http://expressjs.com/
import morgan from 'morgan'; // https://www.npmjs.com/package/morgan - http request logging

// If you are developing comment out the Production line, and uncomment the Development line
// Production
import { MqttLogger } from "frugal-iot-logger";  // https://github.com/mitra42/frugal-iot-logger
// Development of Logger
// import { MqttLogger } from "../frugal-iot-logger/index.js";  // https://github.com/mitra42/frugal-iot-logger

// API Integration - Farm IoT Interoperability Standard
import { createAPIRouter, createAPIErrorHandler } from './lib/api-routes.js';
import { createLoggerClient } from './lib/logger-client.js';
import { createPushManager } from './lib/farm-platform-push.js';
import { APIError } from './lib/api-errors.js';

import { access, constants, createReadStream, mkdir, readdir, readFile, rm } from 'fs'; // https://nodejs.org/api/fs.html
import { createGunzip } from 'zlib'; // https://nodejs.org/api/zlib.html - for serving compressed readings
import { startHousekeeping } from './lib/housekeeping.js';
import { detectSeries } from 'async'; // https://caolan.github.io/async/v3/docs.html
import { createMD5 } from 'hash-wasm';
import multer from 'multer'; // https://www.npmjs.com/package/multer
import path from 'path';

// Imports needed for Authentication
import passport from 'passport';
import LocalStrategy from 'passport-local';
import session from 'express-session'; // https://www.npmjs.com/package/express-session
import sqlite3 from 'sqlite3'; // https://www.npmjs.com/package/sqlite3
import crypto from 'crypto'; /* https://nodejs.org/api/crypto.html */
// import cookieParser from 'cookie-parser'; // https://www.npmjs.com/package/cookie-parser (note comment on https://www.npmjs.com/package/express-session that not needed and conflicts with session)
import {waterfall, each} from 'async';
import { mailInit, mailConfigured, sendMail } from './lib/mailer.js';
import { resetCodeMake, resetCodeCheck, resetRateOk } from './lib/resetcode.js';
// import { openDB } from 'sqlite-express-package'; /* appContent, appSelect, validateId, validateAlias, tagCloud, atom, rss,*/

export let config; // Live binding - lib/api-routes.js reads the current value at request time
let mqttLogger = new MqttLogger();
const loginUrl = '/dashboard/login.html';

// Back to the login page with something to say. A form POST can only be answered with a redirect
// and there is no session to hang a message on, so it all goes in the query string, where
// mqtt-login reads it as attributes. "mode" is which of the four forms to show;
// "messagetype" is error or info, which is the difference between a red box and a green one.
function loginRedirect(res, { mode = 'signin', message, messagetype, url }) {
  const q = new URLSearchParams({ mode });
  if (message) { q.set('message', message); }
  if (messagetype) { q.set('messagetype', messagetype); }
  if (url) { q.set('url', url); }   // Encoded here: a return url usually has a query string of its own
  res.redirect(`${loginUrl}?${q}`);
}
// A password reset link carries its token in the query string, and everything that logs a URL goes
// to the journal, which outlives the ten minutes the token is good for.
function redactUrl(url) {
  return String(url).replace(/([?&]code=)[^&]*/, '$1REDACTED');
}
// Where this server can be reached from outside, for the link in a reset email. Behind a proxy that
// does not set X-Forwarded-Host there is nothing in the request to go on, hence the config override.
function publicBase(req) {
  return (config.email && config.email.baseurl) || `${req.protocol}://${req.get('host')}`;
}

const optionsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // Probably Needs: GET, OPTIONS HEAD, do not believe can do POST, PUT, DELETE yet but could be wrong about that.
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  // Needs: Range; User-Agent; Not Needed: Authorization; Others are suggested in some online posts
  'Access-Control-Allow-Headers': 'Cache-Control, Content-Type, Content-Length, Range, User-Agent, X-Requested-With',
};
const responseHeaders = {
  //Need CORS because want to include webcomponents.js from embedded pages
  'Access-Control-Allow-Origin': '*',  // Needed if have CORS issues with things included
  Server: 'express/frugaliot',         // May be worth indicating
  Connection: 'keep-alive',          // Helps with load, its static so after few seconds should drop
  'Keep-Alive': 'timeout=5, max=1000', // Up to 5 seconds idle, 1000 requests max
};
// ============ Helper functions ============
// Note attribs is the otakey e.g. sht30_d1_mini
function findMostSpecificFile(topdir, org, project, node, attribs, cb) {
  let possfiles = [
    `${project}/${node}`, // Unlikely - if specify node, should be at the org level
    `+/${node}`,
    `${project}/${attribs}`,
    `+/${attribs}`
    //TODO-C14 might want to accept other variants on Arduino like sht30.ini.bin
    ].map(x => `${topdir}/${org}/${x}/firmware.bin`);
  detectSeries(possfiles, (path, cb1) => {
      access(path, constants.R_OK, (err) => { cb1(null, !err); })},
    cb);
}

// Usage example: calculateFileMd5('path/to/your/file.txt', (err, md5) => { ...})
function calculateFileMd5(filePath, cb) {
  createMD5().then((hash) => {
    const stream = createReadStream(filePath);

    stream.on('data', (data) => {
      hash.update(data);
    });
    stream.on('end', () => {
      const md5 = hash.digest();
      cb(null, md5);
    });
    stream.on('error', (err) => {
      cb(err, null);
    });
  });
}

function startServer() {
  const server = app.listen(config.server.port); // Intentionally same port as Python gateway defaults to, api should converge
  console.log('Server starting on port %s', config.server.port);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('A server, probably another copy of this, is already listening on port %s', config.server.port);
    } else {
      console.log('Server hit error %o', err);
      throw (err); // Will be uncaught exception
    }
  });
}
function isUnsafe(arr) {
  return arr.some( x => x && x.includes("/"))
}
// Dont let client supplied filepath go up directorey tree
function sanitize(filepath) {
  return filepath.replace(/[.][.]\//g, '/');
}

function adminUrl(req, message, lang) {
  return `${(req.body && req.body.url) || "/dashboard/"}?message=${encodeURIComponent(message)}&lang=${lang || (req.body && req.body.lang) || "EN"}`;
}
function clientErrorHandler(err, req, res, next) {
  console.log("ERROR", err);
  // How to handle errors ....
  if (req.xhr) {
    // Already sent headers, probably unrecoverable
    res.status(500).send('Something failed!')
  } else {
    // Switch based on where error came from
    if (req.url === "/ota_update") {
      // If use this in contexts where no req.body.url
      res.redirect(adminUrl(req, err.message));
    }
    //next(err); // Default handler - as now
  }
}
const sqlPeoplePermList = `
  SELECT u.id, u.name, p.capability
  FROM users u
  INNER JOIN permissions p ON u.id = p.id AND p.org = ?
;`;
const sqlPeopleList = `
    SELECT u.id, u.name
    FROM users u
;`;
const sqlAddPermission = `
  INSERT INTO permissions (id, capability, org) VALUES (?, ?, ?)
;`;
function get_people_list(org, cb) {
  db.all(sqlPeoplePermList, [org], (err, rows1) => {
    if (err) {
      cb(err);
    } else {
      db.all(sqlPeopleList, [], (err, rows2) => {
        if (err) {
          cb(err);
        } else {
          cb(null, { peopleperms: rows1, people: rows2 });  //{peopleperms: [{ id, name, capability }], people: [{id, name}]}
        }
      })
    }});
}
function send_people_list(req, res) {
  // TODO-N89 list all People for an organization
  get_people_list(req.params.org, (err, people) => {
    if (err) {
      res.status(500).send(err.message); // Errors are internal, unexpected
    } else {
      res.status(200).json(people);
    }
  });
}

// Sessions older than this hold that user's permissions from before the change - see the middleware
// after passport.authenticate('session')
const permissionsChangedAt = new Map(); // user id -> when it last changed
function notePermissionsChanged(id) {
  permissionsChangedAt.set(Number(id), Date.now());
}

function add_permission(id, capability, org, cb) {
  if ((id === undefined)
    || (capability === undefined) || (capability.length < 2)
    || (org === undefined) || (org.length < 2)) {
    cb(new Error("Invalid parameters"));
  } else {
    waterfall([
      (cb) => db.get('SELECT COUNT(id) FROM users WHERE id = ?', [id], cb),
      (n_users, cb) => { if (n_users["COUNT(id)"] != 1) { cb(new Error("User not found")); } else { cb(null); }},
      (cb) => db.get('SELECT COUNT(id) FROM permissions WHERE id = ? AND capability = ? AND org = ?', [id, capability, org], cb),
      (n_perms, cb) => { if (n_perms["COUNT(id)"] != 0) { cb(new Error("Duplicate permission")); } else { cb(null); }},
      (cb) => db.run(sqlAddPermission, [id, capability, org], cb),
      (cb) => { notePermissionsChanged(id); cb(null); },
    ], cb);
  }
}
function permissions_delete(id, capability, org, cb) {
  if ((id === undefined)
    || (capability === undefined) || (capability.length < 2)
    || (org === undefined) || (org.length < 2)) {
    cb(new Error("Invalid parameters"));
  } else {
    waterfall([
      (cb) => db.get('DELETE FROM permissions WHERE id = ? AND capability = ? AND org = ?', [id,capability,org], cb),
      (cb) => { notePermissionsChanged(id); cb(null); },
    ], cb);
  }
}

const sqlProjectsList = `
  SELECT id, name FROM projects WHERE org = ?
;`;
const sqlAddProject = `
  INSERT INTO projects (org, id, name) VALUES (?, ?, ?)
;`;
function get_projects_list(org, cb) {
  db.all(sqlProjectsList, [org], (err, rows) => {
    if (err) {
      cb(err);
    } else {
      cb(null, rows); // [{id, name}]
    }
  });
}
function send_projects_list(req, res) {
  get_projects_list(req.params.org, (err, projects) => {
    if (err) {
      res.status(500).send(err.message); // Errors are internal, unexpected
    } else {
      res.status(200).json(projects);
    }
  });
}
// Ensure config.organizations[org].projects[id].name = name, creating intermediate objects as needed
function addProjectToConfig(org, id, name) {
  let oo = config.organizations;
  let o = (oo[org] || (oo[org] = {}));
  let pp = (o.projects || (o.projects = {}));
  let p = (pp[id] || (pp[id] = {}));
  p.name = name;
}
// Read the projects table for every configured organization and add them to config.organizations
function loadProjectsIntoConfig(cb) {
  each(Object.keys(config.organizations), (org, cb) => {
    get_projects_list(org, (err, projects) => {
      if (err) {
        cb(err);
      } else {
        projects.forEach(({id, name}) => addProjectToConfig(org, id, name));
        cb(null);
      }
    });
  }, cb);
}
const projectIdRegex = /^[a-z0-9]+$/;
// Exported for reuse by lib/api-routes.js (POST /farm_register creates the project if it doesn't already exist)
export function add_project(org, id, name, cb) {
  if ((org === undefined) || (org.length < 2)
    || (id === undefined) || (id.length < 1) || !projectIdRegex.test(id)
    || (name === undefined) || (name.length < 1)) {
    cb(new Error("Invalid parameters - id must be lower-case letters and numbers only"));
  } else {
    waterfall([
      (cb) => db.get('SELECT COUNT(id) FROM projects WHERE org = ? AND id = ?', [org, id], cb),
      (n_projects, cb) => { if (n_projects["COUNT(id)"] != 0) { cb(new Error("Already Exists")); } else { cb(null); }},
      (cb) => db.run(sqlAddProject, [org, id, name], cb),
      (cb) => {
        addProjectToConfig(org, id, name);
        let orgClient = mqttLogger.clients[org];
        if (orgClient) {
          orgClient.watchProject(id, config.organizations[org].projects[id]);
        }
        cb(null);
      },
    ], cb);
  }
}

// Recursively walk a directory, callback with a list of files that pass matches(filename)
function readFilesRecursively(dir, matches, callback) {
  let results = [];

  function walk(relativeDir, done) {
    readdir(`${dir}/${relativeDir}`, { withFileTypes: true }, (err, entries) => {
      if (err) return done(err);

      let pending = entries.length;
      if (!pending) return done(null);

      entries.forEach(entry => {
        const relativePath = path.join(relativeDir, entry.name);

        if (entry.isDirectory()) {
          walk(relativePath, err => {
            if (err) return done(err);
            if (!--pending) done(null);
          });
        } else {
          if (matches(entry.name)) {
            results.push(relativePath);
          }
          if (!--pending) done(null);
        }
      });
    });
  }

  walk("", err => {
    if (err) return callback(err);
    callback(null, results);
  });
}
function match_firmware( filepath) {
  return filepath.endsWith('firmware.bin');
}
function get_ota_dirs(org, cb) {
  let dir = `${config.server.otadir}/${org}`;
  readFilesRecursively(dir, match_firmware, (err, files) => {
    if (err) {
      console.error("Error reading ota files:", org, err);
      cb(err);
    } else {
      cb(null, files.map(x => x.slice(0, -13))); // strip trailing "/firmware.bin"
    }
  });
}
// ============ Authentication related =========
let db; // For storing users
const dbpath = "./frugal-iot.db"; // TODO-N89 where should this live - make sure not somewhere the server will serve it.
function openOrCreateDatabase(cb) {
  access(dbpath, (constants.W_OK | constants.R_OK), (err) => {
    if (err) {
      console.log("Opening user database");

      db = new sqlite3.Database(dbpath, sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
          cb(err);
        } else {
          console.log("Created user database");
          execSqlStart(cb);
        }
      });
    } else {
      console.log("User Database exists");
      db = new sqlite3.Database(dbpath, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
          cb(err);
        } else {
          console.log("Opened user database");
          execSqlStart(cb);
        }
      });
    }
  });
}

// Runs frugal-iot-createdb.sql (CREATE TABLE IF NOT EXISTS ...) so any tables added since the db was first created also get created.
// The same file can be run by hand on a new installation: sqlite3 frugal-iot.db < frugal-iot-createdb.sql
// Resolved relative to this file, not the working directory, so it is found however the server is started.
const sqlstartpath = new URL('./frugal-iot-createdb.sql', import.meta.url);
function execSqlStart(cb) {
  readFile(sqlstartpath, 'utf8', (err, sqlstart) => {
    if (err) {
      cb(err);
    } else {
      db.exec(sqlstart, (err) => {
        if (err) {
          cb(err);
        } else {
          console.log("Exec-ed starting SQL");
          cb(null, db);
        }
      });
    }
  });
}

// Look somebody up by whatever they typed into the one "Username or email" box on the login page.
// Username first, so that a username with an "@" in it still works, then email - which is not
// declared UNIQUE in the schema, so take the first match rather than assuming there is only one.
function findUserByLogin(login, cb) {
  db.get('SELECT * FROM users WHERE username = ?', [ login ], function(err, user) {
    if (err || user || !String(login || '').includes('@')) { return cb(err, user); }
    db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [ login ], cb);
  });
}

// This verifies the user, and if successful returns a data structure via cb
// see passport.authenticate('local'... for where it gets used
passport.use(new LocalStrategy(function verify(username, password, cb) {
  findUserByLogin(username, function(err, user) {
    if (err) { return cb(err); }
    if (!user) { return cb(null, false, { message: 'Incorrect username or password+' }); }
    // TODO- - maybe just import pbkdf2 and timingSafeEqual ?
    crypto.pbkdf2(password, user.salt, 310000, 32, 'sha256', function(err, hashedPassword) {
      if (err) { return cb(err); }
      // noinspection JSUnresolvedReference
      if (!crypto.timingSafeEqual(user.hashed_password, hashedPassword)) {
        return cb(null, false, { message: 'Incorrect username or password*' });
      }
      db.all('SELECT * FROM permissions WHERE id = ? or id = 0', [ user.id ], function(err, permissions) {
        // permissions is [{ id, capability, org }]
        console.log("User",user.id, "with permissions", permissions.map(x => x.capability + " " +x.org).join(","));
        if (err) {
          return cb(err);
        }
        return cb(null, {
          id: user.id, username: user.username, organization: user.organization,
          name: user.name, email: user.email, phone: user.phone, permissions
        }); // TO-ADD-REGISTRATION-FIELD
      });
    });
  });
}));

// Helper functions - use as middleware for get, put and use
// TODO-N89 this might go away, replaced by shouldIBeLoggedIn - note that /login will be served from default handler which might go away
function loggedInOrRedirect(req, res, next) {
  if (req.isAuthenticated()) {
    next();
  } else {
    // If originalUrl is /private/index.html then req.url is just /index.html
    const q = new URLSearchParams({ mode: 'signin', message: 'Please login', url: req.originalUrl });
    res.redirect(307, `${loginUrl}?${q}`);
  }
}
function hasPermissions(user, org, permission) {
  return user.permissions.some(x => x.capability == permission && x.org == org);
}
// Like hasPermissions, but not org-scoped - true if the user has the capability on ANY org.
function hasPermissionsAny(user, permission) {
  return user.permissions.some(x => x.capability == permission);
}
// Note that uploads check directly rather than using this
function can_OTAUPDATE(req, res, next) {
  if (req.isAuthenticated() && hasPermissions(req.user, req.params.org, "OTAUPDATE")) {
    next();
  } else {
    res.sendStatus(401); // Just fail - shouldnt happen and anyway lost the file by now
  }
}
// Exported for reuse by lib/api-routes.js - reads org from req.params.org or res.locals.org, so callers must set one of those first.
export function can_READ(req, res, next) {
  const org = req.params.org || res.locals.org;
  if (req.isAuthenticated() && hasPermissions(req.user, org, "READ")) {
    next();
  } else {
    console.log("Failing permission to Read", req.user, org);
    res.sendStatus(401);
  }
}
// Not used as check direct in Multer storage, (since Multer fills the body) but use as template for other permissions (and then delete this comment)
// Exported for reuse by lib/api-routes.js - reads org from req.params.org, so callers without an :org URL segment must set it first.
export function can_ADMIN(req, res, next) {
  if (req.isAuthenticated() && hasPermissions(req.user, req.params.org, "ADMIN")) {
    next();
  } else {
    console.log("Failing permission to Admin", req.user, req.params.org);
    res.sendStatus(401);
  }
}
// Exported for reuse by lib/api-routes.js - for resources (like api_platforms) that aren't scoped to a
// single org, valid if the user has ADMIN on ANY org, rather than a specific one.
export function can_ADMIN_SOME(req, res, next) {
  if (req.isAuthenticated() && hasPermissionsAny(req.user, "ADMIN")) {
    next();
  } else {
    console.log("Failing permission to Admin (any org)", req.user);
    res.sendStatus(401);
  }
}
// Exported for reuse by lib/api-routes.js - like can_ADMIN, but for JSON API routes where the org isn't
// a URL :org segment (so Express has no built-in 404 for an unrecognised org to fall back on). Looks for
// the org in res.locals.org (set by an earlier middleware, for routes that must derive it from a compound
// field), then req.body.org, then req.query.org; confirms it actually exists before delegating to can_ADMIN.
export function can_ADMIN_JSON(req, res, next) {
  const org = res.locals.org || req.body?.org || req.query?.org;
  if (!org) {
    return next(new APIError('invalid_request', 'Missing or invalid organization'));
  }
  if (!config.organizations || !config.organizations[org]) {
    return next(new APIError('org_not_found', `Organization '${org}' does not exist on this platform`));
  }
  req.params.org = org;
  can_ADMIN(req, res, next);
}
export function loggedInOrFail(req, res, next) {
  if (req.isAuthenticated()) {
    next();
  } else {
    console.log("Not logged in, generally should not happen");
    res.sendStatus(401); // Just fail - this should not happen as Dashboard should be protected
  }
}
// While serving from frugal-iot-client it is only the dashboard we want to protect
// as need user to be logged in to access config etc
// Note if originalUrl is /dashboard/index.html then req.url is just /index.html
function shouldIBeLoggedIn(req, res, next) {
  //console.log("XXX shouldIBeLoggedIn", req.user, req.params.org);
  if ((['/','/index.html'].includes(req.url)) && !req.isAuthenticated()) {
    console.log(`Not authenticated redirecting ${req.url} for login`);
    // Capture the full original URL as-is in "url" (so e.g. /data?... comes back with all its params
    // intact), encoded so its own query string can't corrupt this redirect's query string. Carry "lang"
    // over as its own top-level param (from req.query, not duplicated into "url") so login.html itself
    // renders in the right language.
    const q = new URLSearchParams({ mode: 'signin', message: 'Please login', url: req.originalUrl });
    if (req.query.lang) { q.set('lang', req.query.lang); }
    res.redirect(307, `${loginUrl}?${q}`);
  } else {
    next();
  }
}


// Note: the schema this used to hold inline now lives in frugal-iot-createdb.sql, read by execSqlStart above.

// Called by /config.json to build a safe json to return
function addLoggedNodesToConfig() {
  // TODO-N89 TODO-90 this should strip out any sensitive information like passwords
  let configPlusNodes = config; // pointer to, not copy of
  let nodes = mqttLogger.reportNodes(); // { orgid, { projectid, { nodeid: lastseen } }
  let oo = configPlusNodes.organizations; // pointer into it
  Object.entries(nodes).forEach(([orgid, projects]) => {
    let o = (oo[orgid] || (oo[orgid] = {}));
    let pp = (o.projects || (o.projects = {}));
    // noinspection JSCheckFunctionSignatures
    Object.entries(projects).forEach(([projectid, nodes]) => {
      let p = (pp[projectid] || (pp[projectid] = {}));
      let nn = (p.nodes || (p.nodes = {}));
      // noinspection JSCheckFunctionSignatures
      Object.entries(nodes).forEach(([nodeid, vals]) => {
        nn[nodeid] = vals;
      });
    });
  });
}
// Produce an "unsafe" copy of config, i.e. it is a subset of config but points to objects rather than copying. Don't change the result!
function unsafeCopyConfigFor(user) {
  let oo = {
    organizations: {},
    user: user, // All data in user and permissions is visible to the user
  };
  Object.entries(config).forEach(([key, value]) => {
    if (key === 'organizations') {
      // noinspection JSCheckFunctionSignatures
      Object.entries(value).forEach(([orgid, org]) => {
        if (hasPermissions(user, orgid, 'READ')) {
          oo.organizations[orgid] = org;
        }
      });
    } else {
      oo[key] = value;
    }
  });
  return oo;
}
// ============ End Helper functions ============

const app = express();


// Things done on any query
app.use((req, res, next) => {
  res.set(responseHeaders);
  /*
  //Not doing this - not applicable to this server, and "/" is routed explicitly
  if (req.url.length > 1 && req.url.endsWith('/')) { // Strip trailing slash
    req.url = req.url.slice(0, req.url.length - 1);
    console.log(`Rewriting url to ${req.url}`);
  }
  */
  next();
});

//app.use(cookieParser()); // Not required - see comment on https://www.npmjs.com/package/express-session

// Respond to options - not sure if really needed, but seems to help in other servers.
app.options('/', (req, res) => {
  res.set(optionsHeaders);
  res.sendStatus(200);
});

// app.use(express.json()); // Uncomment if expecting Requests with a JSON body http://expressjs.com/en/5x/api.html#express.json

// Start the recognition of specific URL paths

app.get('/echo', (req, res) => {
  res.status(200).json(req.headers);
});
// This /debug can be freely rewritten to help debug stuff, nothing should rely on what it does remaining constant
app.get('/debug', (req, res) => {
  res.status(200).json(mqttLogger.reportNodes());
});
// Stick this as middleware to debug
// noinspection JSUnusedLocalSymbols
function debugRoutes(req, res, next) {
  console.log(req.url);
  next();
}
// Main for server
// Everything is read relative to the working directory, so being in the wrong one is the most
// common way to fail to start - say so plainly rather than reporting ENOENT on ./config.yaml.
access('./config.yaml', constants.R_OK, (err) => {
  if (err) {
    console.error(`No config.yaml in ${process.cwd()}`);
    console.error("Run this from the directory this server was installed into - the one holding");
    console.error("config.d and frugal-iot.db. If it is a new directory, set it up with: npx frugal-iot-init");
    process.exit(1);
  }
});
mqttLogger.readYamlConfig('.', (err, configobj) => {
  // Note side effect leaves copy of config in the mqttLogger
  if (err) {
    console.error(err);
  } else {
    /* global */ config = configobj;
    // Summarize rather than dumping the whole config: it is mostly the sensor schema, and it holds
    // each organization's mqtt_password, which should not be going to the console and the journal.
    console.log("Broker", config.mqtt.broker, "- organizations:", Object.keys(config.organizations).join(", ") || "(none)");
    console.log(mailInit(config.email));
    // Could genericize config defaults
    // HTTP request logging. "morgan: false" in config.d/server.yaml turns it off completely, which
    // matters on a machine running from an SD card: every request logged is a line to the journal,
    // and so a write that wears the card. Absent means log, so an existing server is unaffected by
    // this setting arriving. The older top-level config.yaml setting still works if anyone set it.
    let morganFormat = (config.server.morgan !== undefined) ? config.server.morgan : config.morgan;
    if (morganFormat === false) {
      console.log("Not logging HTTP requests (morgan: false in config.d/server.yaml)");
    } else {
      if (!morganFormat || (morganFormat === true)) { // Unset, or "morgan: true" meaning just turn it on
        morganFormat = ':method :url :req[range] :status :res[content-length] :response-time ms :req[referer]'
      }
      // Seems to be writing to syslog which is being cycled.
      morgan.token('url', (req) => redactUrl(req.originalUrl || req.url)); // see redactUrl
      app.use(morgan(morganFormat)); // see https://www.npmjs.com/package/morgan )
    }

    if (config.server.otadir.startsWith("./")) {
      config.server.otadir = process.cwd() + config.server.otadir.substring(1);
    }

    /* Example headers note chip-id.hex is the last 3 bytes of the mac address
    ["Host", "192.168.1.178:8080", "User-Agent", "ESP8266-http-Update", "Connection", "close",
    "+-ESP8266-Chip-ID", "9807700", "+-ESP8266-STA-MAC", "48:3F:DA:95:A7:54", "+-ESP8266-AP-MAC", "4A:3F:DA:95:A7:54",
    "+-ESP8266-free-space", "1720320", "+-ESP8266-sketch-size", "375392",
    "+-ESP8266-sketch-md5", "f690516f5d9872b960335c43d03289d9", "+-ESP8266-chip-size", "4194304",
    "+-ESP8266-sdk-version", "2.2.2-dev(38a443e)", "+-ESP8266-mode", "sketch",  "+-ESP8266-version", "01.02.03",
    "Content-Length", "0"]
     */

    // Just log the request for now
    // noinspection JSCheckFunctionSignatures
    app.use('/', (req, res, next) => {
      console.log(redactUrl(req.url));
      next();
    })

    console.log("Doing OTA updates at /ota_update from", config.server.otadir);
    app.get('/ota_update/:org/:project/:node/:attribs', (req, res) => {
      //Intentionally no login
      const version = req.headers['x-esp8266-version'] || req.headers['x-esp32-version'];
      // Note not using version - we match MD5s instead
      const currentMD5 = req.headers['x-esp8266-sketch-md5'] || req.headers['x-esp32-sketch-md5'];
      //console.log("GET: parms=", req.params, "version:", version, "md5", currentMD5);
      // sendFile insists on absolute file names or root-ed
      findMostSpecificFile(config.server.otadir, req.params.org, req.params.project, req.params.node, req.params.attribs,
        (err, path) => {
          if (err) {
            console.error(err);
            res.sendStatus(304);
          } else {
            if (path) {
              calculateFileMd5(path, (err, md5) => {
                console.log(req.params.node, ": found OTA file at", path, "with ", (md5 === currentMD5) ? "matching " : "different ","MD5=", md5);
                if (md5 === currentMD5) {
                  res.sendStatus(304);
                } else {
                  res.sendFile(path);
                }
              });
            } else { // None of the paths matched
              console.log(req.params.node, ": No OTA file for", req.url);
              res.sendStatus(304);
            }
          }
        });
    });

    // Serve Node modules at /node_modules - the libraries the web client loads, such as chart.js
    // and luxon, which it asks for by that path.
    //
    // Two places to look, because where those libraries sit depends on how the client got here:
    //  - installed with npm, they are hoisted to this directory's own node_modules alongside the
    //    client, and there is no node_modules inside the client at all;
    //  - working from a checkout of the client (whether htmldir points at it, or node_modules holds
    //    an "npm link" symlink to it), they are in that checkout's own node_modules, and npm has
    //    removed the hoisted copies as no longer needed.
    // Both are offered, the client's own first, and express falls through to the next when a file is
    // not in the one before. So neither layout needs configuring, and getting it wrong is not a
    // thing that can happen.
    // Both default to where npm puts things, so a server.yaml that says nothing about either still
    // works, and a missing setting does not turn into an obscure error from express.static
    if (!config.server.nodemodulesdir) config.server.nodemodulesdir = './node_modules';
    if (!config.server.htmldir) config.server.htmldir = './node_modules/frugal-iot-client';
    const clientNodeModules = path.join(config.server.htmldir, 'node_modules');
    console.log("Serving /node_modules from", clientNodeModules, "then", config.server.nodemodulesdir);
    const routerNM = express.Router();
    app.use('/node_modules', routerNM);
    //routerData.use('/', (req, res, next) => { console.log("NM:", req.url); next(); });
    routerNM.use(
      express.static(clientNodeModules, {immutable: true, maxAge: 1000 * 60 * 60 * 24}),
      express.static(config.server.nodemodulesdir, {immutable: true, maxAge: 1000 * 60 * 60 * 24})
    );

    openOrCreateDatabase((err, db) => {
      if (err) {
        console.error("Error opening or creating database", err);
      } else {
        loadProjectsIntoConfig((err) => {
          if (err) {
            console.error("Error loading projects into config", err);
          }
        });
        // app.use(express.json()); // Not needed
        app.use(express.urlencoded({ extended: true })); // Passport will not function without this
        app.set('trust proxy', 1); // trust first proxy - see note in https://www.npmjs.com/package/express-session
        // TODO-N89 note need to setup session store, defaults to memory store which is not good for production
        // TODO-N89 think about cookie timeout and add "keep me logged in on this device" option that controls it
        app.use(session({
          secret: 'keyboard cat', // TODO-N89 probably change, try changing this, hopefully should just require re-login
          resave: false,
          saveUninitialized: false,
          cookie: { secure: 'auto' }  // TODO-N89 cant be secure: true while testing on HTTP
        }));
        // This defines he function that will be used to turn user data returned from database into object for the session
        passport.serializeUser(function(user, cb) {
          process.nextTick(function() {
            console.log("Serializing");
            // TO-ADD-REGISTRATION-FIELD
            return cb(null, {
              id: user.id,
              username: user.username,
              organization: user.organization,
              name: user.name,
              email: user.email,
              phone: user.phone,
              permissions: user.permissions,
              loginAt: Date.now(), // So a permission change can tell which sessions predate it
            });
          });
        });
        // Define a function that turns data extracted from the session into an object
        // This is called in call to passport.authenticate below
        passport.deserializeUser(function(user, cb) {
          process.nextTick(function() {
            //console.log("XXX14 Deserializing");
            return cb(null, user);
          });
        });
        //https://www.passportjs.org/howtos/password/

        // Check if have a session, and if so store in req.user, uses function defined in deserializeUser above
        app.use(passport.authenticate('session')); // Add user to req.user

        // End any session that predates a change to that user's permissions.
        //
        // The session carries the permissions read at login, and can_READ, can_ADMIN and the rest
        // read them from there - so without this a change takes effect only when the user next logs
        // in. Granting is merely confusing; revoking is worse, because someone whose ADMIN has been
        // taken away keeps it until their session ends.
        //
        // Rather than re-reading the table on every request to catch something this rare, note when
        // a user's permissions changed and end the sessions older than that. They log in again,
        // which is a small price for a change that happens a handful of times.
        //
        // In memory on purpose: express-session's default store keeps the sessions in this process
        // too, so the two are lost together on a restart and neither can outlive the other.
        app.use((req, res, next) => {
          const changedAt = req.user && permissionsChangedAt.get(Number(req.user.id));
          if (changedAt && (!req.user.loginAt || (changedAt > req.user.loginAt))) {
            console.log("Permissions changed for", req.user.id, "- ending the session made before it");
            // Carry on unauthenticated: a page redirects to login, /config.json answers 401 and the
            // client redirects itself
            return req.logout((err) => (err ? next(err) : next()));
          }
          next();
        });

        // ===== API Integration: Farm IoT Interoperability Standard =====
        // Its tables are in frugal-iot-createdb.sql, already run by execSqlStart above, so there is
        // nothing to initialize here (lib/database.js still exports initializeSchema for the tests).

        // Create logger client with direct reference to mqttLogger
        const loggerClient = createLoggerClient(mqttLogger);
        console.log("Created logger client for API integration");

        // Create push manager for Farm-Platform data delivery
        const pushManager = createPushManager(db, null);
        console.log("Created push manager for Farm-Platform data push");

        // Enable JSON parsing for API POST endpoints
        app.use(express.json());

        // Mount API routes
        const apiRouter = createAPIRouter(db, config.server.datadir, loggerClient, pushManager);
        app.use('/api', apiRouter);
        console.log("Mounted API routes at /api");

        // Add API error handler
        app.use(createAPIErrorHandler()); // createAPIErrorHandler returns a function to use as error handler
        console.log("Added API error handler");

        // Start push queue processor (runs every 5 seconds)
        const pushQueueInterval = setInterval(async () => {
          try {
            const result = await pushManager.processPushQueue();
            if (result.processed > 0 || result.failed > 0) {
              console.log(`[Push Queue] ${result.message}`);
            }
          } catch (err) {
            console.error('[Push Queue] Error:', err.message);
          }
        }, 5000);

        // ===== End API Integration =====

        app.post('/login',
          (req,res,next) => {
            console.log("Trying to login with redirect to",req.body.url);
            // This is ugly, but I cannot see how to pass the URL to passport.authenticate options
            // Default the destination rather than trusting every caller to supply one: with no
            // successRedirect, passport calls next() on success and the request 404s as
            // "Cannot POST /login" - a confusing way to report a missing form field.
            const returnTo = req.body.url || '/dashboard';
            const failureQuery = new URLSearchParams({
              mode: 'signin', messagetype: 'error',
              message: 'Incorrect username or password', url: returnTo });
            passport.authenticate('local', {
              session: true,
              //failWithError: true,
              failureRedirect: `${loginUrl}?${failureQuery}`,
              successRedirect: returnTo,
              // In failure case will also be messages in the session which need clearing out TODO-N89
              //failureRedirect: `${loginUrl}?register=false&message=Incorrect+username+or+password&url=${req.body.url}`,
            })(req, res, next);
          }
        );
        app.post('/register', (req, res) => {
          console.log("username=", req.body.username); // may want to log registrations
          //console.log("password=", req.body.password);
          const username = req.body.username;
          const password = req.body.password;
          const organization = req.body.organization; //TODO-N89 should be validated and can only be "dev" without approval
          crypto.randomBytes(16, (err, salt) => {
            if (err) {
              res.status(500).send('Internal error 688' );
            } else {
              crypto.pbkdf2(password, salt, 310000, 32, 'sha256', (err, hashedPassword) => {
                if (err) {
                  res.status(500).send('Internal error 692' );
                } else {
                  // TO-ADD-REGISTRATION-FIELD
                  db.run('INSERT INTO users (username, hashed_password, salt, organization, name, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [username, hashedPassword, salt, organization, req.body.name, req.body.email, req.body.phone], (err) => {
                      if (err) {
                        console.log(err);
                        loginRedirect(res, { mode: 'register', messagetype: 'error',
                          message: 'Registration failed', url: req.body.url });
                      } else {
                        loginRedirect(res, { mode: 'signin', messagetype: 'info',
                          message: 'Registration successful - please login', url: req.body.url });
                      }
                    });
                }
              });
            }
          });
        });

        // ---------- Forgotten password ----------
        // Nothing is stored: the code is an HMAC over the account and a five-minute slot, so it
        // expires by arithmetic and stops working the moment the password changes. See
        // lib/resetcode.js. The mail carries both a link (a long token) and six digits to type.
        app.post('/forgotpassword', (req, res) => {
          const login = String(req.body.username || '').trim();
          const url = req.body.url;
          // The same answer whether or not the account exists, so this form cannot be used to find
          // out who has an account here.
          const sameAnswer = { mode: 'reset', messagetype: 'info', url,
            message: 'If that account exists we have emailed a reset code' };
          if (!mailConfigured()) {
            return loginRedirect(res, { mode: 'signin', messagetype: 'error', url,
              message: 'Password reset is not available on this server' });
          }
          if (!resetRateOk('send', login.toLowerCase())) {
            return loginRedirect(res, { mode: 'forgot', messagetype: 'error', url,
              message: 'Too many attempts - please wait a few minutes' });
          }
          findUserByLogin(login, (err, user) => {
            if (err) { console.error("Looking up", login, "for a password reset:", err.message); }
            if (!user || !user.email) { return loginRedirect(res, sameAnswer); }
            const { code, token } = resetCodeMake(user);
            const q = new URLSearchParams({ mode: 'reset', username: user.username, code: token });
            if (url) { q.set('url', url); }
            const link = `${publicBase(req)}${loginUrl}?${q}`;
            const text = [
              `Somebody asked to reset the Frugal IoT password for ${user.username}.`,
              ``,
              `Open this link:`,
              link,
              ``,
              `or type this code into the reset form: ${code}`,
              ``,
              `Either works for the next ten minutes at most. If it was not you, ignore this mail -`,
              `nothing has changed and nothing will until the code is used.`,
            ].join('\n');
            sendMail({ to: user.email, subject: 'Frugal IoT password reset', text }, (err) => {
              // Still the same answer: telling them the mail failed would also tell an outsider
              // that the account exists. It is logged loudly instead, because a server whose SMTP
              // is broken looks from the outside exactly like one that is working.
              if (err) { console.error("Could not send reset mail for", user.username, "-", err.message); }
              loginRedirect(res, sameAnswer);
            });
          });
        });
        app.post('/resetpassword', (req, res) => {
          const login = String(req.body.username || '').trim();
          const url = req.body.url;
          const notValid = { mode: 'reset', messagetype: 'error', url,
            message: 'That code is not valid or has expired' };
          if (!resetRateOk('check', login.toLowerCase())) {
            return loginRedirect(res, { mode: 'reset', messagetype: 'error', url,
              message: 'Too many attempts - please wait a few minutes' });
          }
          if (!req.body.password) { return loginRedirect(res, notValid); }
          findUserByLogin(login, (err, user) => {
            if (err) { console.error("Looking up", login, "to reset a password:", err.message); }
            if (!user || !resetCodeCheck(user, String(req.body.code || '').trim())) {
              return loginRedirect(res, notValid);
            }
            crypto.randomBytes(16, (err, salt) => {
              if (err) { return res.status(500).send('Internal error 1101'); }
              crypto.pbkdf2(req.body.password, salt, 310000, 32, 'sha256', (err, hashedPassword) => {
                if (err) { return res.status(500).send('Internal error 1103'); }
                db.run('UPDATE users SET hashed_password = ?, salt = ? WHERE id = ?',
                  [hashedPassword, salt, user.id], (err) => {
                    if (err) {
                      console.error("Could not reset the password for", user.username, "-", err.message);
                      return loginRedirect(res, notValid);
                    }
                    console.log("Password reset for", user.username);
                    loginRedirect(res, { mode: 'signin', messagetype: 'info', url,
                      message: 'Password reset - please sign in' });
                  });
              });
            });
          });
        });

        app.get('/config.json',
          loggedInOrFail,  // Config is only returned if user is logged in.
          (req,res) => {
            addLoggedNodesToConfig();
            let oo = unsafeCopyConfigFor(req.user);
            // TODO-N89 should check which orgs approved
            res.status(200).json(oo);
          },
        );
        app.get('/ota_list/:org',
          loggedInOrFail,
          can_OTAUPDATE,
          (req,res) => {
            // TODO-N89 list all OTA files for an organization
            get_ota_dirs(req.params.org, (err, dirs) => {
              if (err) {
                res.status(500).send(err.message);
              } else {
                res.status(200).json(dirs); // Strip off /firmware.bin
              }
            });
          }
        );
        // Delete an OTA file
        app.get('/ota_delete/:org/*remainingpath',
          loggedInOrFail,
          can_OTAUPDATE,
          (req,res) => {
            let remainingpath = req.params.remainingpath.join('/');
            let dirpath = `${config.server.otadir}/${req.params.org}/${sanitize(remainingpath)}`;
            console.log("Deleting OTA file", dirpath);
            rm(dirpath, { recursive: true, force: true }, (err, unused) => {
              if (err) {
                console.error("Error deleting ota files:", dirpath, err);
                res.status(500).send(err.message);
              } else {
                get_ota_dirs(req.params.org, (err, dirs) => {
                  if (err) {
                    res.status(500).send(err.message);
                  } else {
                    res.status(200).json(dirs);
                  }
                });
              }
            });
          }
        );
        // Download an OTA binary so the client can flash it over USB (see FLASH_PLAN.md in
        // frugal-iot-client). Deliberately not /ota_update, which is unauthenticated for devices
        // and answers 304 rather than sending bytes.
        app.get('/ota_get/:org/*remainingpath',
          loggedInOrFail,
          can_OTAUPDATE,
          (req,res) => {
            let remainingpath = req.params.remainingpath.join('/');
            let filepath = `${config.server.otadir}/${req.params.org}/${sanitize(remainingpath)}/firmware.bin`;
            console.log("Sending OTA file", filepath);
            res.sendFile(filepath, {}, (err) => {
              if (err) {
                console.error("Error sending ota file:", filepath, err);
                if (!res.headersSent) res.status(404).send(err.message);
              }
            });
          }
        );
        app.get('/people_list/:org',
          loggedInOrFail,
          can_ADMIN, // Gets org from URL
          send_people_list,
        );
        app.get('/add_permission/:org',
          loggedInOrFail,
          can_ADMIN,  // Gets org from URL
          (req,res, next) => {
            add_permission(req.query.id, req.query.capability,req.params.org, (err) => {
              if (err) {
                res.status(400).send(err.message);
              } else {
                next();
              }
            });
          },
          send_people_list,
        );
        app.get('/permissions_delete/:org',
          loggedInOrFail,
          can_ADMIN,  // Gets org from URL
          (req,res, next) => {
            permissions_delete(req.query.id, req.query.capability,req.params.org, (err) => {
              if (err) {
                res.status(400).send(err.message);
              } else {
                next();
              }
            });
          },
          send_people_list,
        );
        app.get('/projects_list/:org',
          loggedInOrFail,
          can_ADMIN, // Gets org from URL
          send_projects_list,
        );
        app.get('/add_project/:org',
          loggedInOrFail,
          can_ADMIN,  // Gets org from URL
          (req,res, next) => {
            add_project(req.params.org, req.query.id, req.query.name, (err) => {
              if (err) {
                res.status(400).send(err.message);
              } else {
                next();
              }
            });
          },
          send_projects_list,
        );
        // Log out and go back to the login page. There was no way to do this at all before, which
        // matters more now that a permissions change ends the session and people log in again.
        app.get('/logout', (req, res, next) => {
          // With a url to come back to: without one, POST /login has no successRedirect, so on a
          // *successful* login passport calls next(), nothing else handles POST /login, and express
          // answers "Cannot POST /login" - which looks like a broken login rather than a missing
          // parameter.
          req.logout((err) => (err ? next(err) : loginRedirect(res, { url: '/dashboard' })));
        });

        //  /dashboard is served statically, to logged in users //TODO-N89 restrict orgs to those have permissions for (maybe handled via /config.org )
        const routerDashboard = express.Router();
        app.use('/dashboard', routerDashboard);
        routerDashboard.use(
          (req,res,next) => {console.log("/dashboard handler for", req.url); next(); }, // Log attempt
          shouldIBeLoggedIn, // redirect to ./login.html if not logged in then back here
          //(req,res,next) => {console.log("XXX back to /dashboard handler for", req.url); next(); }, // Log attempt
          //(req,res,next) => {console.log("XXX", config.server.htmldir); next(); }, // Log attempt
          express.static(config.server.htmldir, {immutable: true, maxAge: 1000 * 60 * 60 * 24}) // Serve static
        );

        // Serve frugal-iot-logger data at /data but configure where to get them.
        console.log("Serving /data from", config.server.datadir);
        // Nothing ever removed old readings, so a server left running filled its disk - which on a
        // field node takes the whole machine down. This compresses days gone by and, if asked to,
        // removes the oldest ones. See lib/housekeeping.js for what the settings mean.
        startHousekeeping(config.server.datadir, config.server.housekeeping);
        //TODO-N89 should be authenticated to correct org
        const routerData = express.Router();
        app.use('/data', routerData);
        // Important that these aren't cached, or the data will not be updated.
        routerData.use(
          loggedInOrRedirect,
          (req,res,next) => {
            res.locals.org = req.url.split("/")[1];
            next(); }, //
          can_READ,
          // Nothing logged here on purpose - morgan already reports the URL and status of this same
          // request, and on an SD card each duplicated line is another write.
          // The logger holds recent readings in memory rather than writing each one to the card as
          // it arrives, so write them out before serving the files, or today's would be short of
          // the last few minutes. Reading data is rare compared with recording it, and this costs
          // nothing when there is nothing waiting.
          // The guard is for an installation whose logger predates flush() - it would rather serve
          // data a few minutes out of date than fail the request
          (req, res, next) => { if (mqttLogger.flush) { mqttLogger.flush(() => next()); } else { next(); } },
          // Readings from days gone by get compressed (see lib/housekeeping.js) but are still
          // asked for by their ".csv" name, so answer one of those with the ".csv.gz" if that is
          // what is on disk. A browser decompresses a gzip Content-Encoding itself, so the client
          // needed no change; anything that says it does not want gzip - curl, by default - gets
          // it decompressed here instead.
          (req, res, next) => {
            if (!req.path.endsWith('.csv')) { next(); return; }
            // req.path comes from the URL, so it has to be checked before being used as a path
            const wanted = path.resolve(config.server.datadir, '.' + path.normalize(req.path));
            if (!wanted.startsWith(path.resolve(config.server.datadir) + path.sep)) { next(); return; }
            access(wanted, constants.R_OK, (err) => {
              if (!err) { next(); return; } // Not compressed - serve it in the ordinary way
              access(wanted + '.gz', constants.R_OK, (err1) => {
                if (err1) { next(); return; } // Neither exists - let express.static give the 404
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                if (req.acceptsEncodings('gzip')) {
                  res.setHeader('Content-Encoding', 'gzip');
                  createReadStream(wanted + '.gz').pipe(res);
                } else {
                  createReadStream(wanted + '.gz').pipe(createGunzip()).pipe(res);
                }
              });
            });
          },
          express.static(config.server.datadir, {immutable: false})
        );


        // OTA Uploads are multipart (multipart/form-data) from a form handled by multer
        const storage = multer.diskStorage({
          destination: function (req, file, cb) {
            if (isUnsafe([req.body.organization, req.body.project, req.body.deviceid, req.body.otakey])) {
              return cb(new Error("Parameters may not contain '/'"));
            }
            // Shouldnt actually happen, as dashboard should only show compliant orgs, so this would be a hack (or bad timing)
            if (!hasPermissions(req.user, req.body.organization, "OTAUPDATE")) {
              return cb(new Error("Permission denied to OTAUPDATE"));
            }
            let dir;
            if (!req.body.otakey) {
              return cb(new Error("must specify either OTA key or Device ID"));
            } else if (req.body.project) {
              dir = `${config.server.otadir}/${req.body.organization}/${req.body.project}/${req.body.otakey}`;
            } else {
              dir = `${config.server.otadir}/${req.body.organization}/+/${req.body.otakey}`;
            }
            mkdir(dir, {recursive: true}, (err, unusedpath) => {
              if (err) {
                if (err) console.error("Error creating directory should not happen", dir);
                return cb(err);
              } else {
                cb(null, dir); // Pass the full dir, not the directory returned from mkdir
              }
            });
          },
          filename: function (req, file, cb) {
            if ((file.originalname !== "firmware.bin") && (!file.originalname.endsWith(".ino.bin"))) {
              // TODO-S18 not sure what case of filenames is in Windows
              return cb(new Error("Filename should be 'firmware.bin' or end in '.ino.bin'"));
            }
            //const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
            cb(null, "firmware.bin");
          }
        })
        //console.log("XXX END OF ELEVATABLE"); // No idea what this line meant !
        const multerupload = multer({ storage: storage });
        app.post('/ota_update',
          loggedInOrFail,
          // can_OTAUPDATE, // Dont need as multerupload -> storage checks specifically
          multerupload.single('file'), // Put file details in req.file
          (req,res,next) => {
            console.log("OTA update posted", req.file.size, "to", req.file.path);
            // /dashboard/?message=OTA binary uploaded&lang=XX
            res.redirect(adminUrl(req,"OTA binary uploaded"));
          },
        );

        // Serve private files under /private - needs authentication
        const routerPrivate = express.Router();
        app.use('/private', routerPrivate);
        routerPrivate.use(
          loggedInOrRedirect,
          //(req,res,next) => { console.log("/private handler authenticated by session for", req.url); next(); },
          // TODO-N89 should configure where /private is - maybe in frugal-iot-client
          express.static(config.server.privatedir, { immutable: true, maxAge: 1000 * 60 * 60 * 24 }));

        // Serve service worker with no-cache to allow updates
        app.get('/service-worker.js', (req, res) => {
          res.set('Cache-Control', 'no-cache');
          res.sendFile(path.resolve(config.server.publicdir, 'service-worker.js'));
        });

        // Serve favicon with caching
        app.get('/favicon.ico', (req, res) => {
          res.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
          res.set('Content-Type', 'image/x-icon');
          res.sendFile(path.resolve(config.server.publicdir, 'favicon.ico'));
        });

        // Serve HTML files from a configurable location
        // Use a 1-day cache to keep traffic down
        // Its important that frugaliot.css is cached, or the UX will flash while checking it hasn't changed.
        // This has to come AFTER all the more specific paths like /data etc
        // Default catches rest (especially "/" so should be last)
        app.use(
          express.static(config.server.publicdir, {immutable: true, maxAge: 1000 * 60 * 60 * 24})
        );
        app.use(clientErrorHandler);
        // Now start the server
        startServer();
        // And logger
        mqttLogger.start();
      }
    });
  }
});



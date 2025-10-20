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
 * P Tighter permissions than just being in the organization
 X not currently implemented
 *O means currently * should be O

 * /  Static serve frugal-iot-client (TODO-89 will move to dashboard and put static HTML here).
 O /config.json Return configuration info - depends on user's org
 O /data  Back files from logger for graphing
 A /dashboard serves dashboard via frugal-iot-client
 * /debug repurposed for development
 * /echo  Send back headers etc
 * /login (get) served under default handler - which might go away TODO-89 make sure not hidden under dashboards Authentication
 * /login (post) login a user, & redirect (to dashboard typically)
 * /node_modules  Javascript libraries (from frugal-iot-client)
 * /ota_update/:org/:project/:node/:attribs  OTA updates - this is what nodes call
 X*Δ /admin (get) TODO-14 admin forms (including for adding new binaries)
 XP /ota_update (post) TODO-89 protected place to upload new binaries
 O  /private Serve up private files under authentication - currently unused
 * /register (post) register a new user
 */
 /*
  How permissions work TODO-89 rewrite

 Permissions from the user flow perspective
  - /dashboard => authenticate => ( server htmldir OR 303:login?tab=signin )
  - /login => form.
  - post/login => check and set session => ✔︎ 303:dashboard ╳ 303:login?tab=register
  - post/register => create user => ︎✔︎ 303:/dashboard ╳ 303:login?tab=register
  - "/dashboard" should be protected (replaces "/")
  - /config => authenticate => serve config.json || 401:fail || 403:wrong org
  - /config needs place to ask what orgs have permissions for - see below for making that real but add hook here
  - GET/ota NOT protected (as accessed by devices)
  - /data/xxx should depend on orgs have permissions for. TODO-14

  Permissions from code perspective -
  Half the calls to passport set things up, the others use them. The flow is ...
  POST /login -> 'local' which uses 'LocalService'
  TODO-14 add permissions as array of strings from LocalStrategy so ends up in service
  LocalStrategy is defined with three outcomes: error;  ✔︎ { id..phone}  ╳ "incorrect"
  Because LocalStrategy specifies session, it uses SerializeUser to store session, and redirects to dashboard
  Other calls checks session - (app.use 'passport.authenticate('session')
  which uses DeserializeUser to access {id...phone} and adds to req.user
  then
    /config.json checks req.user and uses it to filter config
    /dashboard uses req.isAuthenticated() to check if logged in, if not redirects to /login
    /data checks loggedInOrRedirect ╳ 307->/login and req.user.organization ╳ 403 ✔︎ serve static
    /private uses loggedInOrRedirect ╳ 307->/login, ✔︎ serve static

  === DONE TO HERE TODO-89====
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


import express from 'express'; // http://expressjs.com/
import morgan from 'morgan'; // https://www.npmjs.com/package/morgan - http request logging

// If you are developing comment out the Production line, and uncomment the Development line
// Production
import { MqttLogger } from "frugal-iot-logger";  // https://github.com/mitra42/frugal-iot-logger
// Development of Logger
// import { MqttLogger } from "../frugal-iot-logger/index.js";  // https://github.com/mitra42/frugal-iot-logger

import { access, constants, createReadStream } from 'fs'; // https://nodejs.org/api/fs.html
import { detectSeries } from 'async'; // https://caolan.github.io/async/v3/docs.html
import { createMD5 } from 'hash-wasm';

// Imports needed for Authentication
import passport from 'passport';
import LocalStrategy from 'passport-local';
import session from 'express-session'; // https://www.npmjs.com/package/express-session
import sqlite3 from 'sqlite3'; // https://www.npmjs.com/package/sqlite3
import crypto from 'crypto'; /* https://nodejs.org/api/crypto.html */
// import cookieParser from 'cookie-parser'; // https://www.npmjs.com/package/cookie-parser (note comment on https://www.npmjs.com/package/express-session that not needed and conflicts with session)
// import {waterfall} from 'async';
// import { openDB } from 'sqlite-express-package'; /* appContent, appSelect, validateId, validateAlias, tagCloud, atom, rss,*/

let config;
let mqttLogger = new MqttLogger();
const loginUrl = '/dashboard/login.html';

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
    `/${node}`,
    `${project}/${attribs}`,
    `${attribs}`
    //TODO-C14 might want to accept other variants on Arduino like sht30.ini.bin
    ].map(x => [`${topdir}/${org}/${x}/frugal-iot.ino.bin`,`${topdir}/${org}/${x}/firmware.bin`])
    .flat();
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
// ============ Authentication related =========
let db; // For storing users
const dbpath = "./frugal-iot.db"; // TODO-89 where should this live - make sure not somewhere the server will serve it.
function openOrCreateDatabase(cb) {
  access(dbpath, (constants.W_OK | constants.R_OK), (err) => {
    if (err) {
      console.log("Opening user database");

      db = new sqlite3.Database(dbpath, sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
          cb(err);
        } else {
          console.log("Created user database");
          db.exec(sqlstart, (err) => {
            if (err) {
              cb(err);
            } else {
              console.log("Exec-ed starting SQL");
              cb(null, db)
            }
          });
        }
      });
    } else {
      console.log("User Database exists");
      db = new sqlite3.Database(dbpath, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
          cb(err);
        } else {
          console.log("Opened user database");
          cb(null, db);
        }
      });
    }
  });
}

// This verifies the user, and if successful returns a data structure via cb
// see passport.authenticate('local'... for where it gets used
passport.use(new LocalStrategy(function verify(username, password, cb) {
  db.get('SELECT * FROM users WHERE username = ?', [ username ], function(err, user) {
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
// TODO-89 this might go away, replaced by shouldIBeLoggedIn - note that /login will be served from default handler which might go away
function loggedInOrRedirect(req, res, next) {
  if (req.isAuthenticated()) {
    next();
  } else {
    // If originalUrl is /private/index.html then req.url is just /index.html
    res.redirect(307, `${loginUrl}?register=false&message=Please%20login&url=` + req.originalUrl);
  }
}
function loggedInOrFail(req, res, next) {
  if (req.isAuthenticated()) {
    next();
  } else {
    res.sendStatus(401); // Just fail - this should not happen as Dashboard should be protected
  }
}
// While serving from frugal-iot-client it is only the dashboard we want to protect
// as need user to be logged in to access config etc
// Note if originalUrl is /dashboard/index.html then req.url is just /index.html
function shouldIBeLoggedIn(req, res, next) {
  if ((['/','/index.html','/admin.html'].includes(req.url)) && !req.isAuthenticated()) {
    console.log("Not authenticated redirecting for login");
    res.redirect(307, `${loginUrl}?register=false&message=Please%20login&url=` + req.originalUrl);
  } else {
    next();
  }
}


// TODO check on size of fields hashed_password and salt
// TO-ADD-REGISTRATION-FIELD
const sqlstart = `
CREATE TABLE IF NOT EXISTS \`users\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`username\` TEXT UNIQUE,
  \`hashed_password\` BLOB,
  \`salt\` BLOB '',
  \`organization\` varchar(20) NOT NULL DEFAULT '',
  \`name\` TEXT,
  \`email\` TEXT,
  \`phone\` TEXT
);
CREATE TABLE IF NOT EXISTS \`permissions\` (
  \`id\` INTEGER PRIMARY KEY,
  \`capability\` TEXT NOT NULL,
  \`org\` TEXT NOT NULL
);
`; // TODO-42 TODO-14 add {*, xxx, dev } for permissions everyone has


function addLoggedNodesToConfig() {
  // TODO-89 TODO-90 this should strip out any sensitive information like passwords
  let configPlusNodes = config; // pointer to, not copy of
  let nodes = mqttLogger.reportNodes(); // { orgid, { projectid, { nodeid: lastseen } }
  let oo = configPlusNodes.organizations; // pointer into it
  Object.entries(nodes).forEach(([orgid, projects]) => {
    if (!oo[orgid]) {
      oo[orgid] = { projects: {}};
    }
    let pp = oo[orgid].projects;
    // noinspection JSCheckFunctionSignatures
    Object.entries(projects).forEach(([projectid, nodes]) => {
      if (!pp[projectid]) {
        pp[projectid] = { nodes: {}};
      }
      let nn = pp[projectid].nodes;
      // noinspection JSCheckFunctionSignatures
      Object.entries(nodes).forEach(([nodeid, lastseen]) => {
        if (!nn[nodeid]) {
          nn[nodeid] = {};
        }
        nn[nodeid].lastseen = lastseen;
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
        if (orgid === user.organization) { // TODO-89 TODO-14 should check if user is allowed to see this org
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
mqttLogger.readYamlConfig('.', (err, configobj) => {
  if (err) {
    console.error(err);
  } else {
    /* global */ config = configobj;
    console.log("Config=", config);
    // Could genericize config defaults
    if (!config.morgan) {
      config.morgan = ':method :url :req[range] :status :res[content-length] :response-time ms :req[referer]'
    }
    // Seems to be writing to syslog which is being cycled.
    app.use(morgan(config.morgan)); // see https://www.npmjs.com/package/morgan )

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
      console.log(req.url);
      next();
    })

    console.log("Doing OTA updates at /ota_update from", config.server.otadir);
    app.get('/ota_update/:org/:project/:node/:attribs', (req, res) => {
      //Intentionally no login
      const version = req.headers['x-esp8266-version'] || req.headers['x-esp32-version'];
      const currentMD5 = req.headers['x-esp8266-sketch-md5'] || req.headers['x-esp32-sketch-md5'];
      console.log("GET: parms=", req.params, "version:", version, "md5", currentMD5);
      // sendFile insists on absolute file names or root-ed
      if (config.server.otadir.startsWith("./")) {
        config.server.otadir = process.cwd() + config.server.otadir.substring(1);
      }
      findMostSpecificFile(config.server.otadir, req.params.org, req.params.project, req.params.node, req.params.attribs,
        (err, path) => {
          if (err) {
            console.error(err);
            res.sendStatus(304);
          } else {
            if (path) {
              calculateFileMd5(path, (err, md5) => {
                console.log("Found OTA file at", path, "with MD5", md5);
                if (md5 === currentMD5) {
                  console.log("MD5 matches, no update needed");
                  res.sendStatus(304);
                } else {
                  console.log("MD5 does not match, sending update");
                  res.sendFile(path);
                }
              });
            } else { // None of the paths matched
              console.log("No OTA file for", req.url);
              res.sendStatus(304);
            }
          }
        });
    });

    // Serve Node modules at /node_modules but configure where to get them.
    console.log("Serving /node_modules from", config.server.nodemodulesdir);
    const routerNM = express.Router();
    app.use('/node_modules', routerNM);
    //routerData.use('/', (req, res, next) => { console.log("NM:", req.url); next(); });
    routerNM.use(express.static(config.server.nodemodulesdir, {immutable: true, maxAge: 1000 * 60 * 60 * 24}));

    openOrCreateDatabase((err, db) => {
      if (err) {
        console.error("Error opening or creating database", err);
      } else {
        // app.use(express.json()); // Not needed
        app.use(express.urlencoded({ extended: true })); // Passport will not function without this
        app.set('trust proxy', 1); // trust first proxy - see note in https://www.npmjs.com/package/express-session
        // TODO-89 note need to setup session store, defaults to memory store which is not good for production
        // TODO-89 think about cookie timeout and add "keep me logged in on this device" option that controls it
        app.use(session({
          secret: 'keyboard cat', // TODO-89 probably change
          resave: false,
          saveUninitialized: false,
          cookie: { secure: 'auto' }  // TODO-89 cant be secure: true while testing on HTTP
        }));
        // This turns the registered data returned in "user" by
        // TODO-14-XXX
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
            });
          });
        });
        // TODO-14-XXX
        passport.deserializeUser(function(user, cb) {
          process.nextTick(function() {
            console.log("XXX14 Deserializing");
            return cb(null, user);
          });
        });
        //https://www.passportjs.org/howtos/password/

        // Check if have a session, and if so store in req.user
        // TODO-14-XXX
        app.use(passport.authenticate('session')); // Add user to req.user

        app.post('/login',
          (req,res,next) => {
            console.log("Trying to login with redirect to",req.body.url);
            // This is ugly, but I cannot see how to pass the URL to passport.authenticate options
            passport.authenticate('local', {
              session: true,
              //failWithError: true,
              failureRedirect: `${loginUrl}?register=false&message=Incorrect+username+or+password&url=${req.body.url}`,
              successRedirect: req.body.url,
              // In failure case will also be messages in the session which need clearing out TODO-89
              //failureRedirect: `${loginUrl}?register=false&message=Incorrect+username+or+password&url=${req.body.url}`,
            })(req, res, next);
          }
        );
        app.post('/register', (req, res) => {
          console.log("username=", req.body.username); // may want to log registrations
          //console.log("password=", req.body.password);
          const username = req.body.username;
          const password = req.body.password;
          const organization = req.body.organization; //TODO-89 should be validated and can only be "dev" without approval
          crypto.randomBytes(16, (err, salt) => {
            if (err) {
              res.status(500).json({ message: 'Internal error' });
            } else {
              crypto.pbkdf2(password, salt, 310000, 32, 'sha256', (err, hashedPassword) => {
                if (err) {
                  res.status(500).json({ message: 'Internal error' });
                } else {
                  // TO-ADD-REGISTRATION-FIELD
                  db.run('INSERT INTO users (username, hashed_password, salt, organization, name, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [username, hashedPassword, salt, organization, req.body.name, req.body.email, req.body.phone], (err) => {
                      if (err) {
                        console.log(err);
                        res.redirect(`${loginUrl}?register=true&message=Registration%20failed&url=${req.body.url}`);
                      } else {
                        res.redirect(`${loginUrl}?register=false&message=Registration%20successful%20-%20please%20login&url=${req.body.url}`);
                      }
                    });
                }
              });
            }
          });
        });

        app.get('/config.json',
          loggedInOrFail,
          (req,res) => {
            addLoggedNodesToConfig();
            let oo = unsafeCopyConfigFor(req.user);
            // TODO-89 should check which orgs approved
            res.status(200).json(oo);
          },
        );

        const routerDashboard = express.Router();
        app.use('/dashboard', routerDashboard);
        routerDashboard.use(
          (req,res,next) => {
            console.log("/dashboard handler for", req.url);
            next(); },
          shouldIBeLoggedIn, // redirect to ./login.html if not logged in then back here
          express.static(config.server.htmldir, {immutable: true, maxAge: 1000 * 60 * 60 * 24}));

        // Serve frugal-iot-logger data at /data but configure where to get them.
        console.log("Serving /data from", config.server.datadir);
        //TODO-89 should be authenticated to correct org
        const routerData = express.Router();
        app.use('/data', routerData);
        // Important that these aren't cached, or the data will not be updated.
        routerData.use(
          loggedInOrRedirect,
          (req,res,next) => { console.log("/data handler authenticated by session for", req.url); next(); },
          (req,res,next) => {
            if (req.url.startsWith(`/${req.user.organization}/`)) {
              next();
            } else {
              res.sendStatus(403);
            }
          },
          express.static(config.server.datadir, {immutable: false})
        );

        // Serve private files under /private - needs authentication
        const routerPrivate = express.Router();
        app.use('/private', routerPrivate);
        routerPrivate.use(
          loggedInOrRedirect,
          //(req,res,next) => { console.log("/private handler authenticated by session for", req.url); next(); },
          // TODO-89 should configure where /private is - maybe in frugal-iot-client
          express.static(config.server.privatedir, {immutable: true, maxAge: 1000 * 60 * 60 * 24}));

        // Serve HTML files from a configurable location
        // Use a 1-day cache to keep traffic down
        // Its important that frugaliot.css is cached, or the UX will flash while checking it hasn't changed.
        // This has to come AFTER all the more specific paths like /data etc
        // Default catches rest (especially "/" so should be last)
        app.use(
          express.static(config.server.publicdir, {immutable: true, maxAge: 1000 * 60 * 60 * 24})
        );
        // Now start the server
        startServer();
        // And logger
        mqttLogger.start();
      }
    });
  }
});



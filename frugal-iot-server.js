/*
 * Simple server for FrugalIoT
 *
 * It has a few key functions
 * - Static server of UI files (frugal-iot-client) - intentionally agnostic about those files.
 * - Spawn the frugal-iot-logger which listens to MQTT and logs to disk
 * - Static server of Data files created by the logger.
 * - OTA server.
 *   - TODO - Place where "projects" can upload bin files for serving by OTA
 * - Serve up a configuration file that client can use to offer selection or organizations / projects etc.
 */
 /* TODO-89
  - /dashboard => authenticate => ( server htmldir OR 303:login?tab=signin )
  - /login => form.
  - post/login => check and set session => 303:dashboard || 303:login?tab=register
  - post/register => create user => 303:/dashboard || 303:login?tab=register
  - /config => authenticate => serve config.json || 401:fail || 403:wrong org


 OLD FLOW ...
 - A: request for config hits check
 - FAIL -> Open login/register dialog
 - OK -> config.json
 - Post/Register - create user, note doesn't have permissions yet.
 - FAIL -> Display message and reopen
 - OK -> Open login dialog
 - Post/Login - check
 - FAIL -> Login
 - OK -> session set
 - retry config
 - OK -> config.json
 - also protect /data but not /ota but protect POST/ota

 - A: client:  MqttWrapper:connectedCallBack
 - A: server: 219 get /config
  */


import express from 'express'; // http://expressjs.com/
import morgan from 'morgan'; // https://www.npmjs.com/package/morgan - http request logging


// Production
// import { MqttLogger } from "frugal-iot-logger";  // https://github.com/mitra42/frugal-iot-logger
// Development
import { MqttLogger } from "../frugal-iot-logger/index.js";  // https://github.com/mitra42/frugal-iot-logger

import { access, constants, createReadStream } from 'fs'; // https://nodejs.org/api/fs.html
import { detectSeries } from 'async'; // https://caolan.github.io/async/v3/docs.html
import { createMD5 } from 'hash-wasm';

// Production - when client and logger installed by "npm install" on frugal-iot-server
//const nodemodulesdir = process.cwd() + "/node_modules"; // Serves "/node_modules"
//const htmldir = nodemodulesdir + "/frugal-iot-client";  // Serves "/"

// Development - This is an alternative when developing client and server together
const htmldir = process.cwd() + "/../frugal-iot-client";  // Serves "/"
const nodemodulesdir = htmldir + "/node_modules"; // Serves "/node_modules"

// Currently same on both production and development
const datadir = process.cwd() + "/data"; // Serves "/data"
const otadir = process.cwd() + "/ota"; // Hierarchy of bin files for OTA updates

// Imports needed for Authentication
import passport from 'passport';
import LocalStrategy from 'passport-local';
import session from 'express-session'; // https://www.npmjs.com/package/express-session
import sqlite3 from 'sqlite3'; // https://www.npmjs.com/package/sqlite3
import crypto from 'crypto'; /* https://nodejs.org/api/crypto.html */
// import cookieParser from 'cookie-parser'; // https://www.npmjs.com/package/cookie-parser (note comment on https://www.npmjs.com/package/express-session that not needed and conflicts with session)
import {waterfall} from 'async';
import { openDB } from 'sqlite-express-package'; /* appContent, appSelect, validateId, validateAlias, tagCloud, atom, rss,*/

let config;
let mqttLogger = new MqttLogger();

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
function findMostSpecificFile(topdir, org, project, node, attribs, cb) {
  let possfiles = [
    `${project}/${node}`,
    `/${node}`,
    `${project}/${attribs}`,
    `${attribs}`
    ].map(x => `${topdir}/${org}/${x}/frugal-iot.ino.bin`);
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

// ============ Authentication related =========
let db; // For storing users
const dbpath = "/Users/mitra/temp/frugal-iot.db"; // TODO-89 where should this live - make sure not somewhere the server will serve it.

function openOrCreateDatabase(cb) {
  access(dbpath, (constants.W_OK | constants.R_OK), (err) => {
    if (err) {
      console.log("Creating user database");

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

passport.use(new LocalStrategy(function verify(username, password, cb) {
  db.get('SELECT * FROM users WHERE username = ?', [ username ], function(err, user) {
    console.log("XXX129");
    if (err) { return cb(err); }
    if (!user) { return cb(null, false, { message: 'Incorrect username or password.' }); }
    // TODO- - maybe just import pbkdf2 and timingSafeEqual ?
    crypto.pbkdf2(password, user.salt, 310000, 32, 'sha256', function(err, hashedPassword) {
      if (err) { return cb(err); }
      if (!crypto.timingSafeEqual(user.hashed_password, hashedPassword)) {
        return cb(null, false, { message: 'Incorrect username or password.' });
      }
      return cb(null, {id: user.id, username: user.username, organization: user.organization});
    });
  });
}));

// TODO check on size of fields hashed_password and salt
const sqlstart = `
CREATE TABLE IF NOT EXISTS \`users\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`username\` TEXT UNIQUE,
  \`hashed_password\` BLOB,
  \`salt\` BLOB '',
  \`organization\` varchar(20) NOT NULL DEFAULT ''
);
`;


// ============ End Helper functions ============
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


const app = express();

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

//app.use(cookieParser());

// Respond to options - not sure if really needed, but seems to help in other servers.
app.options('/', (req, res) => {
  res.set(optionsHeaders);
  res.sendStatus(200);
});

// app.use(express.json()); // Uncomment if expecting Requests with a JSON body http://expressjs.com/en/5x/api.html#express.json


app.get('/echo', (req, res) => {
  res.status(200).json(req.headers);
});
// TODO-89 - this should authenticate
app.get('/config.json',

  (req, res) => {
  // TODO-89 TODO-90 this should strip out any sensitive information like passwords
  let configPlusNodes = config;
  let nodes = mqttLogger.reportNodes(); // { orgid, { projid, { nodeid: lastseen } }
  let oo = configPlusNodes.organizations;
  Object.entries(nodes).forEach(([orgid, projects]) => {
    if (!oo[orgid]) {
      oo[orgid] = { projects: {}};
    }
    let pp = oo[orgid].projects;
    Object.entries(projects).forEach(([projectid, nodes]) => {
      if (!pp[projectid]) {
        pp[projectid] = { nodes: {}};
      }
      let nn = pp[projectid].nodes;
      Object.entries(nodes).forEach(([nodeid, lastseen]) => {
        if (!nn[nodeid]) {
          nn[nodeid] = {};
        }
        nn[nodeid].lastseen = lastseen;
      });
    });
  });
  res.status(200).json(config);
});
app.get('/debug', (req, res) => {
  res.status(200).json(mqttLogger.reportNodes());
});
function debugRoutes(req, res, next) {
  console.log(req.url);
  next();
}
// Main for server
mqttLogger.readYamlConfig('.', (err, configobj) => {
  if (err) {
    console.error(err);
  } else {
    config = configobj;
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
    app.use('/', (req, res, next) => {
      console.log(req.url);
      next();
    })


    app.get('/ota_update/:org/:project/:node/:attribs', (req, res) => {
      const version = req.headers['x-esp8266-version'] || req.headers['x-esp32-version'];
      const currentMD5 = req.headers['x-esp8266-sketch-md5'] || req.headers['x-esp32-sketch-md5'];
      console.log("GET: parms=", req.params, "version:", version, "md5", currentMD5);
      findMostSpecificFile(otadir, req.params.org, req.params.project, req.params.node, req.params.attribs,
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
    const routerNM = express.Router();
    app.use('/node_modules', routerNM);
    //routerData.use('/', (req, res, next) => { console.log("NM:", req.url); next(); });
    routerNM.use(express.static(nodemodulesdir, {immutable: true, maxAge: 1000 * 60 * 60 * 24}));

    // Serve frugal-iot-logger data at /data but configure where to get them.
    const routerData = express.Router();
    app.use('/data', routerData);
    // Important that these aren't cached, or the data will not be updated.
    //routerData.use('/', (req, res, next) => { console.log("D:", req.url); next(); });
    routerData.use(express.static(datadir, {immutable: false}));

    // Server HTML files from a configurable location
    // Use a 1 day cache to keep traffic down
    // Its important that frugaliot.css is cached, or the UX will flash while checking it hasn't changed.
    console.log("Serving from", htmldir);
    // TODO-89 should have db creation separate.
    openOrCreateDatabase((err, db) => {
      if (err) {
        console.error("Error opening or creating database", err);
      } else {
        ///app.use(express.json()); // Not needed
        app.use(express.urlencoded({ extended: true })); // Passport wont function without this
        app.set('trust proxy', 1); // trust first proxy - see note in https://www.npmjs.com/package/express-session
        app.use(session({
          secret: 'keyboard cat', // TODO-89 probably change
          resave: false,
          saveUninitialized: false,
          cookie: { secure: 'auto' }  // TODO-89 cant be secure: true while testing on HTTP
        }));
        passport.serializeUser(function(user, cb) {
          process.nextTick(function() {
            console.log("Serializing");
            return cb(null, {
              id: user.id,
              username: user.username,
              picture: user.organization,
            });
          });
        });
        passport.deserializeUser(function(user, cb) {
          process.nextTick(function() {
            console.log("Deserializing");
            return cb(null, user);
          });
        });
        console.log("Setting up passport for login and register")
        //https://www.passportjs.org/howtos/password/
        app.use(passport.authenticate('session')); // Add user to req.user
        app.get('/dashboard',
          (req,res,next) => { console.log("/dashboard handler"); next(); },
          //passport.authenticate('session'), // Add user to req.user
          (req,res,next) => {
          console.log("/dashboard authenticated or not:", req.user); next(); },
          (req, res) => {
            if (req.user) {
              res.status(200).sendFile(process.cwd() + '/dashboard.html');
            } else {
              res.redirect(307, "/login.html?tab=signin");
            }
          }
        );
        // TODO-89 ==== Working from here down =====
        app.post('/login',
          passport.authenticate('local', {
          session: true,
          successRedirect: '/GOOD',
          failureRedirect: '/BAD'
        }));
        /*
        app.post('/login', passport.authenticate('local', { session: false }), (req, res) => {
          res.status(200).json(req.user);
        });
         */
        /* Next is actually /register - but /login for debugging */
        app.post('/register', (req, res) => {
          console.log("username=", req.body.username); // may want to log registrations
          console.log("password=", req.body.password); //TODO-89 remove !
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
                  db.run('INSERT INTO users (username, hashed_password, salt, organization) VALUES (?, ?, ?, ?)',
                    [username, hashedPassword, salt, organization], (err) => {
                      if (err) {
                        res.status(500).json({ message: 'Internal error' });
                      } else {
                        res.status(200).json({ message: 'User created' });
                      }
                    });
                }
              });
            }
          });
        });
        const routerPrivate = express.Router();
        app.use('/private', routerPrivate);
        routerPrivate.use(
          (req,res,next) => {
            console.log("/private handler for", req.url);
            next(); },
          passport.authenticate('session'),
          (req,res,next) => {
            console.log("/private handler authenticated by session for", req.url); next(); },
          // TODO-89 should configure where /private is - maybe in frugal-iot-client
          express.static("./private", {immutable: true, maxAge: 1000 * 60 * 60 * 24}));

          // function(req, res, next)
        // Default catches rest (especially "/" so should be last)
        app.use(
          (req,res,next) => {
            console.log("Default handler for", req.url); next(); },
          express.static(htmldir, {immutable: true, maxAge: 1000 * 60 * 60 * 24}));
        startServer();
        //mqttLogger.start(); //TODO-89 uncomment
      }
    });
  }
});



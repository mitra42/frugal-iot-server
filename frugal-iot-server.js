/*
  Simple server for FrugalIoT

  * Serves up UI files
  * Maintains a client that watches MQTT broker
  * Has data management and graphing functionality
 */
import express from 'express'; // http://expressjs.com/
import morgan from 'morgan'; // https://www.npmjs.com/package/morgan - http request logging
// Production
//import { MqttLogger } from "frugal-iot-logger";  // https://github.com/mitra42/frugal-iot-logger
// Development
import { MqttLogger } from "../frugal-iot-logger/index.js";  // https://github.com/mitra42/frugal-iot-logger
import { access, constants, createReadStream } from 'fs'; // https://nodejs.org/api/fs.html
import { detectSeries } from 'async'; // https://caolan.github.io/async/v3/docs.html
import { createMD5 } from 'hash-wasm';


//const htmldir = process.cwd() + "/node_modules/frugal-iot-client";
// Production
//const htmldir = process.cwd() + "/node_modules/frugal-iot-client";  // This is an alternative when developing client and server
//const nodemodulesdirparent = process.cwd(); //TODO-84 this will probably move as split things up
// Development
const htmldir = process.cwd() + "/../frugal-iot-client";  // This is an alternative when developing client and server
const nodemodulesdirparent = process.cwd(); //TODO-84 this will probably move as split things up but not its also used for serving /data
const otadir = process.cwd() + "/ota"; // Hieararchy of bin files for OTA updates
let config;
let mqttLogger = new MqttLogger();

const optionsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // Probably Needs: GET, OPTIONS HEAD, do not believe can do POST, PUT, DELETE yet but could be wrong about that.
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  // Needs: Range; User-Agent; Not Needed: Authorization; Others are suggested in some online posts
  'Access-Control-Allow-Headers': 'Cache-Control, Content-Type, Content-Length, Range, User-Agent, X-Requested-With',
};
/*
// Not currently used, might add back
const responseHeaders = {
  'Access-Control-Allow-Origin': '*',  // Needed if have CORS issues with things included
  server: 'express/frugaliot',         // May be worth indicating
  Connection: 'keep-alive',            // Helps with load, but since serving static it might not be useful
  'Keep-Alive': 'timeout=5, max=1000', // Up to 5 seconds idle, 1000 requests max
};
app.use((req, res, next) => {
  res.set(responseHeaders);
  if (req.url.length > 1 && req.url.endsWith('/')) { // Strip trailing slash
    req.url = req.url.slice(0, req.url.length - 1);
    console.log(`Rewriting url to ${req.url}`);
  }
  next(); });
*/
// ============ Helper functions ============
function findMostSpecificFile(topdir, org, project, node, attribs, cb) {
  let possfiles = [
    `${project}/${node}`,
    `+/${node}`,
    `${project}/+`,
    `+/+`].map(x => `${topdir}/${org}/${x}/${attribs}/frugal-iot.ino.bin`);
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
  /*



   */
}

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

// Respond to options - not sure if really needed, but seems to help in other servers.
app.options('/', (req, res) => {
  res.set(optionsHeaders);
  res.sendStatus(200);
});

// app.use(express.json()); // Uncomment if expecting Requests with a JSON body http://expressjs.com/en/5x/api.html#express.json


app.get('/echo', (req, res) => {
  res.status(200).json(req.headers);
});
app.get('/config.json', (req, res) => {
  res.status(200).json(config);
});
// Main for server
mqttLogger.readYamlConfig('./config.yaml', (err, configobj) => {
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
    app.use('/', (req, res, next) => {
      console.log(req.url);
      next();
    })


    app.get('/ota_update/:org/:project/:node/:attribs', (req, res) => {
      const version = req.headers['x-esp8266-version'];
      const currentMD5 = req.headers['x-esp8266-sketch-md5'];
      console.log("GET: parms=",req.params,"version:",version,"md5",currentMD5);
      findMostSpecificFile(otadir, req.params.org, req.params.project, req.params.node, req.params.attribs,
        (err, path) => {
          if (err) {
            console.error(err);
            res.sendStatus(304);
          } else {
            if (path) {
              calculateFileMd5(path, (err, md5) => {
                console.log("Found OTA file at", path, "with MD5",);
                if (md5 === currentMD5) {
                  console.log("MD5 matches, no update needed");
                  res.sendStatus(304);
                } else {
                  console.log("MD5 does not match, sending update");
                  res.sendFile(path);
                }
              });
            } else { // None of the paths matched
              console.log("No OTA file for",req.url);
              res.sendStatus(304);
            }
          }
        });
    });

    console.log("Serving from", htmldir);
    // Use a 1 day cache to keep traffic down TODO might want to override for /data/
    // Its important that frugaliot.css is cached, or the UX will flash while checking it hasn't changed.
    app.use(express.static(htmldir, {immutable: true, maxAge: 1000 * 60 * 60 * 24}));
    //TODO  Careful as this line is also unintentionally serving up /data and can insecurely server up config.yaml TODO-SECURITY
    app.use(express.static(nodemodulesdirparent, {immutable: true, maxAge: 1000 * 60 * 60 * 24}));
    startServer();
    mqttLogger.start();
  }
});


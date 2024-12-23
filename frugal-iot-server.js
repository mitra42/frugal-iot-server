/*
  Simple server for FrugalIoT

  * Serves up UI files
  * Maintains a client that watches MQTT broker
  * Has data management and graphing functionality
 */
import express from 'express'; // http://expressjs.com/
import morgan from 'morgan'; // https://www.npmjs.com/package/morgan - http request logging
// Production
import { MqttLogger } from "frugal-iot-logger";  // https://github.com/mitra42/frugal-iot-logger
// Development
//import { MqttLogger } from "../frugal-iot-logger/index.js";  // https://github.com/mitra42/frugal-iot-logger

//const htmldir = process.cwd() + "/node_modules/frugal-iot-client";
// Production
const htmldir = process.cwd() + "/node_modules/frugal-iot-client";  // This is an alternative when developing client and server
const nodemodulesdirparent = process.cwd(); //TODO-84 this will probably move as split things up
// Development
//const htmldir = process.cwd() + "/../frugal-iot-client";  // This is an alternative when developing client and server
//const nodemodulesdirparent = process.cwd(); //TODO-84 this will probably move as split things up but not its also used for serving /data
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


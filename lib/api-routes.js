/**
 * API Route Handlers for Farm-Platform to Device-Platform Requests
 * Implements API.md Section 6
 */

import { Router } from 'express';
import {
  getUserById,
  getPlatformById,
  registerFarm,
  getUserIdByUsername,
  registerPlatform,
  getAllPlatforms,
  getFarmsByOrg
} from './database.js';
import {
  loadDeviceData,
  toSenMLPacket,
  parseTimestamp,
  validateTimeRange,
  deviceExists
} from './data-loader.js';
import {
  APIError,
  apiErrorHandler,
  createSuccessResponse
} from './api-errors.js';
// Reused directly from the main server rather than reimplemented - see frugal-iot-server.js
import { loggedInOrFail, can_ADMIN_JSON, can_ADMIN_SOME, can_READ, add_project } from '../frugal-iot-server.js';

/**
 * Create API router for farm-platform endpoints
 * A "router" is an object which has had a bunch of router.get and router.post applied to it, its rules are then
 * added for a particular path so router.get('/data') when added via app.use('/api', router) applies that function to /api/data
 * @param {sqlite3.Database} db - SQLite database connection
 * @param {string} dataDir - Base data directory path
 * @param {Object} loggerClient - Logger client for schema/MQTT operations (required)
 * @param {Object} pushManager - Farm-platform push manager (optional)
 * @returns {Router} Express router with all endpoints
 */
export function createAPIRouter(db, dataDir, loggerClient, pushManager = null) {
  const router = Router();

  /**
   * GET /data - Request historical sensor data
   * API.md Section 6.2
   * Status: works on live server
   * Example: https://frugaliot.naturalinnovation.org/api/data?device=dev/lotus/esp8266-fb94bb&from=2026-05-02T12:00:00Z&to=2026-05-02T13:00:00Z
   */
  router.get('/data',
    (req, res, next) => {
      // can_READ (reused from frugal-iot-server.js) reads the org from res.locals.org, so set it
      // first - device is org/project/node/... e.g. dev/lotus/esp8266-fb94bb/sht/temperature.
      const { device } = req.query;
      if (!device) {
        return next(new APIError('invalid_request', 'Missing required parameter: device'));
      }
      res.locals.org = device.split('/')[0];
      next();
    },
    loggedInOrFail,
    can_READ,
    async (req, res, next) => {
      try {
        const { device, from, to } = req.query;

        if (!from) {
          throw new APIError('invalid_request', 'Missing required parameter: from');
        }

        // Parse timestamps
        const fromTime = parseTimestamp(from); // Unix timestamp in seconds
        const toTime = to ? parseTimestamp(to) : Math.floor(Date.now() / 1000); // Unix timestamp in seconds

        // Validate time range
        validateTimeRange(fromTime, toTime);

        console.log("API fetching data from", device, fromTime*1000, toTime*1000);
        // Load data from disk
        const readings = await loadDeviceData(device, dataDir, fromTime, toTime);

        // Convert to SenML format
        const senmlPacket = toSenMLPacket(device, readings);

        // Return SenML packet
        res.setHeader('Content-Type', 'application/senml+json');
        res.json(senmlPacket);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /platforms/register - Register a Farm-Platform in api_platforms
   * Not part of the Farm IoT Interoperability Standard (not documented in API.md) - this is an
   * internal admin operation to set up a platform's row before it can call /farms/register.
   * A platform is not scoped to any one org (that mapping lives in api_farms), so this only requires
   * the caller to be ADMIN on some org, via can_ADMIN_SOME - not a specific one.
   * Status: written by Claude, untested.
   */
  router.post('/platforms/register',
    loggedInOrFail,
    can_ADMIN_SOME,
    async (req, res, next) => {
      try {
        const {
          name,
          user,
          base_url: baseUrl,
          auth_token: authToken,
          cookie_name: cookieName
        } = req.body;

        if (!name) {
          throw new APIError('invalid_request', 'Missing required field: name');
        }

        if (!user) {
          throw new APIError('invalid_request', 'Missing required field: user');
        }

        if (baseUrl) {
          try {
            new URL(baseUrl);
          } catch {
            throw new APIError('invalid_request', 'base_url must be a valid URL');
          }
        }

        const userId = await getUserIdByUsername(db, user);
        if (!userId) {
          throw new APIError('user_not_found', `No user found with username '${user}'`);
        }

        const result = await registerPlatform(db, name, userId, baseUrl, authToken, cookieName);

        res.status(200).json(createSuccessResponse(result));
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /platforms/list - List all Farm-Platforms registered on this Device-Platform
   * Not part of the Farm IoT Interoperability Standard (not documented in API.md) - this is an
   * internal admin operation, used by the dashboard's API tab to drive /farms/register.
   * A platform is not scoped to any one org (that mapping lives in api_farms), so this lists every
   * platform, gated on can_ADMIN_SOME rather than a specific org.
   * Does not return auth_token or cookie_name, as those are secrets.
   */
  router.get('/platforms/list',
    loggedInOrFail,
    can_ADMIN_SOME,
    async (req, res, next) => {
      try {
        const platforms = await getAllPlatforms(db);
        res.status(200).json(platforms);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /farms/list - List farm-to-project mappings registered for an organization
   * Not part of the Farm IoT Interoperability Standard (not documented in API.md) - this is an
   * internal admin operation, used by the dashboard's API tab to show what /farms/register has done.
   */
  router.get('/farms/list',
    loggedInOrFail,
    can_ADMIN_JSON, // org comes from req.query.org, which can_ADMIN_JSON checks for directly
    async (req, res, next) => {
      try {
        const farms = await getFarmsByOrg(db, req.params.org);
        res.status(200).json(farms);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /farms/register - Map a Farm-Platform's farm to a Frugal-IoT org/project
   * API.md Section 6.3
   * Status: written by Claude, untested.
   * Auth is via the caller's Frugal-IoT dashboard session (same as the admin dashboard routes in
   * frugal-iot-server.js), not the platform token described in API.md Section 3.4.
   */
  router.post('/farms/register',
    loggedInOrFail,
    (req, res, next) => {
      // can_ADMIN_JSON (reused from frugal-iot-server.js) reads the org from res.locals.org, so set
      // it first - here the org is the first part of the compound device-platform-farm-id field.
      const devicePlatformFarmId = req.body['device-platform-farm-id'];
      const parts = typeof devicePlatformFarmId === 'string' ? devicePlatformFarmId.split('/') : [];
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return next(new APIError('invalid_request', "device-platform-farm-id must be of the form 'org/project'"));
      }
      res.locals.org = parts[0];
      next();
    },
    can_ADMIN_JSON,
    async (req, res, next) => {
      try {
        const {
          platform_id: platformIdInput,
          'farm-platform-farm-id': farmPlatformFarmId,
          'device-platform-farm-id': devicePlatformFarmId
        } = req.body;

        if (platformIdInput === undefined || platformIdInput === null) {
          throw new APIError('invalid_request', 'Missing required field: platform_id');
        }

        if (!farmPlatformFarmId) {
          throw new APIError('invalid_request', 'Missing required field: farm-platform-farm-id');
        }

        const [org, project] = devicePlatformFarmId.split('/');

        const platformId = await getPlatformById(db, platformIdInput);
        if (!platformId) {
          throw new APIError('platform_not_found', `No platform registered with platform_id ${platformIdInput}`);
        }

        // Create the project if it doesn't already exist (add_project is reused from frugal-iot-server.js)
        await new Promise((resolve, reject) => {
          add_project(org, project, project, (err) => {
            if (err && err.message !== 'Already Exists') reject(new APIError('server_error', err.message));
            else resolve();
          });
        });

        const result = await registerFarm(db, platformId, farmPlatformFarmId, org, project);

        res.status(200).json(createSuccessResponse(result));
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /devices/action - Send a command to a device
   * API.md Section 6.6
   * Status: Written by Claude, untested,
   * TODO-API this looks wrong, if e.g. command='temperature' parameters = { max: 123 } it should send that as temperature/max=123
   */
  router.post('/devices/action', async (req, res, next) => {
    try {
      const {
        'device-id': deviceId,
        command,
        parameters  // { value: '123' }
      } = req.body;

      // Validate required fields
      if (!deviceId) {
        throw new APIError('invalid_request', 'Missing required field: device-id');
      }

      if (!command) {
        throw new APIError('invalid_request', 'Missing required field: command');
      }

      if (!parameters || parameters.value === undefined) {
        throw new APIError('invalid_request', 'Missing required field: parameters.value');
      }

      // Check if device exists
      const exists = await deviceExists(deviceId, dataDir);
      if (!exists) {
        throw new APIError('device_not_found', `Device ${deviceId} not found`);
      }

       // Validate against device schema and send command via logger
       const [org, project, devId] = deviceId.split('/');
       const schema = await loggerClient.getDeviceSchema(org, project, devId);

       // Validate command against schema
       const validation = loggerClient.validateCommandAgainstSchema(
         schema,
         command,
         parameters.value
       );

       if (!validation.valid) {
         throw new APIError('invalid_value', validation.error);
       }

       // Send command via logger MQTT client
       const cmdResult = await loggerClient.sendCommand(org, project, devId, command, parameters.value);

       res.status(200).json(createSuccessResponse({
         status: cmdResult.status,
         reason: cmdResult.message
       }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /devices/schema - Get device schema
   * API.md Section 5.2
   * Status: Works well, on live device
   */
  router.get('/devices/schema',
    (req, res, next) => {
      // can_READ (reused from frugal-iot-server.js) reads the org from res.locals.org, so set it
      // first - device is org/project/node e.g. dev/lotus/esp8266-fb94bb.
      const { device } = req.query;
      if (!device) {
        return next(new APIError('invalid_request', 'Missing required parameter: device'));
      }
      res.locals.org = device.split('/')[0];
      next();
    },
    loggedInOrFail,
    can_READ,
    async (req, res, next) => {
      try {
        const { device } = req.query;

        // Check if device exists
        const exists = await deviceExists(device, dataDir);
        if (!exists) {
          throw new APIError('device_not_found', `Device ${device} not found`);
        }

        // Get schema from logger
        const [org, project, devId] = device.split('/');
        const schema = await loggerClient.getDeviceSchema(org, project, devId);

        res.setHeader('Content-Type', 'application/json');
        res.json(schema);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

/**
 * Error handler middleware for API routes
 * Should be added after all routes
 */
export function createAPIErrorHandler() {
  return (err, req, res, next) => {
    // Handle body-parser JSON errors
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      const apiErr = new APIError('invalid_request', 'Invalid JSON in request body');
      return res.status(apiErr.status).json(apiErr.toJSON());
    }

    // Use standard API error handler
    apiErrorHandler(err, req, res, next);
  };
}






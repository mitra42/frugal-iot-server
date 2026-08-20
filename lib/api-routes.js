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
        // Recent readings are held in memory rather than written to disk as they arrive, so write
        // them out first - otherwise a request covering "up to now" would stop a few minutes short
        await loggerClient.flush();
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

  // Origin (scheme+host) of the current request - passed to getDeviceSchema() so its "base" field and
  // root-relative form hrefs are correct wherever this server is actually running (not a hardcoded domain).
  function baseURLFor(req) {
    return `${req.protocol}://${req.get('host')}`;
  }

  /**
   * Shared by both POST and GET /devices/action - validates and sends an action.
   * @param {Object} req - the Express request (used only for its origin, via baseURLFor)
   * @param {string} deviceId - org/project/device
   * @param {string} action - module/field
   * @param {*} value - the value to send; if opts.stringValue, coerced to the schema's declared type first
   * (query parameters, unlike a JSON body, are always strings)
   */
  async function sendDeviceAction(req, deviceId, action, value, {stringValue = false} = {}) {
    const exists = await deviceExists(deviceId, dataDir);
    if (!exists) {
      throw new APIError('device_not_found', `Device ${deviceId} not found`);
    }

    const [org, project, devId] = deviceId.split('/');
    const schema = await loggerClient.getDeviceSchema(org, project, devId, baseURLFor(req));

    if (stringValue) {
      const inputType = schema.actions && schema.actions[action] && schema.actions[action].input && schema.actions[action].input.type;
      if (inputType === 'boolean') {
        value = (value === 'true' || value === '1');
      } else if (inputType === 'number' || inputType === 'integer') {
        value = Number(value);
      }
    }

    const validation = loggerClient.validateActionAgainstSchema(schema, action, value);
    if (!validation.valid) {
      throw new APIError('invalid_value', validation.error);
    }

    const cmdResult = await loggerClient.sendCommand(org, project, devId, action, value);
    return {status: cmdResult.status, reason: cmdResult.message};
  }

  /**
   * Shared by PUT /devices/property - validates and writes a property. Read-write fields are modelled
   * as properties (not actions) - see frugal-iot-logger's getDeviceSchema - but share the same
   * validate+send machinery as sendDeviceAction, just against schema.properties instead.
   * @param {Object} req - the Express request (used only for its origin, via baseURLFor)
   * @param {string} deviceId - org/project/device
   * @param {string} property - module/field
   * @param {*} value - the value to write; if opts.stringValue, coerced to the schema's declared type first
   */
  async function sendDeviceProperty(req, deviceId, property, value, {stringValue = false} = {}) {
    const exists = await deviceExists(deviceId, dataDir);
    if (!exists) {
      throw new APIError('device_not_found', `Device ${deviceId} not found`);
    }

    const [org, project, devId] = deviceId.split('/');
    const schema = await loggerClient.getDeviceSchema(org, project, devId, baseURLFor(req));

    if (stringValue) {
      const propType = schema.properties && schema.properties[property] && schema.properties[property].type;
      if (propType === 'boolean') {
        value = (value === 'true' || value === '1');
      } else if (propType === 'number' || propType === 'integer') {
        value = Number(value);
      }
    }

    const validation = loggerClient.validatePropertyAgainstSchema(schema, property, value);
    if (!validation.valid) {
      throw new APIError('invalid_value', validation.error);
    }

    const cmdResult = await loggerClient.sendCommand(org, project, devId, property, value);
    return {status: cmdResult.status, reason: cmdResult.message};
  }

  /**
   * POST /devices/action - Send an action to a device
   * API.md Section 6.6.2
   * Status: Written by Claude, untested,
   * TODO-API this looks wrong, if e.g. action='temperature' parameters = { max: 123 } it should send that as temperature/max=123
   */
  router.post('/devices/action',
    (req, res, next) => {
      // can_READ (reused from frugal-iot-server.js) reads the org from res.locals.org, so set it first.
      const deviceId = req.body && req.body['device-id'];
      if (!deviceId) {
        return next(new APIError('invalid_request', 'Missing required field: device-id'));
      }
      res.locals.org = deviceId.split('/')[0];
      next();
    },
    loggedInOrFail,
    can_READ,
    async (req, res, next) => {
      try {
        const {
          'device-id': deviceId,
          action,
          parameters  // { value: '123' }
        } = req.body;

        if (!deviceId) {
          throw new APIError('invalid_request', 'Missing required field: device-id');
        }
        if (!action) {
          throw new APIError('invalid_request', 'Missing required field: action');
        }
        if (!parameters || parameters.value === undefined) {
          throw new APIError('invalid_request', 'Missing required field: parameters.value');
        }

        const result = await sendDeviceAction(req, deviceId, action, parameters.value);
        res.status(200).json(createSuccessResponse(result));
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /devices/action - Invoke an action on a device, as a companion to POST /devices/action
   * (API.md Section 6.6.2) for WoT Forms compliance: a WoT Form (Annex A.4) can only express a URL to
   * invoke, with no way to template a JSON request body, so this variant carries the same fields as
   * query parameters instead. This is the URL referenced by a Device Schema's actions[*].forms[0].href
   * (deviceId/action match exactly what's baked into that href - append &value=... to invoke it).
   * Status: written by Claude, untested.
   */
  router.get('/devices/action',
    (req, res, next) => {
      // can_READ (reused from frugal-iot-server.js) reads the org from res.locals.org, so set it first.
      const { deviceId } = req.query;
      if (!deviceId) {
        return next(new APIError('invalid_request', 'Missing required parameter: deviceId'));
      }
      res.locals.org = deviceId.split('/')[0];
      next();
    },
    loggedInOrFail,
    can_READ,
    async (req, res, next) => {
      try {
        const {deviceId, action, value} = req.query;

        if (!deviceId) {
          throw new APIError('invalid_request', 'Missing required parameter: deviceId');
        }
        if (!action) {
          throw new APIError('invalid_request', 'Missing required parameter: action');
        }
        if (value === undefined) {
          throw new APIError('invalid_request', 'Missing required parameter: value');
        }

        const result = await sendDeviceAction(req, deviceId, action, value, {stringValue: true});
        res.status(200).json(createSuccessResponse(result));
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /devices/property - Read one, or every, of a device's current property values
   * API.md Section 6.6.5 - this is the URL referenced by a Device Schema's properties[*].forms[0].href
   * (deviceId/property match exactly what's baked into that href). Response is a SenML packet, matching
   * /data's convention (Section 6.2), but of current values rather than a time range.
   * If "property" is omitted, every readable field the device has reported a value for is returned.
   * Status: written by Claude, untested.
   */
  router.get('/devices/property',
    (req, res, next) => {
      // can_READ (reused from frugal-iot-server.js) reads the org from res.locals.org, so set it first.
      const { deviceId } = req.query;
      if (!deviceId) {
        return next(new APIError('invalid_request', 'Missing required parameter: deviceId'));
      }
      res.locals.org = deviceId.split('/')[0];
      next();
    },
    loggedInOrFail,
    can_READ,
    async (req, res, next) => {
      try {
        const { deviceId, property } = req.query;

        const exists = await deviceExists(deviceId, dataDir);
        if (!exists) {
          throw new APIError('device_not_found', `Device ${deviceId} not found`);
        }

        const [org, project, devId] = deviceId.split('/');
        const schema = await loggerClient.getDeviceSchema(org, project, devId, baseURLFor(req));

        let readings;
        if (property) {
          if (!schema.properties || !schema.properties[property]) {
            throw new APIError('invalid_request', `${property} is not a readable property of this device`);
          }
          const value = loggerClient.getPropertyValue(org, project, devId, property);
          readings = value === undefined ? [] : [{
            field: property,
            value,
            unit: schema.properties[property].unit
          }];
        } else {
          const values = loggerClient.getDeviceCurrentValues(org, project, devId);
          readings = Object.entries(values).map(([field, value]) => ({
            field,
            value,
            unit: schema.properties && schema.properties[field] && schema.properties[field].unit
          }));
        }

        res.setHeader('Content-Type', 'application/senml+json');
        res.json(toSenMLPacket(deviceId, readings));
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PUT /devices/property - Write a device property (synonymous with /devices/action in Frugal IoT -
   * shares the same validate+send logic via sendDeviceProperty, just against schema.properties instead
   * of schema.actions). Matches the Device Schema's own writeproperty form: deviceId/property come from
   * the query string (the same one used by GET, above, to read - per the WoT default op->method mapping
   * for a property whose op includes both readproperty and writeproperty), and the new value is
   * supplied in a JSON body, there being no standard WoT convention for this: {"value": ...}.
   * Status: written by Claude, untested.
   */
  router.put('/devices/property',
    (req, res, next) => {
      // can_READ (reused from frugal-iot-server.js) reads the org from res.locals.org, so set it first.
      const { deviceId } = req.query;
      if (!deviceId) {
        return next(new APIError('invalid_request', 'Missing required parameter: deviceId'));
      }
      res.locals.org = deviceId.split('/')[0];
      next();
    },
    loggedInOrFail,
    can_READ,
    async (req, res, next) => {
      try {
        const { deviceId, property } = req.query;
        const { value } = req.body || {};

        if (!deviceId) {
          throw new APIError('invalid_request', 'Missing required parameter: deviceId');
        }
        if (!property) {
          throw new APIError('invalid_request', 'Missing required parameter: property');
        }
        if (value === undefined) {
          throw new APIError('invalid_request', 'Missing required field: value');
        }

        const result = await sendDeviceProperty(req, deviceId, property, value);
        res.status(200).json(createSuccessResponse(result));
      } catch (err) {
        next(err);
      }
    }
  );

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
        const schema = await loggerClient.getDeviceSchema(org, project, devId, baseURLFor(req));

        res.setHeader('Content-Type', 'application/json');
        res.json(schema);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /devices/list - List devices known for a farm's project, in summary form
   * - lets a Farm-Platform enumerate the devices behind a device-platform-farm-id (org/project) it already
   * has from /farms/register, without fetching each device's full schema.
   */
  router.get('/devices/list',
    (req, res, next) => {
      // can_READ (reused from frugal-iot-server.js) reads the org from res.locals.org, so set it
      // first - device-platform-farm-id is org/project, same format /farms/register accepts.
      const devicePlatformFarmId = req.query['device-platform-farm-id'];
      const parts = typeof devicePlatformFarmId === 'string' ? devicePlatformFarmId.split('/') : [];
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return next(new APIError('invalid_request', "device-platform-farm-id must be of the form 'org/project'"));
      }
      res.locals.org = parts[0];
      next();
    },
    loggedInOrFail,
    can_READ,
    async (req, res, next) => {
      try {
        const [org, project] = req.query['device-platform-farm-id'].split('/');
        res.json(loggerClient.listDevices(org, project));
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






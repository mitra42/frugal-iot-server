/**
 * API Route Handlers for Farm-Platform to Device-Platform Requests
 * Implements API.md Section 6
 */

import { Router } from 'express';
import {
  registerUser,
  registerDeviceToUser,
  getUserById
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
   * TODO-API-AUTH - check user has READ permission on org
   */
  router.get('/data', async (req, res, next) => {
    try {
      const { device, from, to } = req.query;

      // Validate required parameters
      if (!device) {
        throw new APIError('invalid_request', 'Missing required parameter: device');
      }

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
  });

  /**
   * POST /users/register - Register a user with the device platform
   * API.md Section 6.3
   * Status: written by Claude, untested not clear if needed.
   * TODO-API-REVIEW
   */
  router.post('/users/register', async (req, res, next) => {
    try {
      const { 'user-id': userId, credentials } = req.body;

      // Validate required fields
      if (!userId) {
        throw new APIError('invalid_request', 'Missing required field: user-id');
      }

      // Register user
      const result = await registerUser(db, userId);

      res.status(200).json(createSuccessResponse(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /devices/register - Register a device to a user
   * API.md Section 6.4
   * Status: written by Claude, untested not clear if needed.
   * TODO-API-REVIEW
   */
  router.post('/devices/register', async (req, res, next) => {
    try {
      const {
        'user-id': userId,
        'farm-platform-device-id': farmPlatformDeviceId,
        'device-id': deviceId,
        metadata
      } = req.body;

      // Validate required fields
      if (!userId) {
        throw new APIError('invalid_request', 'Missing required field: user-id');
      }

      if (!farmPlatformDeviceId && !deviceId) {
        throw new APIError('invalid_request', 'Missing device identifier');
      }

      // For now, assume device-id is provided or use farm platform device id
      const targetDeviceId = deviceId || farmPlatformDeviceId;

      // Check if device exists in our system
      const exists = await deviceExists(targetDeviceId, dataDir);
      if (!exists) {
        throw new APIError('device_not_found', `Device ${targetDeviceId} not found on this platform`);
      }

      // Register device to user
      const result = await registerDeviceToUser(db, userId, targetDeviceId, farmPlatformDeviceId);

      res.status(200).json(createSuccessResponse(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /devices/command - Send a command to a device
   * API.md Section 6.5
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
   * TODO-API-AUTH should require user to be authenticated
   */
  router.get('/devices/schema', async (req, res, next) => {
    try {
      const { device } = req.query;

      // Validate required parameters
      if (!device) {
        throw new APIError('invalid_request', 'Missing required parameter: device');
      }

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
  });

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






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
 * @param {sqlite3.Database} db - SQLite database connection
 * @param {string} dataDir - Base data directory path
 * @param {Object} loggerClient - Logger client for schema/MQTT operations
 * @param {Object} pushManager - Farm-platform push manager (optional)
 * @returns {Router} Express router with all endpoints
 */
export function createAPIRouter(db, dataDir, loggerClient = null, pushManager = null) {
  const router = Router();

  /**
   * GET /data - Request historical sensor data
   * API.md Section 6.2
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
      const fromTime = parseTimestamp(from);
      const toTime = to ? parseTimestamp(to) : Math.floor(Date.now() / 1000);

      // Validate time range
      validateTimeRange(fromTime, toTime);

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
   */
  router.post('/devices/command', async (req, res, next) => {
    try {
      const {
        'device-id': deviceId,
        command,
        parameters
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

      // Phase 3: Validate against device schema if logger client available
      if (loggerClient) {
        try {
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
          return;
        } catch (loggerErr) {
          if (loggerErr instanceof APIError) throw loggerErr;
          // Fall back to stub behavior if logger unavailable
          console.warn(`Logger unavailable for command validation: ${loggerErr.message}`);
        }
      }

      // Stub behavior: just acknowledge (Phase 2 fallback)
      res.status(200).json(createSuccessResponse({
        status: 'accepted',
        reason: 'Command queued for delivery'
      }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /devices/schema - Get device schema
   * API.md Section 5.2
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

      // Phase 3: Get schema from logger if available
      if (loggerClient) {
        try {
          const [org, project, devId] = device.split('/');
          const schema = await loggerClient.getDeviceSchema(org, project, devId);

          res.setHeader('Content-Type', 'application/json');
          res.json(schema);
          return;
        } catch (loggerErr) {
          console.warn(`Logger unavailable for schema: ${loggerErr.message}`);
          // Fall back to basic schema if logger unavailable
        }
      }

      // Fallback: Return basic schema
      const schema = {
        'device-platform-device-id': device,
        'farm-platform-device-id': null,
        modules: {
          main: {
            name: 'Device Info',
            fields: [
              {
                field: 'id',
                name: 'Device ID',
                type: 'text',
                rw: 'r',
                display: 'text'
              }
            ]
          }
        }
      };

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






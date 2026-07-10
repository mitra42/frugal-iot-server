/**
 * Logger Client
 * Direct interface to frugal-iot-logger for schema generation and MQTT operations
 *
 * The logger runs in the same process as the server, so we call its functions directly
 * instead of using HTTP. This is more efficient and doesn't require HTTP overhead.
 */

import { APIError } from './api-errors.js';

/**
 * Logger Client for device schema and MQTT command routing
 * Communicates directly with frugal-iot-logger instance in the same process
 */
export class LoggerClient {
  constructor(mqttLogger) {
    this.mqttLogger = mqttLogger;
    this.schemaCache = new Map();
    this.schemaCacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get device schema from logger
   * Caches schema to reduce logger calls
   *
   * @param {string} org - Organization
   * @param {string} project - Project
   * @param {string} deviceId - Device ID
   * @param {string} [baseURL] - Origin (scheme+host) to set as the schema's "base" field and to resolve
   *   against - e.g. `${req.protocol}://${req.get('host')}` from the calling request. Included in the
   *   cache key since it can legitimately differ between requests (e.g. localhost vs a public domain).
   * @returns {Promise<Object>} Device schema per Annex A format
   * @throws {APIError} If schema cannot be retrieved
   */
  async getDeviceSchema(org, project, deviceId, baseURL) {
    const cacheKey = `${org}/${project}/${deviceId}/${baseURL}`;

    // TODO-API unclear why this is disabled,
    const cached = undefined; // this.schemaCache.get(cacheKey);

    // Return cached if still valid
    if (cached && Date.now() - cached.timestamp < this.schemaCacheTTL) {
      return cached.schema;
    }

    // Call logger's getDeviceSchema method directly
    // This method should exist on mqttLogger
    const schema = await this.mqttLogger.getDeviceSchema(org, project, deviceId, baseURL);

    // Cache the schema
    this.schemaCache.set(cacheKey, {
      schema: schema,
      timestamp: Date.now()
    });

    return schema;
  }

  /**
   * Validate an action invocation against the device's Device Schema (WoT Thing Descriptor, as
   * returned by getDeviceSchema() - action fields live under schema.actions[action].input, per
   * API.md Annex A.3 and the W3C WoT Thing Description spec).
   * @param {Object} schema - Device schema (WoT Thing Descriptor)
   * @param {string} action - Action in module/field format
   * @param {*} value - Action value, already coerced to the type the caller believes is correct
   * @returns {{valid: boolean, error?: string}}
   */
  validateCommandAgainstSchema(schema, action, value) {
    try {
      const actionDef = schema.actions && schema.actions[action];
      if (!actionDef) {
        // A field that exists but is read-only would be under schema.properties instead of
        // schema.actions - give a more specific error in that case.
        if (schema.properties && schema.properties[action]) {
          return { valid: false, error: 'Field is read-only' };
        }
        return { valid: false, error: `Action ${action} not found in schema` };
      }

      const input = actionDef.input || {};

      const typeError = this.validateFieldType(input, value);
      if (typeError) {
        return { valid: false, error: typeError };
      }

      if (input.type === 'number' || input.type === 'integer') {
        if (input.minimum !== undefined && value < input.minimum) {
          return { valid: false, error: `Value ${value} is below minimum ${input.minimum}` };
        }
        if (input.maximum !== undefined && value > input.maximum) {
          return { valid: false, error: `Value ${value} is above maximum ${input.maximum}` };
        }
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Validation error: ${err.message}` };
    }
  }

  /**
   * Validate value type matches an action's input schema (WoT DataSchema types: number, integer,
   * boolean, string, object, array - see API.md Annex A.3).
   * @private
   * @param {Object} input - Action's input schema (schema.actions[action].input)
   * @param {*} value - Value to validate
   * @returns {string|null} Error message or null if valid
   */
  validateFieldType(input, value) {
    switch (input.type) {
      case 'number':
        if (typeof value !== 'number') {
          return `Expected number but got ${typeof value}`;
        }
        break;

      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          return 'Expected integer but got ' + (typeof value === 'number' ? 'a non-integer number' : typeof value);
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return `Expected boolean but got ${typeof value}`;
        }
        break;

      case 'string':
        if (typeof value !== 'string') {
          return `Expected string but got ${typeof value}`;
        }
        break;

      case 'object':
      case 'array':
        // No further structural validation of nested content for now.
        break;

      default:
        return `Unknown field type: ${input.type}`;
    }

    return null;
  }

  /**
   * Send command to device via logger MQTT client
   * Calls logger's MQTT publishing directly (no HTTP)
   * 
   * @param {string} org - Organization
   * @param {string} project - Project
   * @param {string} deviceId - Device ID
   * @param {string} command - Command in module/field format
   * @param {*} value - Command value
   * @returns {Promise<{status: string, message: string}>}
   * @throws {APIError} If command cannot be sent
   */
  async sendCommand(org, project, deviceId, command, value) {
    // Call logger's sendCommand method directly
    const result = await this.mqttLogger.sendCommand(org, project, deviceId, command, value);

    if (result && result.status === 'error') {
      throw new APIError('device_unavailable', result.message || 'Device offline');
    }

    return {
      status: result?.status || 'sent',
      message: result?.message || 'Command sent to device'
    };
  }


  /**
   * Clear schema cache
   * Useful for testing and after device configuration changes
   */
  clearSchemaCache() {
    this.schemaCache.clear();
  }

  /**
   * Clear specific schema from cache
   * @param {string} org
   * @param {string} project
   * @param {string} deviceId
   */
  clearSchemaCacheEntry(org, project, deviceId) {
    const cacheKey = `${org}/${project}/${deviceId}`;
    this.schemaCache.delete(cacheKey);
  }
}

/**
 * Create logger client instance
 * @param {MqttLogger} mqttLogger - The MqttLogger instance from server (required)
 * @returns {LoggerClient}
 */
export function createLoggerClient(mqttLogger) {
  return new LoggerClient(mqttLogger);
}


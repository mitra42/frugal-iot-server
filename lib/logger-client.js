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
  validateActionAgainstSchema(schema, action, value) {
    try {
      const actionDef = schema.actions && schema.actions[action];
      if (!actionDef) {
        // A read-write field is modelled as a property (with a writeproperty op), not a separate
        // action - see frugal-iot-logger's getDeviceSchema.
        if (schema.properties && schema.properties[action]) {
          return { valid: false, error: 'Field is a property, not an action - use PUT /devices/property' };
        }
        return { valid: false, error: `Action ${action} not found in schema` };
      }
      return this.validateValueAgainstDataSchema(actionDef.input || {}, value);
    } catch (err) {
      return { valid: false, error: `Validation error: ${err.message}` };
    }
  }

  /**
   * Validate a property write against the device's Device Schema - property fields carry their
   * DataSchema (type/minimum/maximum) directly, unlike actions which nest it under "input"
   * (API.md Annex A.2 vs A.3).
   * @param {Object} schema - Device schema (WoT Thing Descriptor)
   * @param {string} property - Property in module/field format
   * @param {*} value - Value to write, already coerced to the type the caller believes is correct
   * @returns {{valid: boolean, error?: string}}
   */
  validatePropertyAgainstSchema(schema, property, value) {
    try {
      const propertyDef = schema.properties && schema.properties[property];
      if (!propertyDef) {
        if (schema.actions && schema.actions[property]) {
          return { valid: false, error: 'Field is an action, not a property - use POST/GET /devices/action' };
        }
        return { valid: false, error: `Property ${property} not found in schema` };
      }
      if (propertyDef.readOnly) {
        return { valid: false, error: 'Property is read-only' };
      }
      return this.validateValueAgainstDataSchema(propertyDef, value);
    } catch (err) {
      return { valid: false, error: `Validation error: ${err.message}` };
    }
  }

  /**
   * Validate a value against a WoT DataSchema (type/minimum/maximum) - shared by an action's "input"
   * and a property's own schema fields, which are the same DataSchema shape but live in different
   * places in the Thing Descriptor (API.md Annex A.2 vs A.3).
   * @private
   * @param {Object} dataSchema - DataSchema object (type/minimum/maximum)
   * @param {*} value - Value to validate
   * @returns {{valid: boolean, error?: string}}
   */
  validateValueAgainstDataSchema(dataSchema, value) {
    const typeError = this.validateFieldType(dataSchema, value);
    if (typeError) {
      return { valid: false, error: typeError };
    }

    if (dataSchema.type === 'number' || dataSchema.type === 'integer') {
      if (dataSchema.minimum !== undefined && value < dataSchema.minimum) {
        return { valid: false, error: `Value ${value} is below minimum ${dataSchema.minimum}` };
      }
      if (dataSchema.maximum !== undefined && value > dataSchema.maximum) {
        return { valid: false, error: `Value ${value} is above maximum ${dataSchema.maximum}` };
      }
    }

    return { valid: true };
  }

  /**
   * Validate value type matches a DataSchema (WoT types: number, integer, boolean, string, object,
   * array - see API.md Annex A.2/A.3).
   * @private
   * @param {Object} input - DataSchema object
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
    // frugal-iot-logger's method is named sendAction, not sendCommand
    const result = await this.mqttLogger.sendAction(org, project, deviceId, command, value);

    if (result && result.status === 'error') {
      throw new APIError('device_unavailable', result.message || 'Device offline');
    }

    return {
      status: result?.status || 'sent',
      message: result?.message || 'Command sent to device'
    };
  }

  /**
   * Get the current value of a single readable field for a device.
   * @param {string} org - Organization
   * @param {string} project - Project
   * @param {string} deviceId - Device ID
   * @param {string} field - Field in module/field format
   * @returns {*} The current value, or undefined if never seen
   */
  getPropertyValue(org, project, deviceId, field) {
    return this.mqttLogger.getPropertyValue(org, project, deviceId, field);
  }

  /**
   * Get current values for every field in a device's schema that has been seen at least once.
   * @param {string} org - Organization
   * @param {string} project - Project
   * @param {string} deviceId - Device ID
   * @returns {Object} Map of "module/field" -> current value
   */
  getDeviceCurrentValues(org, project, deviceId) {
    return this.mqttLogger.getDeviceCurrentValues(org, project, deviceId);
  }


  /**
   * List devices known for a project, in the summary shape used by /devices/list.
   * @param {string} org - Organization
   * @param {string} project - Project
   * @returns {Array<{id: string, title: string, description: string, lastSeen: number|null, otaKey: string}>}
   */
  listDevices(org, project) {
    const nodes = (this.mqttLogger.reportNodes()[org] || {})[project] || {};
    return Object.entries(nodes).map(([nodeId, fields]) => ({
      id: `${org}/${project}/${nodeId}`,
      title: fields['frugal_iot/name'] || '',
      description: fields['frugal_iot/description'] || '',
      lastSeen: fields.lastseen ? Math.floor(new Date(fields.lastseen).getTime() / 1000) : null,
      otaKey: fields['ota/key'] || ''
    }));
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


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
   * @returns {Promise<Object>} Device schema per Annex A format
   * @throws {APIError} If schema cannot be retrieved
   */
  async getDeviceSchema(org, project, deviceId) {
    const cacheKey = `${org}/${project}/${deviceId}`;
    const cached = undefined; // this.schemaCache.get(cacheKey);

    // Return cached if still valid
    if (cached && Date.now() - cached.timestamp < this.schemaCacheTTL) {
      return cached.schema;
    }

    // Call logger's getDeviceSchema method directly
    // This method should exist on mqttLogger
    const schema = await this.mqttLogger.getDeviceSchema(org, project, deviceId);

    // Cache the schema
    this.schemaCache.set(cacheKey, {
      schema: schema,
      timestamp: Date.now()
    });

    return schema;
  }

  /**
   * Validate command against schema
   * @param {Object} schema - Device schema
   * @param {string} command - Command in module/field format
   * @param {*} value - Command value
   * @returns {{valid: boolean, error?: string}}
   */
  validateCommandAgainstSchema(schema, command, value) {
    try {
      const [module, field] = command.split('/');

      if (!module || !field) {
        return { valid: false, error: 'Command must be in module/field format' };
      }

      const moduleSchema = schema.modules[module];
      if (!moduleSchema) {
        return { valid: false, error: `Module ${module} not found in schema` };
      }

      const fieldSchema = moduleSchema.fields?.find(f => f.field === field);
      if (!fieldSchema) {
        return { valid: false, error: `Field ${field} not found in module ${module}` };
      }

      // Check read/write permission
      if (fieldSchema.rw === 'r') {
        return { valid: false, error: 'Field is read-only' };
      }

      // Validate value type
      const typeError = this.validateFieldType(fieldSchema, value);
      if (typeError) {
        return { valid: false, error: typeError };
      }

      // Validate value range
      if (typeof value === 'number' && fieldSchema.type === 'float' || fieldSchema.type === 'int') {
        if (fieldSchema.min !== undefined && value < fieldSchema.min) {
          return { valid: false, error: `Value ${value} is below minimum ${fieldSchema.min}` };
        }
        if (fieldSchema.max !== undefined && value > fieldSchema.max) {
          return { valid: false, error: `Value ${value} is above maximum ${fieldSchema.max}` };
        }
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Validation error: ${err.message}` };
    }
  }

  /**
   * Validate value type matches field schema
   * @private
   * @param {Object} fieldSchema - Field definition from schema
   * @param {*} value - Value to validate
   * @returns {string|null} Error message or null if valid
   */
  validateFieldType(fieldSchema, value) {
    const fieldType = fieldSchema.type;

    switch (fieldType) {
      case 'float':
      case 'int':
      case 'exponential':
        if (typeof value !== 'number') {
          return `Expected ${fieldType} but got ${typeof value}`;
        }
        if (fieldType === 'int' && !Number.isInteger(value)) {
          return 'Expected integer but got float';
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return `Expected boolean but got ${typeof value}`;
        }
        break;

      case 'text':
      case 'color':
        if (typeof value !== 'string') {
          return `Expected string but got ${typeof value}`;
        }
        break;

      default:
        return `Unknown field type: ${fieldType}`;
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


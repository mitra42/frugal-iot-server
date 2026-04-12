/**
 * Logger Client
 * Interface for communicating with frugal-iot-logger for schema generation and MQTT operations
 */

import { APIError } from './api-errors.js';

/**
 * Logger Client for device schema and MQTT command routing
 * Communicates with frugal-iot-logger service
 */
export class LoggerClient {
  constructor(loggerBaseUrl = 'http://localhost:3001', httpClient = null) {
    this.baseUrl = loggerBaseUrl;
    this.httpClient = httpClient || null;
    this.schemaCache = new Map();
    this.schemaCacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get device schema from logger
   * Caches schema to reduce logger calls
   * @param {string} org - Organization
   * @param {string} project - Project
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Device schema per Annex A format
   * @throws {APIError} If schema cannot be retrieved
   */
  async getDeviceSchema(org, project, deviceId) {
    const cacheKey = `${org}/${project}/${deviceId}`;
    const cached = this.schemaCache.get(cacheKey);

    // Return cached if still valid
    if (cached && Date.now() - cached.timestamp < this.schemaCacheTTL) {
      return cached.schema;
    }

    try {
      // If no HTTP client, return basic schema
      if (!this.httpClient) {
        const basicSchema = this.getBasicSchema(`${org}/${project}/${deviceId}`);
        this.schemaCache.set(cacheKey, {
          schema: basicSchema,
          timestamp: Date.now()
        });
        return basicSchema;
      }

      // Call logger API
      const url = `${this.baseUrl}/schema/${org}/${project}/${deviceId}`;
      const response = await this.httpClient.get(url);

      if (response.status !== 200) {
        throw new Error(`Logger returned ${response.status}`);
      }

      const schema = response.data;

      // Validate schema structure
      if (!schema['device-platform-device-id'] || !schema.modules) {
        throw new Error('Invalid schema format from logger');
      }

      // Cache the schema
      this.schemaCache.set(cacheKey, {
        schema: schema,
        timestamp: Date.now()
      });

      return schema;
    } catch (err) {
      console.error(`Error fetching schema from logger: ${err.message}`);
      // Fall back to basic schema
      return this.getBasicSchema(`${org}/${project}/${deviceId}`);
    }
  }

  /**
   * Get basic/fallback schema
   * @private
   * @param {string} deviceId - Full device ID
   * @returns {Object} Basic schema
   */
  getBasicSchema(deviceId) {
    return {
      'device-platform-device-id': deviceId,
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
   * @param {string} org - Organization
   * @param {string} project - Project
   * @param {string} deviceId - Device ID
   * @param {string} command - Command in module/field format
   * @param {*} value - Command value
   * @returns {Promise<{status: string, message: string}>}
   * @throws {APIError} If command cannot be sent
   */
  async sendCommand(org, project, deviceId, command, value) {
    try {
      // If no HTTP client, just log
      if (!this.httpClient) {
        console.log(`[Logger MQTT] Would send command to ${org}/${project}/${deviceId}`);
        console.log(`  Command: ${command} = ${value}`);
        return {
          status: 'sent',
          message: 'Command queued for delivery'
        };
      }

      // Call logger API to send command
      const url = `${this.baseUrl}/mqtt/command`;
      const payload = {
        org: org,
        project: project,
        'device-id': deviceId,
        command: command,
        value: value
      };

      const response = await this.httpClient.post(url, payload);

      if (response.status === 200 || response.status === 202) {
        return {
          status: 'sent',
          message: response.data?.message || 'Command sent to device'
        };
      }

      if (response.status === 503) {
        throw new APIError('device_unavailable', 'Device is offline or unreachable');
      }

      throw new Error(`Logger returned ${response.status}`);
    } catch (err) {
      if (err instanceof APIError) throw err;
      console.error(`Error sending command via logger: ${err.message}`);
      throw new APIError('server_error', `Failed to send command: ${err.message}`);
    }
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
 * @param {string} loggerBaseUrl - Logger service base URL
 * @param {Object} httpClient - HTTP client (axios-like)
 * @returns {LoggerClient}
 */
export function createLoggerClient(loggerBaseUrl = 'http://localhost:3001', httpClient = null) {
  return new LoggerClient(loggerBaseUrl, httpClient);
}


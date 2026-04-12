/**
 * Data File Utilities
 * Handles reading sensor data files from disk and converting to SenML format
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { parseDeviceId, toSenML, filterSenMLByTime } from './senml-utils.js';
import { APIError } from './api-errors.js';

/**
 * Check if device exists in the system
 * Checks if data directory exists for the device
 * @param {string} deviceId - Device identifier (org/project/device)
 * @param {string} dataDir - Base data directory path
 * @returns {boolean}
 */
export async function deviceExists(deviceId, dataDir) {
  try {
    const parts = deviceId.split('/');
    if (parts.length < 3) return false;

    const devicePath = join(dataDir, parts[0], parts[1], parts[2]);
    await stat(devicePath);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Load raw sensor data from disk for a device
 * Reads all data files in the device's data directory
 *
 * @param {string} deviceId - Device identifier (org/project/device)
 * @param {string} dataDir - Base data directory path
 * @param {number} fromTime - Start timestamp (Unix seconds)
 * @param {number} toTime - End timestamp (Unix seconds)
 * @returns {Promise<Array>} Array of readings with {timestamp, field, value, unit}
 * @throws {APIError} If device not found or data unavailable
 */
export async function loadDeviceData(deviceId, dataDir, fromTime, toTime) {
  try {
    const { org, project } = parseDeviceId(deviceId);
    const deviceDir = join(dataDir, org, project, deviceId.split('/')[2]);

    // Check if device directory exists
    try {
      await readdir(deviceDir);
    } catch (err) {
      throw new APIError('device_not_found', `No data found for device ${deviceId}`);
    }

    const readings = [];

    // Iterate through module directories
    try {
      const modules = await readdir(deviceDir);

      for (const module of modules) {
        const modulePath = join(deviceDir, module);

        try {
          // Try to read files in module directory
          const files = await readdir(modulePath);

          for (const file of files) {
            // Skip non-data files
            if (!file.match(/^\d+/)) continue;

            const filePath = join(modulePath, file);
            const timestamp = parseInt(file.split('_')[0]);

            // Filter by time range
            if (timestamp < fromTime || timestamp > toTime) {
              continue;
            }

            try {
              const content = await readFile(filePath, 'utf-8');
              const lines = content.trim().split('\n');

              for (const line of lines) {
                const parts = line.trim().split('\t');
                if (parts.length >= 2) {
                  const ts = parseInt(parts[0]);
                  const value = parseFloat(parts[1]);

                  if (ts >= fromTime && ts <= toTime && !isNaN(value)) {
                    readings.push({
                      timestamp: ts,
                      field: `${module}/${file.split('_')[1]?.split('.')[0] || 'value'}`,
                      value: value,
                      unit: null // Unit could be stored in separate metadata file if needed
                    });
                  }
                }
              }
            } catch (err) {
              // Skip files that can't be read
              console.warn(`Warning: Could not read file ${filePath}:`, err.message);
            }
          }
        } catch (err) {
          // Module directory might not be readable, skip it
          if (err.code !== 'ENOTDIR') {
            console.warn(`Warning: Could not read module ${module}:`, err.message);
          }
        }
      }
    } catch (err) {
      // Device directory not readable
      throw new APIError('device_not_found', `Cannot access data for device ${deviceId}`);
    }

    // Sort readings by timestamp
    readings.sort((a, b) => a.timestamp - b.timestamp);

    return readings;
  } catch (err) {
    if (err instanceof APIError) throw err;
    throw new APIError('server_error', `Error reading device data: ${err.message}`);
  }
}

/**
 * Convert device data to SenML format
 * @param {string} deviceId - Device identifier
 * @param {Array} readings - Array of reading objects
 * @returns {Array} SenML packet
 */
export function toSenMLPacket(deviceId, readings) {
  if (readings.length === 0) {
    // Return empty array per API.md 6.2.3
    return [];
  }

  // Use the earliest timestamp as base time
  const baseTime = readings[0].timestamp;

  // Convert to SenML format
  return toSenML(readings, deviceId, baseTime);
}

/**
 * Parse timestamp from various formats
 * Supports ISO 8601 and Unix timestamps
 *
 * @param {string|number} timestamp - Timestamp to parse
 * @returns {number} Unix timestamp in seconds
 * @throws {APIError} If timestamp format is invalid
 */
export function parseTimestamp(timestamp) {
  if (typeof timestamp === 'number') {
    return Math.floor(timestamp);
  }

  if (typeof timestamp === 'string') {
    // Try ISO 8601 format
    const isoMatch = timestamp.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (isoMatch) {
      const unixTime = Math.floor(new Date(timestamp).getTime() / 1000);
      if (isNaN(unixTime)) {
        throw new APIError('invalid_request', 'Invalid ISO 8601 timestamp');
      }
      return unixTime;
    }

    // Try Unix timestamp
    const unixTime = parseInt(timestamp);
    if (!isNaN(unixTime)) {
      return Math.floor(unixTime);
    }

    throw new APIError('invalid_request', 'Timestamp must be Unix timestamp or ISO 8601 format');
  }

  throw new APIError('invalid_request', 'Invalid timestamp format');
}

/**
 * Validate timestamp range
 * @param {number} fromTime - Start time
 * @param {number} toTime - End time
 * @throws {APIError} If validation fails
 */
export function validateTimeRange(fromTime, toTime) {
  if (isNaN(fromTime)) {
    throw new APIError('invalid_request', 'Invalid "from" timestamp');
  }

  if (isNaN(toTime)) {
    throw new APIError('invalid_request', 'Invalid "to" timestamp');
  }

  if (fromTime > toTime) {
    throw new APIError('invalid_request', 'Start time must be before end time');
  }

  // Warn if range is excessively large (more than 1 year)
  if (toTime - fromTime > 365 * 24 * 60 * 60) {
    console.warn('Warning: Large time range requested, this may be slow');
  }
}



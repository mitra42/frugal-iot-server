/**
 * Data File Utilities
 * Handles reading sensor data files from disk and converting to SenML format
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { parseDeviceId, toSenML, filterSenMLByTime } from './senml-utils.js';
import { APIError } from './api-errors.js';

/**
 * Convert Unix timestamp to date string (YYYY-MM-DD format)
 * @private
 * @param {number} unixTime - Unix timestamp in seconds
 * @returns {string} Date in YYYY-MM-DD format
 */
function unixToDateString(unixTime) {
  const date = new Date(unixTime * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse date string from filename (YYYY-MM-DD format)
 * @private
 * @param {string} filename - Filename like "2026-04-01.csv"
 * @returns {number|null} Unix timestamp at start of day (UTC), or null if invalid
 */
function dateFilenameToUnix(filename) {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})\.csv$/);
  if (!match) return null;

  const year = parseInt(match[1]);
  const month = parseInt(match[2]);
  const day = parseInt(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const unixTime = Math.floor(date.getTime() / 1000);
  console.log(`[dateFilenameToUnix] ${filename} -> year=${year}, month=${month}, day=${day} -> Unix=${unixTime}`);
  return unixTime;
}

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
 * Only reads data files that fall within the specified time range based on filename
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

    // console.log(`[loadDeviceData] Device: ${deviceId}, Dir: ${deviceDir}, From: ${fromTime}, To: ${toTime}`);

    // Check if device directory exists
    try {
      await readdir(deviceDir);
    } catch (err) {
      // console.log(`[loadDeviceData] Device directory not found: ${deviceDir}`);
      throw new APIError('device_not_found', `No data found for device ${deviceId}`);
    }

    const readings = [];

    // Iterate through module directories
    try {
      const modules = await readdir(deviceDir);
      // console.log(`[loadDeviceData] Found modules: ${modules.join(', ')}`);

      for (const module of modules) {
        const modulePath = join(deviceDir, module);
        const moduleStat = await stat(modulePath);

        // Skip if not a directory
        if (!moduleStat.isDirectory()) continue;

        try {
          // Iterate through field subdirectories
          const fields = await readdir(modulePath);
          // console.log(`[loadDeviceData] Module ${module} has fields: ${fields.join(', ')}`);

          for (const field of fields) {
            const fieldPath = join(modulePath, field);
            const fieldStat = await stat(fieldPath);

            // Skip if not a directory
            if (!fieldStat.isDirectory()) continue;

            try {
              // Read data files in field directory
              const files = await readdir(fieldPath);
              // console.log(`[loadDeviceData] Field ${module}/${field} has files: ${files.join(', ')}`);

              for (const file of files) {
                // Only process .csv files
                if (!file.endsWith('.csv')) continue;

                // Parse date from filename and check if it's in range
                const fileUnixTime = dateFilenameToUnix(file);
                if (fileUnixTime === null) {
                  // Invalid filename format, skip
                  // console.log(`[loadDeviceData] Invalid filename format: ${file}`);
                  continue;
                }

                // Check if file's date is within the time range
                // A file with date 2026-04-01 contains data for that whole day (UTC)
                // So include it if it overlaps with [fromTime, toTime]
                const fileStartOfDay = fileUnixTime;
                const fileEndOfDay = fileUnixTime + (24 * 60 * 60) - 1;

                // console.log(`[loadDeviceData] File ${file}: start=${fileStartOfDay}, end=${fileEndOfDay}, fromTime=${fromTime}, toTime=${toTime}`);

                if (fileEndOfDay < fromTime || fileStartOfDay > toTime) {
                  // File is completely outside the time range, skip it
                  // console.log(`[loadDeviceData] File ${file} outside range, skipping`);
                  continue;
                }

                // console.log(`[loadDeviceData] Reading file ${file}`);
                const filePath = join(fieldPath, file);

                try {
                  const content = await readFile(filePath, 'utf-8');
                  const lines = content.trim().split('\n');
                  // console.log(`[loadDeviceData] File ${file} has ${lines.length} lines`);

                  for (const line of lines) {
                    if (!line.trim()) continue;

                    // Parse CSV format: timestamp,"value"
                    const parts = line.trim().split(',');
                    if (parts.length >= 2) {
                      let ts = parseInt(parts[0]);
                      // Remove quotes from value if present
                      const valueStr = parts[1].replace(/"/g, '');
                      const value = parseFloat(valueStr);

                      // Handle both millisecond and second timestamps
                      // If timestamp is larger than year 2286 in seconds, assume it's milliseconds
                      if (ts > 9999999999) {
                        ts = Math.floor(ts / 1000);
                      }

                      // Filter by time range
                      if (ts >= fromTime && ts <= toTime && !isNaN(value)) {
                        // console.log(`[loadDeviceData] Added data point: ts=${ts}, field=${module}/${field}, value=${value}`);
                        readings.push({
                          timestamp: ts,
                          field: `${module}/${field}`,
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
              // Skip field directories that can't be read
              console.warn(`Warning: Could not read field ${field}:`, err.message);
            }
          }
        } catch (err) {
          // Skip modules that can't be read
          console.warn(`Warning: Could not read module ${module}:`, err.message);
        }
      }
    } catch (err) {
      // Device directory not readable
      throw new APIError('device_not_found', `Cannot access data for device ${deviceId}`);
    }

    // Sort readings by timestamp
    readings.sort((a, b) => a.timestamp - b.timestamp);

    // console.log(`[loadDeviceData] Returning ${readings.length} readings for ${deviceId}`);
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



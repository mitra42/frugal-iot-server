/**
 * Data File Utilities
 * Whether a device has any data, and SenML for a set of readings. Reading history itself, for
 * GET /api/data and /mcp, is lib/data-query.js.
 */

import { stat } from 'fs/promises';
import { join } from 'path';
import { toSenML } from './senml-utils.js';

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

/**
 * SenML Utilities
 * Handles conversion to/from SenML format per API.md Section 4
 */

import SenML from '@gebsl/senml-js';
import { APIError } from './api-errors.js';

/**
 * Validate SenML input packet
 * Per API.md Section 4.2, validates:
 * - At least one record
 * - First record has bn (base name) and bt (base time)
 * - Every record has a value field
 * - bt is Unix timestamp >= 2^28
 *
 * @param {Array} packet - SenML packet to validate
 * @throws {APIError} If validation fails
 */
function validateSenMLInput(packet) {
  if (!Array.isArray(packet)) {
    throw new APIError('invalid_request', 'SenML packet must be an array');
  }

  if (packet.length === 0) {
    throw new APIError('invalid_request', 'SenML packet must contain at least one record');
  }

  const firstRecord = packet[0];

  // Check base name (bn) presence
  if (!firstRecord.bn) {
    throw new APIError('invalid_request', 'First SenML record must contain "bn" (base name)');
  }

  // Check base time (bt) presence and validity
  if (firstRecord.bt === undefined) {
    throw new APIError('invalid_request', 'First SenML record must contain "bt" (base time)');
  }

  const MIN_UNIX_TIMESTAMP = Math.pow(2, 28); // ~268 million, year 1979
  if (typeof firstRecord.bt !== 'number' || firstRecord.bt < MIN_UNIX_TIMESTAMP) {
    throw new APIError('invalid_request', 'Base time "bt" must be a Unix timestamp >= 2^28');
  }

  // Check that every record except the first (base record) has a value field
  // Per API.md Section 4.2: bn and bt are placed in a dedicated first record containing no value fields
  for (let i = 1; i < packet.length; i++) {
    const record = packet[i];
    const hasValue = record.v !== undefined || record.vs !== undefined || record.vb !== undefined || record.vd !== undefined;
    if (!hasValue) {
      throw new APIError('invalid_request', `SenML record at index ${i} must have a value field (v, vs, vb, or vd)`);
    }
  }
}

/**
 * Convert raw data to SenML format
 * @param {Array} readings - Array of reading objects with {timestamp, field, value, unit}
 * @param {string} deviceId - Device identifier (used as base name)
 * @param {number} baseTime - Base time for the packet (Unix timestamp)
 * @returns {Array} SenML packet
 */
function toSenML(readings, deviceId, baseTime) {
  if (!Array.isArray(readings)) {
    readings = [readings];
  }

  if (!baseTime) {
    baseTime = Math.floor(Date.now() / 1000);
  }

  // Create base record with bn and bt
  const senmlPacket = [
    {
      bn: deviceId.endsWith('/') ? deviceId : `${deviceId}/`,
      bt: baseTime
    }
  ];

  // Add data records
  for (const reading of readings) {
    const record = {
      n: reading.field // module/field format
    };

    // Determine value type
    if (typeof reading.value === 'number') {
      record.v = reading.value;
    } else if (typeof reading.value === 'string') {
      record.vs = reading.value;
    } else if (typeof reading.value === 'boolean') {
      record.vb = reading.value;
    } else {
      record.vd = reading.value; // Data type
    }

    // Add unit if provided
    if (reading.unit) {
      record.u = reading.unit;
    }

    // Add relative time if different from base time
    if (reading.timestamp && reading.timestamp !== baseTime) {
      record.t = reading.timestamp - baseTime;
    }

    senmlPacket.push(record);
  }

  return senmlPacket;
}

/**
 * Parse SenML packet to extract data
 * @param {Array} packet - SenML packet
 * @returns {Object} Parsed data with deviceId, baseTime, and readings
 * @throws {APIError} If packet is invalid
 */
function parseSenML(packet) {
  try {
    validateSenMLInput(packet);
  } catch (err) {
    throw err;
  }

  const firstRecord = packet[0];
  const deviceId = firstRecord.bn.replace(/\/$/, ''); // Remove trailing slash
  const baseTime = firstRecord.bt;

  const readings = [];

  for (let i = 1; i < packet.length; i++) {
    const record = packet[i];
    const reading = {
      field: record.n,
      unit: record.u || null
    };

    // Extract timestamp
    reading.timestamp = baseTime + (record.t || 0);

    // Extract value
    if (record.v !== undefined) {
      reading.value = record.v;
      reading.type = 'number';
    } else if (record.vs !== undefined) {
      reading.value = record.vs;
      reading.type = 'string';
    } else if (record.vb !== undefined) {
      reading.value = record.vb;
      reading.type = 'boolean';
    } else if (record.vd !== undefined) {
      reading.value = record.vd;
      reading.type = 'data';
    }

    readings.push(reading);
  }

  return {
    deviceId,
    baseTime,
    readings
  };
}

/**
 * Extract device ID components from full device identifier
 * Format: org/project/device-id or similar hierarchical path
 * @param {string} deviceId - Full device identifier
 * @returns {Object} Parsed device components
 * @throws {APIError} If format is invalid
 */
function parseDeviceId(deviceId) {
  // Remove trailing slash if present
  deviceId = deviceId.replace(/\/$/, '');

  const parts = deviceId.split('/');
  if (parts.length < 3) {
    throw new APIError('invalid_request', 'Device ID must be in format: org/project/device-id');
  }

  return {
    org: parts[0],
    project: parts[1],
    deviceId: parts[2],
    fullId: deviceId,
    fullIdWithSlash: `${deviceId}/`
  };
}

/**
 * Filter SenML readings by timestamp range
 * @param {Array} packet - SenML packet
 * @param {number} fromTime - Start timestamp (inclusive)
 * @param {number} toTime - End timestamp (inclusive)
 * @returns {Array} Filtered SenML packet
 */
function filterSenMLByTime(packet, fromTime, toTime) {
  if (packet.length === 0) {
    return [];
  }

  // Keep the base record
  const filtered = [packet[0]];

  // Filter data records by timestamp
  for (let i = 1; i < packet.length; i++) {
    const record = packet[i];
    const baseTime = packet[0].bt;
    const timestamp = baseTime + (record.t || 0);

    if (timestamp >= fromTime && timestamp <= toTime) {
      filtered.push(record);
    }
  }

  // If only base record remains, return empty array per API.md 6.2.3
  return filtered.length > 1 ? filtered : [];
}

export {
  validateSenMLInput,
  toSenML,
  parseSenML,
  parseDeviceId,
  filterSenMLByTime
};



/**
 * Unit tests for SenML utilities
 */

import {
  validateSenMLInput,
  toSenML,
  parseSenML,
  parseDeviceId,
  filterSenMLByTime
} from '../../lib/senml-utils.js';
import { APIError } from '../../lib/api-errors.js';

describe('SenML Utilities', () => {
  describe('validateSenMLInput', () => {
    test('should accept valid SenML packet', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 1276020076001 },
        { n: 'sht/temperature', v: 32.0, u: 'Cel' }
      ];

      expect(() => validateSenMLInput(packet)).not.toThrow();
    });

    test('should reject non-array input', () => {
      expect(() => validateSenMLInput({ bn: 'test' })).toThrow(APIError);
    });

    test('should reject empty array', () => {
      expect(() => validateSenMLInput([])).toThrow(APIError);
    });

    test('should reject packet without bn in first record', () => {
      const packet = [
        { bt: 1276020076001 },
        { n: 'sht/temperature', v: 32.0 }
      ];
      expect(() => validateSenMLInput(packet)).toThrow(APIError);
    });

    test('should reject packet without bt in first record', () => {
      const packet = [
        { bn: 'dev/org/device/' },
        { n: 'sht/temperature', v: 32.0 }
      ];
      expect(() => validateSenMLInput(packet)).toThrow(APIError);
    });

    test('should reject bt less than 2^28', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 100 },
        { n: 'sht/temperature', v: 32.0 }
      ];
      expect(() => validateSenMLInput(packet)).toThrow(APIError);
    });

    test('should reject record without value field', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 1276020076001 },
        { n: 'sht/temperature' } // Missing value
      ];
      expect(() => validateSenMLInput(packet)).toThrow(APIError);
    });

    test('should accept multiple value types', () => {
      const packets = [
        [{ bn: 'dev/org/device/', bt: 1276020076001 }, { n: 'test', v: 123 }],
        [{ bn: 'dev/org/device/', bt: 1276020076001 }, { n: 'test', vs: 'hello' }],
        [{ bn: 'dev/org/device/', bt: 1276020076001 }, { n: 'test', vb: true }],
        [{ bn: 'dev/org/device/', bt: 1276020076001 }, { n: 'test', vd: 'data' }]
      ];

      packets.forEach(packet => {
        expect(() => validateSenMLInput(packet)).not.toThrow();
      });
    });
  });

  describe('toSenML', () => {
    test('should convert single reading to SenML', () => {
      const reading = {
        field: 'sht/temperature',
        value: 32.0,
        unit: 'Cel'
      };
      const result = toSenML(reading, 'dev/org/esp32-123456/', 1276020076001);

      expect(result[0]).toEqual({
        bn: 'dev/org/esp32-123456/',
        bt: 1276020076001
      });
      expect(result[1]).toEqual({
        n: 'sht/temperature',
        v: 32.0,
        u: 'Cel'
      });
    });

    test('should convert multiple readings to SenML', () => {
      const readings = [
        { field: 'sht/temperature', value: 32.0, unit: 'Cel' },
        { field: 'sht/humidity', value: 85.2, unit: '%RH' }
      ];
      const result = toSenML(readings, 'dev/org/esp32-123456/', 1276020076001);

      expect(result).toHaveLength(3);
      expect(result[1].n).toBe('sht/temperature');
      expect(result[2].n).toBe('sht/humidity');
    });

    test('should handle different value types', () => {
      const readings = [
        { field: 'sensor/temp', value: 25.5 },
        { field: 'device/name', value: 'My Sensor' },
        { field: 'relay/active', value: true }
      ];
      const result = toSenML(readings, 'dev/org/device/', 1276020076001);

      expect(result[1].v).toBe(25.5);
      expect(result[2].vs).toBe('My Sensor');
      expect(result[3].vb).toBe(true);
    });

    test('should handle relative timestamps', () => {
      const readings = [
        { field: 'sensor/reading', value: 1, timestamp: 1276020076001 },
        { field: 'sensor/reading', value: 2, timestamp: 1276020076011 } // 10 seconds later
      ];
      const result = toSenML(readings, 'dev/org/device/', 1276020076001);

      expect(result[1].t).toBeUndefined(); // First reading at base time
      expect(result[2].t).toBe(10); // Second reading is +10 seconds
    });

    test('should remove trailing slash from device ID', () => {
      const reading = { field: 'test', value: 1 };
      const result = toSenML(reading, 'dev/org/device/', 1276020076001);

      expect(result[0].bn).toBe('dev/org/device/');
    });
  });

  describe('parseSenML', () => {
    test('should parse valid SenML packet', () => {
      const packet = [
        { bn: 'dev/org/esp32-123456/', bt: 1276020076001 },
        { n: 'sht/temperature', v: 32.0, u: 'Cel' },
        { n: 'sht/humidity', v: 85.2, u: '%RH' }
      ];

      const result = parseSenML(packet);

      expect(result.deviceId).toBe('dev/org/esp32-123456');
      expect(result.baseTime).toBe(1276020076001);
      expect(result.readings).toHaveLength(2);
      expect(result.readings[0]).toEqual({
        field: 'sht/temperature',
        value: 32.0,
        unit: 'Cel',
        timestamp: 1276020076001,
        type: 'number'
      });
    });

    test('should handle relative timestamps', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 1276020076001 },
        { n: 'sensor/reading', v: 1 },
        { n: 'sensor/reading', v: 2, t: 10 }
      ];

      const result = parseSenML(packet);

      expect(result.readings[0].timestamp).toBe(1276020076001);
      expect(result.readings[1].timestamp).toBe(1276020076011);
    });

    test('should detect value types correctly', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 1276020076001 },
        { n: 'test/num', v: 123 },
        { n: 'test/str', vs: 'hello' },
        { n: 'test/bool', vb: true },
        { n: 'test/data', vd: 'binary' }
      ];

      const result = parseSenML(packet);

      expect(result.readings[0].type).toBe('number');
      expect(result.readings[1].type).toBe('string');
      expect(result.readings[2].type).toBe('boolean');
      expect(result.readings[3].type).toBe('data');
    });
  });

  describe('parseDeviceId', () => {
    test('should parse valid device ID', () => {
      const result = parseDeviceId('dev/lotus/esp32-123456/');

      expect(result).toEqual({
        org: 'dev',
        project: 'lotus',
        deviceId: 'esp32-123456',
        fullId: 'dev/lotus/esp32-123456',
        fullIdWithSlash: 'dev/lotus/esp32-123456/'
      });
    });

    test('should handle device ID without trailing slash', () => {
      const result = parseDeviceId('dev/lotus/esp32-123456');

      expect(result.fullIdWithSlash).toBe('dev/lotus/esp32-123456/');
    });

    test('should reject invalid format', () => {
      expect(() => parseDeviceId('invalid')).toThrow(APIError);
      expect(() => parseDeviceId('org/project')).toThrow(APIError);
    });
  });

  describe('filterSenMLByTime', () => {
    test('should filter records within time range', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 1000 },
        { n: 'sensor/reading', v: 1, t: 0 },   // timestamp 1000
        { n: 'sensor/reading', v: 2, t: 10 },  // timestamp 1010
        { n: 'sensor/reading', v: 3, t: 20 },  // timestamp 1020
        { n: 'sensor/reading', v: 4, t: 30 }   // timestamp 1030
      ];

      const result = filterSenMLByTime(packet, 1005, 1025);

      // Should include base record plus readings at 1010 and 1020
      expect(result).toHaveLength(3);
      expect(result[1].v).toBe(2);
      expect(result[2].v).toBe(3);
    });

    test('should return empty array if no data in range', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 1000 },
        { n: 'sensor/reading', v: 1 }
      ];

      const result = filterSenMLByTime(packet, 2000, 3000);

      expect(result).toEqual([]);
    });

    test('should handle inclusive boundaries', () => {
      const packet = [
        { bn: 'dev/org/device/', bt: 1000 },
        { n: 'sensor/reading', v: 1, t: 0 },   // timestamp 1000
        { n: 'sensor/reading', v: 2, t: 10 }   // timestamp 1010
      ];

      const result = filterSenMLByTime(packet, 1000, 1010);

      expect(result).toHaveLength(3); // Base + both records
    });
  });
});


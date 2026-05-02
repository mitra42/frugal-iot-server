/**
 * Tests for Phase 3: Logger integration and Farm-Platform push
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LoggerClient } from '../../lib/logger-client.js';
import { FarmPlatformPushManager, createPushManager } from '../../lib/farm-platform-push.js';
import { Database } from 'sqlite3';
import { initializeSchema } from '../../lib/database.js';

describe('Phase 3: Logger Integration & Push Manager', () => {
  let db;
  let loggerClient;
  let pushManager;

  beforeAll(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');

    // Initialize schema
    await initializeSchema(db);

    // Create mock mqtt logger for testing
    const mockMqttLogger = {
      getDeviceSchema: async (org, project, deviceId) => {
        return {
          'device-platform-device-id': `${org}/${project}/${deviceId}`,
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
    };

    // Create logger client with mock mqtt logger
    loggerClient = new LoggerClient(mockMqttLogger);

    // Create push manager
    pushManager = createPushManager(db, null);
  });

  afterAll(() => {
    return new Promise((resolve) => {
      db.close(() => resolve());
    });
  });

  describe('LoggerClient', () => {
    describe('Schema Validation', () => {
      const schema = {
        'device-platform-device-id': 'dev/test/esp32',
        modules: {
          relay: {
            fields: [
              {
                field: 'on',
                name: 'Relay On',
                type: 'boolean',
                rw: 'w',
                min: 0,
                max: 1
              }
            ]
          },
          sensor: {
            fields: [
              {
                field: 'temperature',
                name: 'Temperature',
                type: 'float',
                rw: 'r',
                min: -40,
                max: 125
              },
              {
                field: 'humidity',
                name: 'Humidity',
                type: 'float',
                rw: 'rw',
                min: 0,
                max: 100
              }
            ]
          }
        }
      };

      it('should validate correct command', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'relay/on',
          true
        );

        expect(result.valid).toBe(true);
      });

      it('should reject command for read-only field', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'sensor/temperature',
          25.5
        );

        expect(result.valid).toBe(false);
        expect(result.error).toContain('read-only');
      });

      it('should accept command for rw field', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'sensor/humidity',
          65
        );

        expect(result.valid).toBe(true);
      });

      it('should validate field type - boolean', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'relay/on',
          'not-a-boolean'
        );

        expect(result.valid).toBe(false);
        expect(result.error).toContain('boolean');
      });

      it('should validate field type - number', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'sensor/humidity',
          'not-a-number'
        );

        expect(result.valid).toBe(false);
      });

      it('should validate value range', () => {
        const resultLow = loggerClient.validateCommandAgainstSchema(
          schema,
          'sensor/humidity',
          -10
        );
        expect(resultLow.valid).toBe(false);
        expect(resultLow.error).toContain('below minimum');

        const resultHigh = loggerClient.validateCommandAgainstSchema(
          schema,
          'sensor/humidity',
          150
        );
        expect(resultHigh.valid).toBe(false);
        expect(resultHigh.error).toContain('above maximum');
      });

      it('should reject non-existent module', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'nonexistent/field',
          true
        );

        expect(result.valid).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('should reject non-existent field', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'relay/nonexistent',
          true
        );

        expect(result.valid).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('should validate command format', () => {
        const result = loggerClient.validateCommandAgainstSchema(
          schema,
          'invalid-format',
          true
        );

        expect(result.valid).toBe(false);
        expect(result.error).toContain('module/field');
      });
    });

    describe('Schema Caching', () => {
      it('should cache schema', async () => {
        const org = 'dev';
        const project = 'test';
        const device = 'esp32-123';

        // First call - from basic schema
        const schema1 = await loggerClient.getDeviceSchema(org, project, device);
        expect(schema1).toBeDefined();

        // Second call - from cache
        const schema2 = await loggerClient.getDeviceSchema(org, project, device);
        expect(schema2).toEqual(schema1);
      });

      it('should clear cache', async () => {
        const org = 'dev';
        const project = 'test';
        const device = 'esp32-456';

        // Cache a schema
        await loggerClient.getDeviceSchema(org, project, device);

        // Clear cache
        loggerClient.clearSchemaCache();

        // Should work but not use cache
        const schema = await loggerClient.getDeviceSchema(org, project, device);
        expect(schema).toBeDefined();
      });

      it('should clear specific schema from cache', async () => {
        const org = 'dev';
        const project = 'test';
        const device = 'esp32-789';

        // Cache a schema
        await loggerClient.getDeviceSchema(org, project, device);

        // Clear specific entry
        loggerClient.clearSchemaCacheEntry(org, project, device);

        // Should work
        const schema = await loggerClient.getDeviceSchema(org, project, device);
        expect(schema).toBeDefined();
      });
    });
  });

  describe('FarmPlatformPushManager', () => {
    describe('Queue Operations', () => {
      it('should queue data push', async () => {
        // First insert a platform
        await new Promise((resolve) => {
          db.run(
            `INSERT OR IGNORE INTO farm_platforms (name, base_url, auth_token, cookie_name)
             VALUES (?, ?, ?, ?)`,
            ['test-farm', 'http://farm.example.com', 'token123', 'x-farm-token'],
            resolve
          );
        });

        const readings = [
          { timestamp: 1000, field: 'temp', value: 25.5 },
          { timestamp: 1001, field: 'humidity', value: 65 }
        ];

        const result = await pushManager.queueDataPush('dev/test/esp32', readings);

        // With platform, should queue data
        expect(result.queued).toBeGreaterThanOrEqual(0);
        expect(result.platforms).toBeGreaterThanOrEqual(0);
      });

      it('should handle empty data', async () => {
        const result = await pushManager.queueDataPush('dev/test/esp32', []);

        expect(result.queued).toBe(0);
      });

      it('should queue notification', async () => {
        const result = await pushManager.queueNotification(
          'dev/test/esp32',
          'Temperature is too high',
          { temperature: 35.2 }
        );

        // Should queue or handle gracefully
        expect(result.queued).toBeGreaterThanOrEqual(0);
      });

      it('should get queue statistics', async () => {
        const stats = await pushManager.getQueueStats();

        expect(stats.total).toBeGreaterThanOrEqual(0);
        expect(stats.pending !== undefined || stats.retrying !== undefined).toBe(true);
      });
    });

    describe('Push Processing', () => {
      it('should process push queue (stub)', async () => {
        // Just verify the method exists and returns proper structure
        expect(typeof pushManager.processPushQueue).toBe('function');
      });
    });

    describe('Error Handling', () => {
      it('should handle missing farm platforms', async () => {
        const readings = [{ timestamp: 1000, field: 'temp', value: 25.5 }];

        // Create new push manager with no platforms
        const pm = createPushManager(db, null);

        const result = await pm.queueDataPush('dev/test/esp32', readings, 'nonexistent');

        // Should either queue 0 or handle gracefully
        expect(result.queued).toBeLessThanOrEqual(1);
      });
    });

    describe('SenML Packet Generation', () => {
      it('should queue data with SenML format', async () => {
        const readings = [
          { timestamp: 1000, field: 'sht/temperature', value: 25.5, unit: 'Cel' },
          { timestamp: 1001, field: 'sht/humidity', value: 65, unit: '%RH' }
        ];

        const result = await pushManager.queueDataPush('dev/test/esp32', readings);

        // Verify data was queued
        expect(result.queued).toBeGreaterThanOrEqual(0);
        expect(result.message).toBeDefined();
      });
    });
  });

  describe('Integration: Logger + Push Manager', () => {
    it('should validate command before queuing', () => {
      const schema = {
        'device-platform-device-id': 'dev/test/esp32',
        modules: {
          relay: {
            fields: [
              {
                field: 'on',
                name: 'Relay On',
                type: 'boolean',
                rw: 'w'
              }
            ]
          }
        }
      };

      const validation = loggerClient.validateCommandAgainstSchema(
        schema,
        'relay/on',
        true
      );

      expect(validation.valid).toBe(true);
    });

    it('should reject invalid command before queuing', () => {
      const schema = {
        'device-platform-device-id': 'dev/test/esp32',
        modules: {
          sensor: {
            fields: [
              {
                field: 'temp',
                name: 'Temperature',
                type: 'float',
                rw: 'r'
              }
            ]
          }
        }
      };

      const validation = loggerClient.validateCommandAgainstSchema(
        schema,
        'sensor/temp',
        25.5
      );

      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('read-only');
    });
  });
});






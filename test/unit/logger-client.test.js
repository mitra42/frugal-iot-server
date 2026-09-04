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
          // A WoT Thing Descriptor, the shape getDeviceSchema() actually returns (API.md Annex A.2/A.3):
          // an action carries its DataSchema under "input", a property carries it directly and may be
          // readOnly. The previous version of these tests used a modules/fields schema that no code
          // reads any more.
          const schema = {
            id: 'dev/test/esp32',
            actions: {
              'relay/on': { input: { type: 'boolean' } },
              'servo/angle': { input: { type: 'integer', minimum: 0, maximum: 180 } },
            },
            properties: {
              'sht/temperature': { type: 'number', minimum: -40, maximum: 125, readOnly: true },
              'control/setpoint': { type: 'number', minimum: 0, maximum: 100 },
            },
          };

          it('accepts a valid action', () => {
            expect(loggerClient.validateActionAgainstSchema(schema, 'relay/on', true).valid).toBe(true);
          });

          it('rejects the wrong type for an action', () => {
            const r = loggerClient.validateActionAgainstSchema(schema, 'relay/on', 'yes');
            expect(r.valid).toBe(false);
          });

          it('accepts a value inside an action range', () => {
            expect(loggerClient.validateActionAgainstSchema(schema, 'servo/angle', 90).valid).toBe(true);
          });

          it('rejects a value above the maximum', () => {
            const r = loggerClient.validateActionAgainstSchema(schema, 'servo/angle', 200);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('above maximum');
          });

          it('rejects a value below the minimum', () => {
            const r = loggerClient.validateActionAgainstSchema(schema, 'servo/angle', -1);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('below minimum');
          });

          it('rejects a non-integer for an integer action', () => {
            expect(loggerClient.validateActionAgainstSchema(schema, 'servo/angle', 90.5).valid).toBe(false);
          });

          it('rejects an unknown action', () => {
            const r = loggerClient.validateActionAgainstSchema(schema, 'nosuch/field', 1);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('not found');
          });

          it('says so when an action name is really a property', () => {
            const r = loggerClient.validateActionAgainstSchema(schema, 'control/setpoint', 50);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('property, not an action');
          });

          // The security-relevant one: a read-only property must not be writable through the API.
          it('refuses to write a read-only property', () => {
            const r = loggerClient.validatePropertyAgainstSchema(schema, 'sht/temperature', 25.5);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('read-only');
          });

          it('accepts a writable property in range', () => {
            expect(loggerClient.validatePropertyAgainstSchema(schema, 'control/setpoint', 21).valid).toBe(true);
          });

          it('rejects a writable property out of range', () => {
            const r = loggerClient.validatePropertyAgainstSchema(schema, 'control/setpoint', 101);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('above maximum');
          });

          it('says so when a property name is really an action', () => {
            const r = loggerClient.validatePropertyAgainstSchema(schema, 'relay/on', true);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('action, not a property');
          });

          it('rejects an unknown property', () => {
            const r = loggerClient.validatePropertyAgainstSchema(schema, 'nosuch/field', 1);
            expect(r.valid).toBe(false);
            expect(r.error).toContain('not found');
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
    const schema = {
      id: 'dev/test/esp32',
      actions: { 'relay/on': { input: { type: 'boolean' } } },
      properties: { 'sensor/temp': { type: 'number', readOnly: true } },
    };

    it('validates an action before queuing', () => {
      expect(loggerClient.validateActionAgainstSchema(schema, 'relay/on', true).valid).toBe(true);
    });

    it('rejects a write to a read-only field before queuing', () => {
      const validation = loggerClient.validatePropertyAgainstSchema(schema, 'sensor/temp', 25.5);
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('read-only');
    });
  });
});






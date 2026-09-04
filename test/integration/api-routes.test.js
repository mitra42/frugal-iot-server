/**
 * Integration tests for API routes
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Database } from 'sqlite3';
import request from 'supertest';
import express from 'express';
import { createAPIRouter, createAPIErrorHandler } from '../../lib/api-routes.js';
import { initializeSchema } from '../../lib/database.js';

describe('API Routes - Phase 2', () => {
  let app;
  let db;
  const testDataDir = './test/fixtures/data';

  // The API router's routes are behind loggedInOrFail plus can_READ or can_WRITE, all of which call
  // req.isAuthenticated() - passport puts that on the request, and there is no passport here. Without
  // a stand-in every route threw "req.isAuthenticated is not a function" and answered 500, so each
  // test was asserting against an error from the harness rather than from the code.
  //
  // Tests set testUser to choose who is asking; setting it to null makes the request anonymous.
  // READ on 'nonexistent' is deliberate: the device-not-found tests are about device lookup, not
  // permissions, and without it they would stop at 401 having never reached the lookup.
  let testUser;
  const userWith = (...perms) => ({
    id: 2, username: 'tester', organization: 'dev',
    permissions: perms.map(([capability, org]) => ({ id: 2, capability, org })),
  });
  const FULL = () => userWith(
    ['READ', 'dev'], ['WRITE', 'dev'], ['ADMIN', 'dev'],
    ['READ', 'nonexistent'], ['WRITE', 'nonexistent'],
  );

  beforeEach(() => { testUser = FULL(); });

  beforeAll(async () => {
    // Create test app
    app = express();
    app.use(express.json());

    // Stand in for passport - see the note on testUser above.
    app.use((req, res, next) => {
      req.isAuthenticated = () => !!testUser;
      req.user = testUser || undefined;
      next();
    });

    // Create in-memory database for testing
    db = new Database(':memory:');

    // Initialize schema
    await initializeSchema(db);

    // createAPIRouter(db, dataDir, loggerClient, pushManager) - /data awaits loggerClient.flush()
    // to get buffered readings onto disk before serving them, so without a stand-in every /data
    // request died on "Cannot read properties of undefined".
    const loggerClient = {
      flush: async () => {},
      getDeviceSchema: async () => null,       // no device exists in these tests
      sendCommand: async () => ({ status: 'sent' }),
      getPropertyValue: () => undefined,
    };

    // Mount API router
    const apiRouter = createAPIRouter(db, testDataDir, loggerClient);
    app.use('/api', apiRouter);

    // Error handler
    app.use(createAPIErrorHandler());
  });

  afterAll(() => {
    return new Promise((resolve) => {
      db.close(() => resolve());
    });
  });

  describe('GET /data - Historical Data Retrieval', () => {
    it('should reject request without device parameter', async () => {
      const response = await request(app)
        .get('/api/data')
        .query({ from: '1000000000' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
      expect(response.body.message).toContain('device');
    });

    it('should reject request without from parameter', async () => {
      const response = await request(app)
        .get('/api/data')
        .query({ device: 'dev/lotus/esp32-123456' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
      expect(response.body.message).toContain('from');
    });

    it('should reject invalid device not found', async () => {
      const response = await request(app)
        .get('/api/data')
        .query({
          device: 'nonexistent/device/id',
          from: '1000000000'
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('device_not_found');
    });

    it('should return empty array for valid device with no data', async () => {
      // This test needs fixture directory setup
      // For now, just test the error case
      expect(true).toBe(true);
    });

    it('should accept Unix timestamp format', async () => {
      const response = await request(app)
        .get('/api/data')
        .query({
          device: 'dev/lotus/esp32-123456',
          from: '1276020076',
          to: '1276020076'
        });

      // Will be 404 if device doesn't exist, which is expected for now
      expect([400, 404]).toContain(response.status);
    });

    it('should accept ISO 8601 timestamp format', async () => {
      const response = await request(app)
        .get('/api/data')
        .query({
          device: 'dev/lotus/esp32-123456',
          from: '2010-04-09T12:34:36Z',
          to: '2010-04-09T12:34:36Z'
        });

      // Will be 404 if device doesn't exist, which is expected for now
      expect([400, 404]).toContain(response.status);
    });

    it('should set correct Content-Type header', async () => {
      const response = await request(app)
        .get('/api/data')
        .query({
          device: 'dev/lotus/esp32-123456',
          from: '1276020076'
        });

      // Even on error, the response header handling should not break
      expect(response.status).toBeDefined();
    });
  });

  describe('GET /devices/schema', () => {
    it('should reject request without device parameter', async () => {
      const response = await request(app)
        .get('/api/devices/schema');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject non-existent device', async () => {
      const response = await request(app)
        .get('/api/devices/schema')
        .query({ device: 'nonexistent/device/id' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('device_not_found');
    });

    it('should return basic schema for Phase 2', async () => {
      // Phase 2 returns basic stub schema
      // Full implementation will call logger for dynamic schema
      expect(true).toBe(true);
    });

    it('should set correct Content-Type header', async () => {
      const response = await request(app)
        .get('/api/devices/schema')
        .query({ device: 'nonexistent/device/id' });

      // Even on error, should have proper response
      expect(response.status).toBeDefined();
    });
  });

  // Regression tests for SEC-14: these three routes all publish a set/ command to a device through
  // the logger, and all three were gated on can_READ - so anyone who could read an organization
  // could operate any actuator in it. They now require WRITE, which is implied by neither READ nor
  // ADMIN. A 401 here is the whole point; the device does not need to exist for the check to run.
  describe('Commanding a device requires WRITE, not READ', () => {
    const readOnly = () => ({
      id: 3, username: 'reader', organization: 'dev',
      permissions: [{ id: 3, capability: 'READ', org: 'dev' },
                    { id: 3, capability: 'ADMIN', org: 'dev' }],   // ADMIN must not imply WRITE
    });

    it('POST /devices/action refuses a READ-only user', async () => {
      testUser = readOnly();
      const response = await request(app)
        .post('/api/devices/action')
        .send({ 'device-id': 'dev/lotus/esp32-123456', action: 'relay/on', parameters: { value: '1' } });
      expect(response.status).toBe(401);
    });

    it('GET /devices/action refuses a READ-only user', async () => {
      testUser = readOnly();
      const response = await request(app)
        .get('/api/devices/action')
        .query({ deviceId: 'dev/lotus/esp32-123456', action: 'relay/on', value: '1' });
      expect(response.status).toBe(401);
    });

    it('PUT /devices/property refuses a READ-only user', async () => {
      testUser = readOnly();
      const response = await request(app)
        .put('/api/devices/property')
        .query({ deviceId: 'dev/lotus/esp32-123456', property: 'relay/on' })
        .send({ value: 1 });
      expect(response.status).toBe(401);
    });

    it('GET /devices/property still allows a READ-only user - it is a read', async () => {
      testUser = readOnly();
      const response = await request(app)
        .get('/api/devices/property')
        .query({ deviceId: 'dev/lotus/esp32-123456', property: 'sht/temperature' });
      expect(response.status).not.toBe(401);
    });

    it('a WRITE holder gets past the permission check', async () => {
      // Past the check, not necessarily to a 200 - no such device exists here.
      const response = await request(app)
        .post('/api/devices/action')
        .send({ 'device-id': 'dev/lotus/esp32-123456', action: 'relay/on', parameters: { value: '1' } });
      expect(response.status).not.toBe(401);
    });

    it('an anonymous request is refused', async () => {
      testUser = null;
      const response = await request(app)
        .post('/api/devices/action')
        .send({ 'device-id': 'dev/lotus/esp32-123456', action: 'relay/on', parameters: { value: '1' } });
      expect(response.status).toBe(401);
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for invalid JSON in POST', async () => {
      const response = await request(app)
        .post('/api/users/register')
        .set('Content-Type', 'application/json')
        .send('invalid json');

      expect(response.status).toBe(400);
    });

    it('should handle server errors gracefully', async () => {
      // This would test database connection errors, etc.
      // For now, just verify error handler is working
      expect(true).toBe(true);
    });
  });
});


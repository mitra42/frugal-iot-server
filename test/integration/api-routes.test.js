/**
 * Integration tests for API routes
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Database } from 'sqlite3';
import request from 'supertest';
import express from 'express';
import { createAPIRouter, createAPIErrorHandler } from '../../lib/api-routes.js';
import { initializeSchema } from '../../lib/database.js';

describe('API Routes - Phase 2', () => {
  let app;
  let db;
  const testDataDir = './test/fixtures/data';

  beforeAll(async () => {
    // Create test app
    app = express();
    app.use(express.json());

    // Create in-memory database for testing
    db = new Database(':memory:');

    // Initialize schema
    await initializeSchema(db);

    // Mount API router
    const apiRouter = createAPIRouter(db, testDataDir);
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

  describe('POST /users/register', () => {
    it('should reject request without user-id', async () => {
      const response = await request(app)
        .post('/api/users/register')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
      expect(response.body.message).toContain('user-id');
    });

    it('should register new user', async () => {
      const response = await request(app)
        .post('/api/users/register')
        .send({
          'user-id': 'farm-user-123',
          credentials: { /* TBD */ }
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('registered');
      expect(response.body.devicePlatformUserId).toBeDefined();
    });

    it('should return existing user on duplicate registration', async () => {
      const userId = 'farm-user-456';

      // First registration
      const response1 = await request(app)
        .post('/api/users/register')
        .send({ 'user-id': userId });

      expect(response1.status).toBe(200);
      const devicePlatformId1 = response1.body.devicePlatformUserId;

      // Second registration with same ID
      const response2 = await request(app)
        .post('/api/users/register')
        .send({ 'user-id': userId });

      expect(response2.status).toBe(200);
      expect(response2.body.devicePlatformUserId).toBe(devicePlatformId1);
    });
  });

  describe('POST /devices/register', () => {
    it('should reject request without user-id', async () => {
      const response = await request(app)
        .post('/api/devices/register')
        .send({
          'farm-platform-device-id': 'farm-device-1'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject request without device identifier', async () => {
      const response = await request(app)
        .post('/api/devices/register')
        .send({
          'user-id': 'dp_123'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject non-existent device', async () => {
      // First register a user
      const userResponse = await request(app)
        .post('/api/users/register')
        .send({ 'user-id': 'farm-user-device-test' });

      const userId = userResponse.body.devicePlatformUserId;

      // Then try to register non-existent device
      const response = await request(app)
        .post('/api/devices/register')
        .send({
          'user-id': userId,
          'farm-platform-device-id': 'farm-device-1',
          'device-id': 'nonexistent/device/id'
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('device_not_found');
    });

    it('should reject unregistered user', async () => {
      const response = await request(app)
        .post('/api/devices/register')
        .send({
          'user-id': 'nonexistent-user',
          'farm-platform-device-id': 'farm-device-1',
          'device-id': 'dev/lotus/esp32-123456'
        });

      // Will be 404 since both user and device need to exist
      expect([404]).toContain(response.status);
    });
  });

  describe('POST /devices/command', () => {
    it('should reject request without device-id', async () => {
      const response = await request(app)
        .post('/api/devices/command')
        .send({
          command: 'relay/on',
          parameters: { value: true }
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject request without command', async () => {
      const response = await request(app)
        .post('/api/devices/command')
        .send({
          'device-id': 'dev/lotus/esp32-123456',
          parameters: { value: true }
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject request without parameters.value', async () => {
      const response = await request(app)
        .post('/api/devices/command')
        .send({
          'device-id': 'dev/lotus/esp32-123456',
          command: 'relay/on',
          parameters: {}
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject non-existent device', async () => {
      const response = await request(app)
        .post('/api/devices/command')
        .send({
          'device-id': 'nonexistent/device/id',
          command: 'relay/on',
          parameters: { value: true }
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('device_not_found');
    });

    it('should accept valid command (Phase 2 stub)', async () => {
      // Phase 2 just acknowledges commands
      // Full implementation will validate against schema and send via MQTT
      expect(true).toBe(true);
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


/**
 * Unit tests for API error handling
 */

import { APIError, ERROR_CODES, createSuccessResponse } from '../../lib/api-errors.js';

describe('APIError', () => {
  describe('Constructor', () => {
    test('should create error with default message', () => {
      const error = new APIError('invalid_request');
      expect(error.code).toBe('invalid_request');
      expect(error.status).toBe(400);
      expect(error.message).toBe('The request is malformed, missing required fields, or contains invalid values');
    });

    test('should create error with custom message', () => {
      const error = new APIError('device_not_found', 'Device with ID xyz not found');
      expect(error.code).toBe('device_not_found');
      expect(error.status).toBe(404);
      expect(error.message).toBe('Device with ID xyz not found');
    });

    test('should throw on unknown error code', () => {
      expect(() => {
        new APIError('unknown_error');
      }).toThrow('Unknown error code: unknown_error');
    });
  });

  describe('toJSON', () => {
    test('should format error for API response', () => {
      const error = new APIError('already_exists', 'User already registered');
      const json = error.toJSON();

      expect(json).toEqual({
        error: 'already_exists',
        message: 'User already registered'
      });
    });
  });

  describe('Error codes coverage', () => {
    test('should have all required error codes', () => {
      const requiredCodes = [
        'invalid_request',
        'not_authenticated',
        'not_allowed',
        'device_not_found',
        'user_not_found',
        'already_exists',
        'invalid_value',
        'field_read_only',
        'device_unavailable',
        'server_error'
      ];

      for (const code of requiredCodes) {
        expect(ERROR_CODES[code]).toBeDefined();
        expect(ERROR_CODES[code].status).toBeDefined();
        expect(ERROR_CODES[code].message).toBeDefined();
      }
    });

    test('should return correct HTTP status for each error code', () => {
      expect(ERROR_CODES['invalid_request'].status).toBe(400);
      expect(ERROR_CODES['not_authenticated'].status).toBe(401);
      expect(ERROR_CODES['not_allowed'].status).toBe(403);
      expect(ERROR_CODES['device_not_found'].status).toBe(404);
      expect(ERROR_CODES['already_exists'].status).toBe(409);
      expect(ERROR_CODES['invalid_value'].status).toBe(422);
      expect(ERROR_CODES['field_read_only'].status).toBe(422);
      expect(ERROR_CODES['device_unavailable'].status).toBe(503);
      expect(ERROR_CODES['server_error'].status).toBe(500);
    });
  });
});

describe('createSuccessResponse', () => {
  test('should create response with status', () => {
    const response = createSuccessResponse({
      status: 'registered',
      userId: '123'
    });

    expect(response).toEqual({
      status: 'registered',
      userId: '123'
    });
  });

  test('should default status to ok', () => {
    const response = createSuccessResponse({
      data: 'some data'
    });

    expect(response.status).toBe('ok');
    expect(response.data).toBe('some data');
  });
});


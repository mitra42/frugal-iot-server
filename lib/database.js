/**
 * Database Schema Setup and Utilities
 * Creates tables for Farm IoT Interoperability Standard
 */

import sqlite3 from 'sqlite3';
import { readFile } from 'fs';
import { APIError } from './api-errors.js';

// The whole schema, including the tables for the interoperability standard, lives in one file.
// Resolved relative to this file, not the working directory, so tests can run from anywhere.
const sqlstartpath = new URL('../frugal-iot-createdb.sql', import.meta.url);

/**
 * Initialize database schema
 * Creates every table (and seeds the users the server assumes) by running frugal-iot-createdb.sql,
 * the same file frugal-iot-server.js runs at startup. Safe to run on an existing database.
 * @param {sqlite3.Database} db - SQLite database connection
 * @returns {Promise<void>}
 */
export async function initializeSchema(db) {
  return new Promise((resolve, reject) => {
    readFile(sqlstartpath, 'utf8', (err, sqlstart) => {
      if (err) { reject(err); return; }
      db.exec(sqlstart, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/**
 * Register a user with the device platform (from Farm Platform request)
 * @param {sqlite3.Database} db
 * @param {string} farmPlatformUserId - Farm platform user ID
 * @returns {Promise<{status: string, devicePlatformUserId: string}>}
 * TODO-API review this - unclear if using (as unsure if registering users)
 */
/*
export async function registerUser(db, farmPlatformUserId) {
  return new Promise((resolve, reject) => {
    // Check if user already exists
    db.get(
      'SELECT device_platform_user_id FROM users_farm_platform WHERE farm_platform_user_id = ?',
      [farmPlatformUserId],
      (err, row) => {
        if (err) {
          reject(new APIError('server_error', 'Database error'));
          return;
        }

        if (row) {
          // User already registered - return existing ID
          resolve({
            status: 'registered',
            devicePlatformUserId: row.device_platform_user_id
          });
          return;
        }

        // Create new mapping (using farm platform user ID as device platform ID for now)
        const devicePlatformUserId = `dp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        db.run(
          'INSERT INTO users_farm_platform (farm_platform_user_id, device_platform_user_id, farm_platform_id) VALUES (?, ?, ?)',
          [farmPlatformUserId, devicePlatformUserId, 'default'],
          function(err) {
            if (err) {
              if (err.message.includes('UNIQUE')) {
                reject(new APIError('already_exists', 'User already registered'));
              } else {
                reject(new APIError('server_error', 'Database error'));
              }
              return;
            }

            resolve({
              status: 'registered',
              devicePlatformUserId: devicePlatformUserId
            });
          }
        );
      }
    );
  });
}
*/

/**
 * Register a device to a user
 * @param {sqlite3.Database} db
 * @param {string} devicePlatformUserId - Device platform user ID
 * @param {string} deviceId - Device identifier (org/project/device)
 * @param {string} farmPlatformDeviceId - Farm platform's identifier for the device
 * @returns {Promise<{status: string, devicePlatformDeviceId: string}>}
 * TODO-API review this - unclear if using (as unsure if registering devices to users)
 */
export async function registerDeviceToUser(db, devicePlatformUserId, deviceId, farmPlatformDeviceId) {
  return new Promise((resolve, reject) => {
    // Check if user exists
    db.get(
      'SELECT id FROM users_farm_platform WHERE device_platform_user_id = ?',
      [devicePlatformUserId],
      (err, userRow) => {
        if (err) {
          reject(new APIError('server_error', 'Database error'));
          return;
        }

        if (!userRow) {
          reject(new APIError('user_not_found', 'User not registered with this platform'));
          return;
        }

        // Check if device is already registered to this user
        db.get(
          'SELECT id FROM device_farm_mappings WHERE device_platform_user_id = ? AND device_id = ?',
          [devicePlatformUserId, deviceId],
          (err, deviceRow) => {
            if (err) {
              reject(new APIError('server_error', 'Database error'));
              return;
            }

            if (deviceRow) {
              reject(new APIError('already_exists', 'Device already registered to this user'));
              return;
            }

            // Register device
            db.run(
              'INSERT INTO device_farm_mappings (device_platform_user_id, device_id, farm_platform_device_id, farm_platform_id) VALUES (?, ?, ?, ?)',
              [devicePlatformUserId, deviceId, farmPlatformDeviceId, 'default'],
              function(err) {
                if (err) {
                  reject(new APIError('server_error', 'Database error'));
                  return;
                }

                resolve({
                  status: 'registered',
                  devicePlatformDeviceId: deviceId
                });
              }
            );
          }
        );
      }
    );
  });
}

/**
 * Get user by device platform user ID
 * @param {sqlite3.Database} db
 * @param {string} devicePlatformUserId
 * @returns {Promise<Object|null>}
 */
export async function getUserById(db, devicePlatformUserId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM users_farm_platform WHERE device_platform_user_id = ?',
      [devicePlatformUserId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

/**
 * Confirm a platform_id supplied on a request exists in api_platforms, per API.md Section 6.3
 * @param {sqlite3.Database} db
 * @param {number} platformId - platform_id field from the request body
 * @returns {Promise<number|null>} the platform's id, or null if no such platform is registered
 */
export async function getPlatformById(db, platformId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id FROM api_platforms WHERE id = ?',
      [platformId],
      (err, row) => {
        if (err) reject(new APIError('server_error', 'Database error'));
        else resolve(row ? row.id : null);
      }
    );
  });
}

/**
 * Register a farm-to-project mapping, per API.md Section 6.3
 * @param {sqlite3.Database} db
 * @param {number} platformId - api_platforms.id for the calling platform
 * @param {string} farmId - Farm-Platform's own identifier for the farm
 * @param {string} org - Frugal-IoT organization id
 * @param {string} project - Frugal-IoT project id
 * @returns {Promise<{status: string}>}
 */
export async function registerFarm(db, platformId, farmId, org, project) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id FROM api_farms WHERE platform_id = ? AND farm_id = ? AND org = ? AND project = ?',
      [platformId, farmId, org, project],
      (err, row) => {
        if (err) {
          reject(new APIError('server_error', 'Database error'));
          return;
        }
        if (row) {
          reject(new APIError('already_exists', 'This farm is already registered on this Device-Platform'));
          return;
        }
        db.run(
          'INSERT INTO api_farms (platform_id, farm_id, org, project) VALUES (?, ?, ?, ?)',
          [platformId, farmId, org, project],
          (err) => {
            if (err) reject(new APIError('server_error', 'Database error'));
            else resolve({ status: 'registered' });
          }
        );
      }
    );
  });
}

/**
 * Look up a Frugal-IoT users.id by username, for POST /platform_register
 * @param {sqlite3.Database} db
 * @param {string} username
 * @returns {Promise<number|null>} the user's id, or null if no such user exists
 */
export async function getUserIdByUsername(db, username) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id FROM users WHERE username = ?',
      [username],
      (err, row) => {
        if (err) reject(new APIError('server_error', 'Database error'));
        else resolve(row ? row.id : null);
      }
    );
  });
}

/**
 * List all Farm-Platforms registered on this Device-Platform, for GET /platforms_list
 * A platform is not scoped to a single org - it's a many-to-many relationship with orgs/projects,
 * recorded per-mapping in api_farms - so this lists every platform regardless of org.
 * @param {sqlite3.Database} db
 * @returns {Promise<Array<{id: number, name: string, user: string, base_url: string|null}>>}
 */
export async function getAllPlatforms(db) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT api_platforms.id, api_platforms.name, api_platforms.base_url,
              users.username AS user
       FROM api_platforms
       LEFT JOIN users ON users.id = api_platforms.userid`,
      (err, rows) => {
        if (err) reject(new APIError('server_error', 'Database error'));
        else resolve(rows);
      }
    );
  });
}

/**
 * List farm-to-project mappings registered for an organization, for GET /farms_list
 * @param {sqlite3.Database} db
 * @param {string} org - Frugal-IoT organization id
 * @returns {Promise<Array<{id: number, platform_id: number, farm_id: string, org: string, project: string}>>}
 */
export async function getFarmsByOrg(db, org) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, platform_id, farm_id, org, project FROM api_farms WHERE org = ?',
      [org],
      (err, rows) => {
        if (err) reject(new APIError('server_error', 'Database error'));
        else resolve(rows);
      }
    );
  });
}

/**
 * Register a Farm-Platform in api_platforms, for POST /platform_register
 * @param {sqlite3.Database} db
 * @param {string} name - Platform name
 * @param {number} userId - users.id of the platform's Frugal-IoT account
 * @param {string|null} baseUrl - Platform's base URL, for pushing data (optional)
 * @param {string|null} authToken - Token Frugal-IoT presents when pushing to the platform (optional)
 * @param {string|null} cookieName - Cookie name for Frugal-IoT -> Platform auth (optional)
 * @returns {Promise<{status: string}>}
 */
export async function registerPlatform(db, name, userId, baseUrl, authToken, cookieName) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO api_platforms (name, userid, base_url, auth_token, cookie_name) VALUES (?, ?, ?, ?, ?)',
      [name, userId, baseUrl || null, authToken || null, cookieName || null],
      (err) => {
        if (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            reject(new APIError('already_exists', 'A platform with this name is already registered'));
          } else {
            reject(new APIError('server_error', 'Database error'));
          }
          return;
        }
        resolve({ status: 'registered' });
      }
    );
  });
}



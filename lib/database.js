/**
 * Database Schema Setup and Utilities
 * Creates tables for Farm IoT Interoperability Standard
 */

import sqlite3 from 'sqlite3';
import { APIError } from './api-errors.js';

/**
 * Initialize database schema
 * Creates tables needed for the interoperability standard
 * @param {sqlite3.Database} db - SQLite database connection
 * @returns {Promise<void>}
 */
export async function initializeSchema(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Users table - existing, but we ensure it exists
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          name TEXT,
          password TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Permissions table - existing, maps users to organizations
      db.run(`
        CREATE TABLE IF NOT EXISTS permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          organization TEXT NOT NULL,
          role TEXT DEFAULT 'user',
          UNIQUE(user_id, organization)
        )
      `);

      // Farm Platforms - External farm platforms that connect to this device platform
      db.run(`
        CREATE TABLE IF NOT EXISTS farm_platforms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          base_url TEXT NOT NULL,
          auth_token TEXT NOT NULL,
          cookie_name TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Users registered with Farm Platforms
      db.run(`
        CREATE TABLE IF NOT EXISTS users_farm_platform (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          farm_platform_id TEXT NOT NULL,
          device_platform_user_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, farm_platform_id),
          FOREIGN KEY(farm_platform_id) REFERENCES farm_platforms(name)
        )
      `);

      // Data push queue
      db.run(`
        CREATE TABLE IF NOT EXISTS data_push_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          farm_platform_id TEXT NOT NULL,
          senml_packet TEXT NOT NULL,
          retry_count INTEGER DEFAULT 0,
          last_retry DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(farm_platform_id) REFERENCES farm_platforms(name)
        )
      `);

      // Notification queue
      db.run(`
        CREATE TABLE IF NOT EXISTS notification_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          farm_platform_id TEXT NOT NULL,
          notification_packet TEXT NOT NULL,
          retry_count INTEGER DEFAULT 0,
          last_retry DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(farm_platform_id) REFERENCES farm_platforms(name)
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/**
 * Register a user with the device platform (from Farm Platform request)
 * @param {sqlite3.Database} db
 * @param {string} userId - Farm platform user ID
 * @returns {Promise<{status: string, devicePlatformUserId: string}>}
 */
export async function registerUser(db, userId) {
  return new Promise((resolve, reject) => {
    // Check if user already exists
    db.get(
      'SELECT device_platform_user_id FROM users_farm_platform WHERE user_id = ?',
      [userId],
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
          'INSERT INTO users_farm_platform (user_id, device_platform_user_id, farm_platform_id) VALUES (?, ?, ?)',
          [userId, devicePlatformUserId, 'default'],
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

/**
 * Register a device to a user
 * @param {sqlite3.Database} db
 * @param {string} userId - Device platform user ID
 * @param {string} deviceId - Device identifier (org/project/device)
 * @param {string} farmPlatformDeviceId - Farm platform's identifier for the device
 * @returns {Promise<{status: string, devicePlatformDeviceId: string}>}
 */
export async function registerDeviceToUser(db, userId, deviceId, farmPlatformDeviceId) {
  return new Promise((resolve, reject) => {
    // Check if user exists
    db.get(
      'SELECT id FROM users_farm_platform WHERE device_platform_user_id = ?',
      [userId],
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
          'SELECT id FROM device_farm_mappings WHERE user_id = ? AND device_id = ?',
          [userId, deviceId],
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
              'INSERT INTO device_farm_mappings (user_id, device_id, farm_platform_device_id, farm_platform_id) VALUES (?, ?, ?, ?)',
              [userId, deviceId, farmPlatformDeviceId, 'default'],
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






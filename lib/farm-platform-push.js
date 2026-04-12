/**
 * Farm-Platform Push & Notification System
 * Handles pushing sensor data and notifications to registered Farm-Platforms
 */

import { APIError } from './api-errors.js';
import { toSenML } from './senml-utils.js';

/**
 * Farm Platform Push Manager
 * Manages queue and delivery of data to farm platforms
 */
export class FarmPlatformPushManager {
  constructor(db, httpClient = null) {
    this.db = db;
    this.httpClient = httpClient || null;
    this.retryQueue = [];
    this.maxRetries = 3;
    this.retryDelayMs = 1000; // Start with 1 second
  }

  /**
   * Queue sensor data to be pushed to farm platforms
   * @param {string} deviceId - Device identifier
   * @param {Array} readings - Array of sensor readings
   * @param {string} farmPlatformId - Target farm platform (optional, push to all if not specified)
   * @returns {Promise<Object>} Result summary
   */
  async queueDataPush(deviceId, readings, farmPlatformId = null) {
    return new Promise((resolve, reject) => {
      try {
        if (!readings || readings.length === 0) {
          resolve({ queued: 0, message: 'No data to push' });
          return;
        }

        // Get farm platforms to push to
        this.db.all(
          'SELECT * FROM farm_platforms' + (farmPlatformId ? ' WHERE name = ?' : ''),
          farmPlatformId ? [farmPlatformId] : [],
          async (err, platforms) => {
            if (err) {
              reject(new APIError('server_error', 'Database error fetching platforms'));
              return;
            }

            if (!platforms || platforms.length === 0) {
              resolve({ queued: 0, message: 'No farm platforms configured' });
              return;
            }

            // Create SenML packet
            const baseTime = readings[0].timestamp || Math.floor(Date.now() / 1000);
            const senmlPacket = toSenML(readings, deviceId, baseTime);

            // Queue to each platform
            let queued = 0;
            for (const platform of platforms) {
              const sql = `
                INSERT INTO data_push_queue (farm_platform_id, senml_packet, retry_count, created_at)
                VALUES (?, ?, 0, CURRENT_TIMESTAMP)
              `;

              this.db.run(sql, [platform.name, JSON.stringify(senmlPacket)], (err) => {
                if (!err) queued++;
              });
            }

            resolve({
              queued: queued,
              platforms: platforms.length,
              message: `Queued data for ${queued} platform(s)`
            });
          }
        );
      } catch (err) {
        reject(new APIError('server_error', `Error queuing data: ${err.message}`));
      }
    });
  }

  /**
   * Process push queue and send to farm platforms
   * Called periodically (e.g., every 5 seconds)
   * @returns {Promise<Object>} Processing summary
   */
  async processPushQueue() {
    return new Promise((resolve, reject) => {
      // Get pending queue items
      this.db.all(
        `SELECT * FROM data_push_queue 
         WHERE retry_count < ? 
         ORDER BY created_at ASC 
         LIMIT 10`,
        [this.maxRetries],
        async (err, items) => {
          if (err) {
            reject(new APIError('server_error', 'Database error'));
            return;
          }

          if (!items || items.length === 0) {
            resolve({ processed: 0, message: 'No items in queue' });
            return;
          }

          for (const item of items) {
            try {
              await this.pushToFarmPlatform(item);
              processed++;
            } catch (pushErr) {
              failed++;
              // Update retry count
              this.db.run(
                `UPDATE data_push_queue 
                 SET retry_count = retry_count + 1, last_retry = CURRENT_TIMESTAMP 
                 WHERE id = ?`,
                [item.id]
              );
            }
          }

          resolve({
            processed: processed,
            failed: failed,
            message: `Processed ${processed} items, ${failed} failed`
          });
        }
      );
    });
  }

  /**
   * Push data to specific farm platform
   * @private
   * @param {Object} queueItem - Queue item from database
   * @returns {Promise<void>}
   */
  async pushToFarmPlatform(queueItem) {
    // Get platform info
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM farm_platforms WHERE name = ?',
        [queueItem.farm_platform_id],
        async (err, platform) => {
          if (err || !platform) {
            reject(new Error('Platform not found'));
            return;
          }

          try {
            const senmlPacket = JSON.parse(queueItem.senml_packet);

            // If no HTTP client provided, just log
            if (!this.httpClient) {
              console.log(`[Farm-Platform Push] Would push to ${platform.base_url}/data`);
              console.log(`  SenML Packet:`, senmlPacket);

              // Remove from queue on success
              this.db.run('DELETE FROM data_push_queue WHERE id = ?', [queueItem.id]);
              resolve();
              return;
            }

            // Send to farm platform
            const response = await this.httpClient.post(
              `${platform.base_url}/data`,
              senmlPacket,
              {
                headers: {
                  'Content-Type': 'application/senml+json',
                  [platform.cookie_name]: platform.auth_token
                }
              }
            );

            // Handle response
            if (response.status === 200) {
              // Log accepted/ignored fields if provided
              if (response.data?.accepted) {
                console.log(`  Accepted fields: ${response.data.accepted.join(', ')}`);
              }
              if (response.data?.ignored?.length > 0) {
                console.warn(`  Ignored fields: ${response.data.ignored.join(', ')}`);
              }

              // Remove from queue on success
              this.db.run('DELETE FROM data_push_queue WHERE id = ?', [queueItem.id]);
              resolve();
            } else {
              reject(new Error(`HTTP ${response.status}`));
            }
          } catch (err) {
            reject(new Error(`Push failed: ${err.message}`));
          }
        }
      );
    });
  }

  /**
   * Queue a notification to farm platform
   * @param {string} deviceId - Device sending notification
   * @param {string} message - Human-readable message
   * @param {Object} data - Additional structured data (optional)
   * @param {string} farmPlatformId - Target platform (optional)
   * @returns {Promise<Object>} Result
   */
  async queueNotification(deviceId, message, data = {}, farmPlatformId = null) {
    return new Promise((resolve, reject) => {
      try {
        // Create SenML notification packet
        const baseTime = Math.floor(Date.now() / 1000);
        const notification = [
          { bn: `${deviceId}/`, bt: baseTime },
          { n: 'message', vs: message }
        ];

        // Add structured data if provided
        if (data && typeof data === 'object') {
          for (const [field, value] of Object.entries(data)) {
            if (typeof value === 'number') {
              notification.push({ n: field, v: value });
            } else if (typeof value === 'string') {
              notification.push({ n: field, vs: value });
            } else if (typeof value === 'boolean') {
              notification.push({ n: field, vb: value });
            }
          }
        }

        // Get farm platforms
        this.db.all(
          'SELECT * FROM farm_platforms' + (farmPlatformId ? ' WHERE name = ?' : ''),
          farmPlatformId ? [farmPlatformId] : [],
          (err, platforms) => {
            if (err) {
              reject(new APIError('server_error', 'Database error'));
              return;
            }

            if (!platforms || platforms.length === 0) {
              resolve({ queued: 0, message: 'No platforms configured' });
              return;
            }

            // Queue to each platform (using different table for notifications)
            let queued = 0;
            for (const platform of platforms) {
              const sql = `
                INSERT INTO notification_queue (farm_platform_id, notification_packet, retry_count, created_at)
                VALUES (?, ?, 0, CURRENT_TIMESTAMP)
              `;

              this.db.run(sql, [platform.name, JSON.stringify(notification)], (err) => {
                if (!err) queued++;
              });
            }

            resolve({
              queued: queued,
              message: `Queued notification for ${queued} platform(s)`
            });
          }
        );
      } catch (err) {
        reject(new APIError('server_error', `Error queuing notification: ${err.message}`));
      }
    });
  }

  /**
   * Get push queue statistics
   * @returns {Promise<Object>} Queue stats
   */
  async getQueueStats() {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT 
           COUNT(*) as total,
           SUM(CASE WHEN retry_count = 0 THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as retrying,
           MAX(retry_count) as max_retries
         FROM data_push_queue`,
        (err, stats) => {
          if (err) {
            reject(err);
            return;
          }

          resolve(stats || { total: 0, pending: 0, retrying: 0, max_retries: 0 });
        }
      );
    });
  }
}

/**
 * Create push manager instance
 * @param {sqlite3.Database} db - Database connection
 * @param {Object} httpClient - HTTP client (axios-like) for push operations
 * @returns {FarmPlatformPushManager}
 */
export function createPushManager(db, httpClient = null) {
  return new FarmPlatformPushManager(db, httpClient);
}



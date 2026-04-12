# Integration Guide: Adding API Routes to frugal-iot-server.js

This guide explains how to integrate the Phase 3 API routes into the main `frugal-iot-server.js` file.

## Quick Integration

### 1. Add Imports (near top of file, after other imports)

```javascript
import { createAPIRouter, createAPIErrorHandler } from './lib/api-routes.js';
import { createLoggerClient } from './lib/logger-client.js';
import { createPushManager } from './lib/farm-platform-push.js';
import { initializeSchema } from './lib/database.js';
```

### 2. Initialize Database Schema (in openOrCreateDatabase callback)

After the database is opened successfully, initialize the schema:

```javascript
// In the openOrCreateDatabase callback, after db.run(sqlstart, ...)
initializeSchema(db).catch(err => {
  console.error("Error initializing API schema:", err);
});
```

### 3. Create Logger Client (after database initialization)

```javascript
// Create logger client (use env var or default)
const loggerBaseUrl = process.env.LOGGER_URL || 'http://localhost:3001';
const loggerClient = createLoggerClient(loggerBaseUrl, null); // null = no HTTP client for now
```

### 4. Create Push Manager (after logger client)

```javascript
// Create push manager for Farm-Platform data delivery
const pushManager = createPushManager(db, null); // null = no HTTP client for now
```

### 5. Mount API Router (before other routes, recommend near line 650-700)

```javascript
// Add this after passport initialization and before app.use(express.json())
// Mount API routes (new interoperability standard endpoints)
app.use(express.json()); // IMPORTANT: Required for API POST endpoints

const apiRouter = createAPIRouter(db, config.server.datadir, loggerClient, pushManager);
app.use('/api', apiRouter);

// Add API error handler as catch-all
app.use(createAPIErrorHandler());
```

### 6. Start Push Queue Processor (in main server loop)

```javascript
// After app.listen(), start periodic push queue processing
setInterval(async () => {
  try {
    const result = await pushManager.processPushQueue();
    if (result.processed > 0 || result.failed > 0) {
      console.log(`[Push Queue] ${result.message}`);
    }
  } catch (err) {
    console.error('[Push Queue] Error:', err.message);
  }
}, 5000); // Process every 5 seconds
```

## Testing the Integration

### 1. Start the server with logger available

```bash
# Terminal 1: Start the logger service (if available)
cd ../frugal-iot-logger
npm start

# Terminal 2: Start the main server
cd frugal-iot-server
npm start
```

### 2. Test API endpoints

```bash
# Test GET /api/data (returns empty array if no device)
curl -X GET 'http://localhost:8080/api/data?device=dev/test/esp32&from=1000000000'

# Test POST /api/users/register
curl -X POST http://localhost:8080/api/users/register \
  -H "Content-Type: application/json" \
  -d '{"user-id": "farm-user-1"}'

# Test GET /api/devices/schema
curl -X GET 'http://localhost:8080/api/devices/schema?device=dev/test/esp32'
```

### 3. Run integration tests

```bash
npm test
```

## Environment Variables

Configure these for production:

```bash
# Logger service URL
export LOGGER_URL=http://logger.example.com:3001

# HTTP client (if you have one configured)
export HTTP_CLIENT_TYPE=axios # or similar

# Data directory
export DATA_DIR=./data

# API port
export API_PORT=8080
```

## Configuration Files

No new configuration files needed. The API uses existing `config.yaml` and database schema.

### Farm Platform Registration

Register farm platforms manually in the database:

```sql
INSERT INTO farm_platforms (name, base_url, auth_token, cookie_name)
VALUES ('litefarm', 'https://farm.example.com/api', 'secret-token-123', 'x-farm-token');
```

Or add to `config.yaml` under `farm-platforms:` if you want to automate:

```yaml
farm-platforms:
  litefarm:
    base-url: https://farm.example.com/api
    auth-token: secret-token-123
    cookie-name: x-farm-token
```

## API Endpoints Available

After integration, the following endpoints are available:

### Public Endpoints (no auth required)
- `GET /api/data` - Request historical sensor data (with device, from parameters)
- `POST /api/users/register` - Register farm platform user
- `POST /api/devices/register` - Register device to user
- `POST /api/devices/command` - Send command to device
- `GET /api/devices/schema` - Get device schema

### Notes
- All endpoints require proper request format per API.md
- Error responses follow standardized format
- SenML packets are automatically converted

## Troubleshooting

### "Logger unavailable" warnings
- Not an error - server will work with basic fallback schemas
- Configure LOGGER_URL env var to fix permanently

### Empty device lists
- Ensure device data directories exist in `data/{org}/{project}/{device-id}/`
- Check filesystem permissions

### Schema validation errors
- Device schema must have proper module/field definitions
- Contact logger developer if schema issues persist

### Push queue not processing
- Ensure `setInterval` for `processPushQueue()` was added
- Check database connection

## Next Steps

1. Review main server implementation
2. Add HTTP client for production (axios, node-fetch, etc.)
3. Implement metrics/logging for API usage
4. Add authentication token validation (optional)
5. Set up monitoring for push queue

## Documentation

- See `PHASE3_COMPLETE.md` for full feature details
- See `API.md` for complete API specification
- See `claude.md` for project architecture



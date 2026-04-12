# Frugal IoT Server - Project Documentation

## Project Overview

**Frugal IoT Server** is a Node.js-based IoT platform designed for managing affordable, open-source IoT devices in agroecology and farm settings. It acts as a **Device-Platform** that aggregates data from IoT devices (sensors) and provides integration with **Farm-Platforms** (like LiteFarm and FarmOS).

The server follows the **Farm IoT Interoperability Standard** (defined in API.md), which is a platform-to-platform API specification enabling interoperability between device platforms and farm management platforms.

## Technology Stack

- **Runtime**: Node.js with ES Modules
- **Web Framework**: Express.js v5.0.1
- **Authentication**: Passport.js with LocalStrategy
- **Database**: SQLite3 (frugal-iot.db)
- **Logging**: Custom logger (frugal-iot-logger v1.1.11) that listens to MQTT and logs to disk
- **MQTT**: WebSocket broker integration (wss://frugaliot.naturalinnovation.org/wss)
- **Data Hashing**: hash-wasm v4.12.0 (for MD5 and other hashing)
- **Session Management**: express-session v1.19.0 with cookie-parser
- **File Upload**: multer v2.0.2
- **UI Client**: frugal-iot-client (separate GitHub repo, served from node_modules)

## Project Structure

```
frugal-iot-server/
├── frugal-iot-server.js           # Main server entry point
├── package.json                    # Dependencies and project metadata
├── config.yaml                     # Main configuration file
├── firebase-service-account.json   # Firebase credentials (if applicable)
├── frugal-iot.db                  # SQLite database file
├── config.d/                       # Configuration directory
│   ├── logger.yaml                 # Logger configuration
│   ├── mqtt.yaml                   # MQTT broker configuration
│   ├── server.yaml                 # Server configuration (port, etc.)
│   ├── organizations/              # Organization-specific configs
│   │   ├── dev.yaml               # Developer organization
│   │   └── varta.yaml             # Varta organization
│   └── schema/                     # SenML schema definitions
│       ├── modules.yaml            # Module definitions
│       └── topics.yaml             # MQTT topic schemas
├── data/                           # Data storage directory
│   ├── dev/                        # Developer organization data
│   │   ├── developers/             # Developer projects
│   │   ├── lotus/                  # Lotus project
│   │   └── magi/                   # Magi project
│   └── varta/                      # Varta organization data
├── ota/                            # Over-the-Air update files
│   ├── dev/
│   └── varta/
├── extras/                         # System service files
│   ├── frugaliot.service           # Systemd service file
│   └── mosquitto.conf              # Mosquitto configuration
├── public/                         # Static web assets
│   ├── index.html                  # Main UI
│   ├── manifest.json               # PWA manifest
│   ├── service-worker.js           # Service worker for PWA
│   ├── images/                     # Icon and image assets
│   └── favicon.ico
└── private/                        # Private web files
    └── index.html
```

## Key Features

### 1. **Device Management**
- Manages IoT devices (nodes) that send sensor data via MQTT
- Supports multiple organizations and projects
- Device hierarchies: Organization → Project → Device
- Stores device metadata and configuration

### 2. **Data Management**
- Stores sensor readings in time-series format on disk
- Supports per-device data storage in `data/{org}/{project}/{device-id}/`
- Implements data logging from MQTT topics
- Provides data retrieval API for historical analysis

### 3. **MQTT Integration**
- Connects to MQTT brokers via WebSocket (WSS) for real-time data collection
- Spawns logger that listens to MQTT topics and logs data to disk
- Supports per-organization MQTT credentials
- Topic structure follows pattern: `{org}/{project}/{device-id}/{module}/{field}`

### 4. **Over-The-Air (OTA) Updates**
- HTTP endpoints for devices to check and download firmware updates
- Web-based admin interface for uploading new binaries
- Directory structure: `ota/{org}/{project}/`
- Devices call: `GET /ota_update/:org/:project/:node/:attribs`

### 5. **Authentication & Authorization**
- User registration system with email and password
- Passport.js-based authentication with session support
- Organization-based permission model
- Role-based access control (admin, user, device-specific permissions)
- Protected endpoints for authenticated users

### 6. **API Endpoints** (See API.md for full specification)

#### Public Endpoints
- `GET /` - Static UI serving (frugal-iot-client)
- `GET /login` - Login form
- `POST /login` - Authenticate user
- `POST /register` - Register new user
- `GET /ota_update/:org/:project/:node/:attribs` - Download OTA update

#### Authenticated Endpoints (requires login)
- `GET /dashboard` - User dashboard
- `GET /config.json` - Organization-specific configuration
- `GET /data/{org}/{project}/{device-id}` - Historical device data
- `GET /private/*` - Private files
- `POST /ota_update` - Upload OTA binary (admin only)

#### API Endpoints (Device-Platform to Farm-Platform)
- `GET /data?device={id}&from={ts}&to={ts}` - Request historical data
- `POST /users/register` - Register farm platform user
- `POST /devices/register` - Register device to user
- `POST /devices/command` - Send command to device
- `GET /devices/schema?device={id}` - Get device schema

### 7. **Configuration System**
- YAML-based configuration
- Hierarchical config structure:
  - `config.yaml` - Main config
  - `config.d/server.yaml` - Server settings
  - `config.d/mqtt.yaml` - MQTT configuration
  - `config.d/logger.yaml` - Logger settings
  - `config.d/organizations/{org}.yaml` - Per-organization config
  - `config.d/schema/` - Data schema definitions

### 8. **Web Client**
- Progressive Web App (PWA) support
- Service Worker for offline functionality
- Responsive UI with icon support
- Available at `/dashboard` when authenticated

## Important Configuration Notes

### Authorization Model
The server implements three levels of authorization:

1. **Public** (`*`) - Available to everyone
2. **Authenticated** (`A`) - Requires login, not checking org permissions
3. **Organization-based** (`O`) - Authenticated user must belong to correct organization
4. **Admin/Permission-based** (`P`) - Stricter permissions beyond org membership

### Organization Structure
Organizations are defined in `config.d/organizations/{org}.yaml` and include:
- MQTT credentials
- List of projects

### Sessions and Authentication
- Uses Passport.js with LocalStrategy
- Sessions stored via express-session
- User data deserialized from database on each request
- Permissions retrieved from database during deserialization

## Development Notes

### Starting the Server

```bash
npm install
npm update  # Get latest frugal-iot-client
node frugal-iot-server.js
```

Expected startup output:
- Configuration files read
- MQTT connections initialized per organization
- Logger started listening to MQTT topics
- Server listening on configured port (default 8080)
- Web client served from frugal-iot-client

### Production Deployment

The server is typically deployed as a systemd service:
```bash
sudo cp extras/frugaliot.service /usr/lib/systemd/system/
sudo systemctl enable frugaliot
sudo service frugaliot start
```

**Important**: OTA updates require HTTPS, so the server should be deployed behind a reverse proxy (nginx/Apache) with SSL.

## SenML Data Format

The server external API uses **SenML** (Sensor Measurement Lists) per RFC 8428 for all sensor data:

```json
[
  {"bn": "dev/org/esp32-123456/", "bt": 1.276020076001e+09},
  {"n": "sht/temperature", "v": 32.0, "u": "Cel"},
  {"n": "sht/humidity", "v": 85.2, "u": "%RH"}
]
```

- `bn` = Base name (device identifier)
- `bt` = Base time (Unix timestamp)
- `n` = Field name (module/field format)
- `v` = Value
- `u` = Unit

## Device Schema

Each device has a schema mapping fields to semantic meaning:

```json
{
  "device-platform-device-id": "dev/org/esp32-123456",
  "farm-platform-device-id": "farm-device-1",
  "modules": {
    "sht": {
      "fields": [
        {"field": "temperature", "type": "float", "units": "Cel", "rw": "r"},
        {"field": "humidity", "type": "float", "units": "%RH", "rw": "r"}
      ]
    }
  }
}
```

## Database Schema

The server uses SQLite for user management and permissions:
- `users` table - User accounts with id, name, email, password
- `permissions` table - User-to-organization mappings with role/capability info

## Common Development Tasks

### Adding a New Organization
1. Create `config.d/organizations/{org}.yaml`
2. Add entries to database `permissions` table
3. Restart server

### Adding a New Device
- Device connects to MQTT broker
- Logger automatically creates data directory structure
- Device appears in UI under its organization/project

### Modifying Routes
All routes are defined in `frugal-iot-server.js` (main file with ~913 lines)

### Updating OTA Binaries
- Upload via admin dashboard (`POST /ota_update`)
- Files stored in `ota/{org}/{project}/`
- Devices fetch latest via `GET /ota_update/{org}/{project}/{node}/{attribs}`

## Known Limitations (See API.md Section 11)

1. User-device relationship model not fully specified
2. Notification configuration not yet defined
3. MQTT transport details incomplete
4. Multi-device data requests not supported
5. Authentication scheme deferred to future version
6. Device discovery mechanism not defined
7. Device status/diagnostics not yet standardized

## Related Projects

- **frugal-iot-client** - UI client (separate GitHub repo)
- **frugal-iot-logger** - MQTT listener and data logger
- **Farm Platforms**: LiteFarm, FarmOS (integrating partners)
- **Related IoT**: OurSci (another device platform)

## Security Considerations

- All production deployments MUST use HTTPS
- MQTT connections use WSS (WebSocket Secure)
- Authentication tokens exchanged during platform registration
- Device commands validated against schema (type, min/max, rw permissions)
- Authorization enforced at organization level

## Performance Notes

- Data stored on disk for scalability
- Each device gets its own directory hierarchy
- Logger runs in same process.
- Session state stored server-side
- No built-in caching layer (consider adding for historical data queries)

## Troubleshooting

### Common Issues

1. **MQTT Connection Failed**: Check `config.d/mqtt.yaml` and verify broker URL
2. **OTA Updates Not Working**: Ensure HTTPS is enabled and proper CORS headers set
3. **Data Not Appearing**: Check logger is running and MQTT topics match device configuration
4. **Authentication Fails**: Verify user exists in database and organization matches in permissions table
5. **PWA Icon Not Showing**: Check `manifest.json` and image paths in `public/images/`

## Future Enhancements (from code comments)

- TODO-89: Move to dashboard-centric architecture
- TODO-S16: Implement per-organization data access controls
- Formal registration protocol for platform-to-platform setup
- Device schema discovery mechanism
- Multi-device query support
- Standardized diagnostic/status endpoints


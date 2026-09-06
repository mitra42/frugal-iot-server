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

## Coding Style Preferences

### Indentation
- **Use 2 spaces for indentation** (not tabs or 4 spaces)
- Apply consistently throughout all JavaScript files

### Asynchronous Code
- **Prefer callbacks over promises** for backward compatibility and consistency with existing codebase
- Use the callback pattern: `function(param, callback)` where `callback(err, result)` follows Node.js conventions
- Error-first callbacks: `callback(error)` on failure, `callback(null, result)` on success

Example:
```javascript
function readData(filePath, callback) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      callback(err, null);
    } else {
      callback(null, data);
    }
  });
}

// Usage
readData('/path/to/file', (err, result) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Success:', result);
  }
});
```

### Shell scripts

Everything in `scripts/` is zsh, except `install-pi.sh`, which is bash on purpose: a freshly
flashed Pi has no zsh, and that script is what installs it.

Four things have caused real bugs here, more than once each:

* **`set -euo pipefail` plus command substitution kills the script silently.** A pipeline that
  "fails" harmlessly ends the run before it has printed anything — `grep` finding no match,
  `mosquitto_sub -W` timing out (it *always* exits non-zero), `head -c` closing the pipe on `tr`.
  Write `X=$(...) || true` wherever the failure is expected, or wrap in `( set +o pipefail; ... )`
  the way `install-pi.sh`'s `randpw` does.
* **Reading a root-only file as an ordinary user returns nothing, not a visible error.**
  `cut -d: -f1 /var/lib/mosquitto/passwords` as `pi` is empty, which looks exactly like "that
  account does not exist". Retry with `sudo` whenever the first attempt comes back empty.
* **zsh has special parameters.** `USERNAME` and `HOST` are tied to the real user and machine, so
  assigning to them does not do what it looks like — a script that set `USERNAME` connected to the
  broker as the login user instead. Name them `BROKER_USER`, `BROKER_HOST`.
* **BSD sed (macOS) has no `\b`.** A word-boundary substitution silently does nothing on a
  workstation while working on the Pi. Use python for anything that has to run on both.
* **A script run through `npx` must take positional arguments.** npm parses the whole command line
  itself, treats any `--flag` it does not recognise as an unknown config setting, and passes only
  the *values* on — so `npx --no frugal-iot-foo --org myfarm` reaches the script as a bare
  `myfarm`, and it reports an unexpected argument it never asked for. That is why every script
  here takes positional arguments. `npx --no cmd -- --flag value` does work, but relies on whoever
  is typing it knowing that.

## Development Notes

### Never commit

Do not run `git commit` (or `git push`), for changes made by anyone. Every change - whether written
by a person or by an assistant - is reviewed in a separate tool before being committed. Leave work
in the working tree and say what was changed.

### A changed extras/ file does not reach /etc by itself

`frugal-iot-init` copies `extras/` into the install directory but **never overwrites** what is
already there - it prints `kept ... (DIFFERS from this release)` and moves on. So `install-pi.sh`
reads `node_modules/frugal-iot-server/extras/`, not the install directory's copy, or a
security-relevant change to the shipped broker configuration would never reach `/etc` however many
times the installer was re-run. That is how a broker with no `acl_file` survived several releases.
The same applies by hand: copy from `node_modules/...`, not from `./extras`.

### Caching the client: a day, but never `immutable`

These users are often on an expensive link with poor reception, so a request saved matters more than
a minute's freshness - the cache is deliberately long. But `immutable` was wrong: it means "do not
even ask again", and these URLs carry no version (`/dashboard/admin.js` is whatever the release
installed), so it promised something untrue. The difference that matters is that **a reload
revalidates a `max-age` resource and does not revalidate an `immutable` one** - so dropping just
that flag keeps ordinary navigation free of requests while a refresh picks up a new release.

`maxAge: 0` is not the answer either: `frugaliot.css` is re-linked by every web component as it
renders, and rechecking it each time flashes unstyled content on a slow link.

Freshness for an installed PWA is `public/service-worker.js`, not the header: it is cache-first, its
`CACHE_NAME` follows the release, and it installs with `cache: 'reload'`, bypassing the HTTP cache.

Two rules for `urlsToCache`, each of which fails silently:

* **Every entry must return 200 without a session.** `install()` rejects the whole cache if one
  entry fails, so a single 404 or redirect-to-login leaves the PWA with **no cache at all** - and
  the app still works online, so nothing says so. `/dashboard/*.js` and the stylesheet do serve
  unauthenticated; `/dashboard/index.html` 307s to the login page.
* **Never a session-gated page.** A cached `/dashboard/index.html` would be served to a logged-out
  visitor - the case `admin.js` already has a comment about.

Note the version in the URL that neither of these needs: it would allow a year's caching AND instant
release visibility, and it needs the client's module imports to carry it. Not done.

### PlatformIO: a compile error in a file you did not touch

A damaged `.pio/libdeps` reports the failure against an unrelated source file, and can take the
scons database with it - two builds in a row failing differently for no reason. The real message is
further up: `FileNotFoundError: .pio/libdeps/<env>/<Library>/src/...`. Delete that one library
directory so PlatformIO refetches it, rather than trusting the file it named.

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

```
npx --no frugal-iot-addorganization <org-id> "<name>" <email> <phone> "<broker-password>"
sudo systemctl reload mosquitto     # re-reads the password file, drops nothing
sudo systemctl restart frugaliot    # organizations are only read at startup
```

Run from the server's own directory. The script writes `config.d/organizations/{org}.yaml`, creates
the OTA directory, creates a login user, adds its `permissions` rows, and sets the organization's
password in the broker's password file — that last step is the one most easily forgotten when doing
this by hand, and without it the server's own logger cannot connect as the new organization.

The same string becomes both the login password and the broker password. They are entirely
different things: the broker password is handed to every logged-in browser (see **Credentials**
under MQTT below) so it is not a secret, while the login password is. Change the login one
afterwards with `npx --no frugal-iot-setpassword <org-id> "<real password>"`.

### Adding a New Device
- Device connects to MQTT broker
- Logger automatically creates data directory structure
- Device appears in UI under its organization/project

### Modifying Routes

Most routes are defined in `frugal-iot-server.js` — the dashboard, login and registration,
`/config.json`, `/data`, `/private`, and OTA.

The platform-to-platform API of API.md is not there: it is a router built by
`createAPIRouter()` in `lib/api-routes.js` (`/platforms/*`, `/farms/*`, `/devices/*` and its own
`/data`), mounted under a prefix by the main file. Add an API endpoint there, not here.

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
- **frugal-iot** - the node firmware (ESP32/ESP8266). On this machine the working checkout is
  `~/Documents/Arduino/frugal-iot-demo/lib/Frugal-IoT` - a library inside the PlatformIO project
  `~/Documents/Arduino/frugal-iot-demo`, whose own `src/main.cpp` is the sketch under development.
  This is always where the node code is. It is deliberately *not* alongside the other three repos
  in `~/git/github_mitra42/`, and two nearby directories look like it but are not:
  `~/Documents/Arduino/frugal-iot-OLD` is a stale checkout, and `~/temp/frugal-iot` is a server
  *install*.
- **Farm Platforms**: LiteFarm, FarmOS (integrating partners)
- **Related IoT**: OurSci (another device platform)

## Security Considerations

- All production deployments MUST use HTTPS
- MQTT connections use WSS (WebSocket Secure)
- Authentication tokens exchanged during platform registration
- Device commands validated against schema (type, min/max, rw permissions)
- Authorization enforced at organization level

## Broker accounts: who has which credential

Every actor has its own broker account, created and maintained by the server through mosquitto's
dynamic security plugin. `lib/dynsec-plan.js` is the single description of what should exist; both
"apply" and "report differences" are driven from it, which is what makes *the database is the source
of truth, and the broker can be rebuilt from it* a fact rather than a claim
(`npx --no frugal-iot-rebuild-dynsec`, or `... check` to report only).

| Actor | Account | Password | Can do |
| --- | --- | --- | --- |
| User | `user/<login>` | Derived: `HMAC(user_secret, login ‖ hashed_password)` | Groups per capability: read its organization, publish `set/` only |
| Node | `<org>/<project>/<nodeid>` | Random at enrolment, **stored in the `nodes` table** | Read its organization, publish only its own subtree |
| LoRa gateway | as a node, plus `<org>-gateways` | as a node | Also publish anywhere in the organization |
| Logger | `<org>-logger` | Derived: `HMAC(user_secret, 'logger:' ‖ org)` | Read its organization, publish `set/` only |
| Server itself | `frugal-admin` | In `config.d/secrets.yaml` | Drive the plugin |
| Server, per organization | `<org>-admin` | Derived: `HMAC(user_secret, 'orgadmin:' ‖ org)` | Publish anywhere in that organization — only to clear retained messages |

Four reasons behind that table, each of which cost something to find out:

* **A user's is derived from the STORED HASH, not the plaintext.** The server only holds the
  plaintext for the few milliseconds of a login POST, so anything derived from it could not be
  recomputed for a session restored from a cookie. Deriving from the hash means `/config.json` can
  answer at any time, two concurrent logins agree, and changing the login password retires the old
  broker credential by itself.
* **A node's is random and stored, not derived.** A node keeps its copy in LittleFS and cannot
  recompute anything, so a derivation secret going missing would strand the whole fleet.
* **Clearing a retained message needs an account that can forge a reading.** "Forget this topic"
  IS a publish - an empty retained payload - and the broker cannot tell it from an invented value.
  So it is done by the server (`POST /retained_delete/:org` → `lib/retained.js`) as `<org>-admin`,
  not by the browser as it used to be. Two traps: that role belongs to **no group**, so nothing can
  drift into it, and a browser's failed attempt looked like a success, because an MQTT 3.1.1 broker
  PUBACKs a QoS 1 publish before deciding whether to allow it.
* **User accounts are prefixed `user/`.** `addorganization.zsh` creates a login named after the
  organization, and the organization's own broker account has that same name - so an unprefixed
  dynsec client called `myfarm` would take over that name, and because a dynsec answer is final for
  a client it knows, the shared password every node uses would stop working.

Secrets live in `config.d/secrets.yaml` (never served: `lib/config-for-user.js` withholds the
section). `lib/secrets.js` generates anything missing **and writes it back**, so an installation
upgraded from before that file fixes itself once instead of quietly using a value that changes on
every restart.

### Talking to the dynamic security plugin

Three things about it that are not in the documentation and each of which fails confusingly:

* **Commands go to `$CONTROL/dynamic-security/v1`; replies come back on
  `$CONTROL/dynamic-security/v1/response`.** Subscribe to the command topic - the obvious guess -
  and you get no reply *while the commands still execute*, so things happen and nothing answers.
* **Every "already ..." error means "nothing to do"**, and the wording differs per command: "Role
  already exists", "Group is already in this role", "Client is already in this group". Treat them
  all as success or a re-run aborts part-way through, which is worse than not re-running at all.
* **Re-adding a role a client already has answers "Internal error"** - `mosquitto_ctrl` says the
  same, so it is the plugin's wording, and it is indistinguishable from a real fault. Read the
  client first and send only what is missing.

And when inspecting state by hand: **group membership is stored on the group in
`dynamic-security.json`, not on the client.** Reading that file makes every client look like it
belongs to nothing. `mosquitto_ctrl ... dynsec getClient <name>` shows the truth.

## Performance Notes

- Data stored on disk for scalability
- Each device gets its own directory hierarchy
- Logger runs in same process.
- Session state stored server-side
- No built-in caching layer (consider adding for historical data queries)

## MQTT, Mosquitto and bridges

Measured on mosquitto 2.0.21 (Pi) and 2.0.20 (production), not read off a web page. Each of these
was got wrong first.

### What mosquitto reads, and as whom

Mosquitto reads its **configuration** as root and *then* drops to the `mosquitto` user. So a config
file may be mode 600 root — the bridge one should be, since it holds a password. But it reads the
**TLS key**, the **password file** and the **ACL file** *after* dropping, so all three must be
readable by the `mosquitto` user or the broker refuses to start, with an error that says nothing
about ownership (`Unable to load server key file ... Permission denied`).

The same trap makes `mosquitto_passwd` dangerous: run as root it rewrites the password file owned
by root, and the broker can then no longer read it. Run it as the file's owner — `addorganization.zsh`
and `addbridge-prod.zsh` both work out who that is.

### Reload versus restart

* A replaced **certificate** is picked up by `systemctl reload`, dropping no connections.
* The **password file** and **ACL file** are re-read on reload too.
* **Bridges are not.** Adding or changing one needs a full restart, briefly dropping every node.

### Bridges

* A bridge speaks MQTT or MQTT-over-TLS only — **it cannot use WebSockets**, and `address` takes no
  URL scheme. The `wss://` endpoint browsers use cannot carry one; production needs its own TLS
  listener (8883).
* `certfile` must contain the intermediate as well as the leaf. A browser can often fill in a
  missing intermediate from cache; a bridge never can.
* Loop protection is `try_private`, on by default, and works between two mosquittos. MQTT has no
  hop count, so three brokers in a cycle — or a non-mosquitto peer — would loop for ever.
* `cleansession` defaults to false and should stay there. `true` makes the remote re-send every
  retained message on *every* reconnect, which on a flaky link is a burst of duplicate readings.
* **The QoS on a `topic` line decides what an outage costs.** At 0, anything published while the
  far end is unreachable is dropped — a gap. At 1 the broker queues it and delivers the backlog on
  reconnect, where the receiving logger stamps every reading with its arrival time, so a day's
  outage arrives claiming to have happened in one instant. A gap is honest; that is not. Readings
  are bridged at QoS 0 deliberately.
* Even at QoS 0, the last retained value of each topic is re-sent on reconnect — so expect one row
  per topic per outage carrying the reconnect timestamp.
* `notifications` (on by default) publishes a retained `1`/`0` to
  `$SYS/broker/connection/<remote_clientid>/state` on **both** brokers. That is what
  `frugal-iot-diagnostic` reads to say whether a bridge is up.

### Access control

`acl_file` is **deny-by-default**: naming one stops every account that has no rule in it, so the
rule granting the existing organizations has to land in the same change as the one restricting a
new account. `pattern readwrite %u/#` gives each account its own topic tree. It is shipped in
`extras/aclfile` and installed by `install-pi.sh`, as **mosquitto:mosquitto mode 600** — not root
644, which 2.0.21 accepts while warning on every start that a future version will refuse it.

Two things measured on 2.0.21 that are not obvious:

* **A bridge's local side is exempt from the ACL**, in both directions, with no `local_username` and
  no anonymous rule. So adding an `acl_file` to a Pi does not interrupt its bridge.
* **`pattern readwrite %u/#` does not match `$SYS`**, so it breaks `frugal-iot-diagnostic`'s
  bridge-state check. `pattern read $SYS/broker/connection/+/state` restores that one topic; a bare
  `topic` line would not, because those apply to anonymous clients only. Mosquitto warns that the
  pattern contains no `%u` — harmless, and the only way to say "every authenticated account".
* **`systemctl reload mosquitto` on a Pi with a bridge logs `Unable to open config file
  ...frugal-iot-bridge.conf` and `Error found at mosquitto.conf:13`.** Harmless — password and ACL
  changes still take effect, and the bridge is unaffected — but alarming in the log. The cause is
  that a reload re-reads the configuration as the `mosquitto` user, after privileges have been
  dropped, and the bridge file is 600 root by design. Only a *start* reads it as root.

### What the logger does with what arrives

* **Only five-level topics** (`org/project/node/module/field`) are written to disk. Sets, six-level
  parameters and the two-level quickdiscover are all dropped by `shouldLog`. So duplicate delivery
  only costs duplicate *rows* on that one shape — which is why the bridge's topic rules deliberately
  put their unavoidable overlap on the `set` topics.
* Readings are timestamped by the **receiving** server as they arrive, not by the node. Any replay
  or backfill scheme has to deal with that.
* Nodes publish nearly everything **retained, at QoS 1** — readings, and their min/max/colour/wiring
  too. A topic published by mistake therefore outlives the mistake, and fixing the node does not
  remove it; `frugal-iot-clearretained` publishes the empty message that does.

### Credentials

`/config.json` serves the whole configuration — `mqtt_password` included — to any logged-in browser
(`unsafeCopyConfigFor` in frugal-iot-server.js). An organization's broker password is therefore
**not a secret**, and nothing secret can live anywhere under `config.d/`. That is why a bridge's
password goes in `/etc/mosquitto/conf.d/` instead, and why each Pi gets its own broker account
rather than sharing the organization's.

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


# Frugal IoT — security

How the Frugal IoT server, its broker, its nodes and its dashboard authenticate each other, and
where each credential lives. Companion to INSTALLATION.md (how to set it up) and API.md (the
platform-to-platform API).

---

## 1. Credentials at a glance

Every actor has its own broker account. `lib/dynsec-plan.js` is the single description of what
should exist; the database is the source of truth and the broker is rebuilt from it with
`npx --no frugal-iot-rebuild-dynsec` (add `check` to report differences only).

| Actor | Broker account | Credential is | Held in | May do |
| --- | --- | --- | --- | --- |
| Web user | `user/<login>` | Derived: `HMAC(user_secret, login ‖ hashed_password)` | Nowhere — recomputed on demand | Read its organizations; publish `set/` only |
| Node | `<org>/<project>/<nodeid>` | Random, issued at enrolment | `nodes` table; the node's LittleFS | Read its organization; publish only its own subtree |
| LoRa gateway | as a node, plus `<org>-gateways` | as a node | as a node | Also publish anywhere in its organization |
| Logger | `<org>-logger` | Derived: `HMAC(user_secret, 'logger:' ‖ org)` | Nowhere | Read its organization; publish `set/` only |
| Server → plugin | `frugal-admin` | Random, at install | `config.d/secrets.yaml` | Administer broker accounts |
| Server → organization | `<org>-admin` | Derived: `HMAC(user_secret, 'orgadmin:' ‖ org)` | Nowhere | Publish anywhere in that organization — only to clear retained messages |
| Anonymous browser | none | — | — | Read whatever is marked public |
| *Organization (legacy)* | `<org>` | Set by hand | `config.d/organizations/<org>.yaml` | Read/write its whole organization — **retires at S8** |

Derived credentials are computed from `user_secret` when needed, so they can be reissued without
being stored and a rebuild reproduces them exactly. A node's is random and stored instead: a node
keeps its copy in flash and can recompute nothing, so a lost secret would strand the fleet.

A web user's is derived from the **stored password hash**, not the plaintext — the server only holds
the plaintext for the duration of a login. So `/config.json` can answer at any time, two concurrent
logins agree, and changing a login password retires the old broker credential by itself.

### Who administers what

| | |
| --- | --- |
| People, capabilities, projects, node resets, retained messages, OTA uploads | The dashboard, by an organization ADMIN |
| Organizations | `frugal-iot-addorganization`, `frugal-iot-setpassword` |
| Broker accounts | The server, automatically; `frugal-iot-rebuild-dynsec` to repair or report |
| Diagnosis | `frugal-iot-diagnostic` |

---

## 2. The paths, in more detail

### Capabilities

One table, `permissions(id, capability, org, project)`. An empty `project` means the whole
organization. `id = 0` means *everyone, logged in or not*.

| Capability | Grants |
| --- | --- |
| `READ` | See an organization's data, live and stored |
| `WRITE` | Change a device: `set/` over MQTT, and the API's action/property routes |
| `ADMIN` | The dashboard's administration of that organization |
| `OTAUPDATE` | Upload and manage firmware |
| `OTAFLASH` | Flash over USB from the browser |

`WRITE` is implied by neither `READ` nor `ADMIN`. Only `READ` and `WRITE` map to broker groups; the
rest are enforced by the server.

### Web user

1. `POST /login` → Passport local strategy against `users.hashed_password`; session cookie signed
   with `session_secret`. Sessions are in memory, so a server restart means logging in again.
2. The server brings the user's broker account into line with their permissions, and `/config.json`
   returns the configuration they are allowed to see plus `user.mqtt_username` / `user.mqtt_password`.
3. The browser connects to the broker over WSS with that credential, and is in one group per
   capability per organization or project.

Revoking a permission takes effect at the broker on the user's next login, or immediately after
`frugal-iot-rebuild-dynsec`.

`/config.json` is served to any logged-in browser, so **nothing secret may live under `config.d/`**
other than in `secrets.yaml`, which is never served. That is why a bridge's password goes in
`/etc/mosquitto/conf.d/` instead.

### Node

Firmware carries an **enrolment secret**, which grants exactly one thing: create a node in this
organization. No read, no write, no broker access.

1. `POST /enrol` with organization, project, node id and that secret.
2. The organization must exist, the secret must be in its `enrolment_<org>` list, and the project
   must already be registered — a mistyped project is refused, not invented.
3. The server creates the broker account, stores the credential in `nodes`, and returns it. The node
   writes it to LittleFS (`/mqtt/username`, `/mqtt/password`) and never echoes it to MQTT.

A node id comes from the chip's MAC and is therefore public, so a node that already exists must
prove it holds the current password. One whose filesystem was erased cannot, and needs a human:
the dashboard's Nodes tab, or `frugal-iot-resetnode`.

The enrolment secret list is per organization and revocable server-side, so a leaked one is deleted
without reflashing anything. Rate limited per organization and per node id.

### LoRa gateway

A gateway republishes other nodes' readings under its own account, so it must be able to publish
across its organization — `<org>-gateways`, granted at enrolment to firmware built with LoRaMesher.
The firmware limits what it will relay: the topic must be inside the gateway's own
`<org>/<project>/`, and a node id must match the radio address that first claimed it. Attribution
behind a gateway is still weaker than in front of one.

### Logger

Runs in the server process, with its own account per organization. Writes readings to
`data/<org>/<project>/<node>/`, buffered in memory and flushed periodically. Only five-level topics
(`org/project/node/module/field`) are written; sets, parameters and discovery messages are not.
Readings are timestamped on arrival, not by the node.

### Broker access control

Two mechanisms, both active. Accounts created by the server use the **dynamic security plugin**;
anything left in the password file falls back to `/etc/mosquitto/aclfile`, which is deny-by-default.

| Role | Rule |
| --- | --- |
| `<org>-read[-<project>]` | Subscribe and receive that subtree |
| `<org>-write[-<project>]` | `publishClientSend <org>/+/+/set/#` |
| own subtree (every node) | `publishClientSend %u/#` |
| `<org>-discover` | Publish the two-level advertisement, per registered project |
| `<org>-gateways` | Publish anywhere in the organization |
| `<org>-clear` | Publish anywhere in the organization — server only, in no group |
| public | The `id = 0` READ rows, as ACLs on one shared role |

Clearing a retained message *is* a publish — an empty payload — and the broker cannot tell it from
an invented reading. So it is done by the server (`POST /retained_delete/:org`) rather than by the
browser, which cannot publish readings at all.

### Data over HTTP

`GET /data/<org>/<project>/<node>/...` serves stored readings, gated on `READ` for the organization
taken from the normalised path. The API of API.md is a separate router: `READ` for data, `WRITE` for
anything that commands a device.

### Firmware over the air

`GET /ota_update/:org/:project/:node/:attribs` is unauthenticated — a node has no credential to
offer for it. Uploading and deleting need `OTAUPDATE`. All OTA paths are resolved and then checked
to be inside their root. OTA requires HTTPS, so production runs behind a reverse proxy.

### Transport

| | |
| --- | --- |
| Browsers | HTTPS, and MQTT over WSS |
| Nodes | MQTT on 1883, **unencrypted**; enrolment over HTTPS with a pinned root CA |
| Server, logger | MQTT on 1883, loopback |
| Broker-to-broker bridge | MQTT over TLS on 8883 |

### Where everything is stored

| What | Where |
| --- | --- |
| Logins, password hashes | `frugal-iot.db`, `users` |
| Capabilities | `frugal-iot.db`, `permissions` |
| Node credentials | `frugal-iot.db`, `nodes` |
| Projects | `frugal-iot.db`, `projects` |
| Server secrets | `config.d/secrets.yaml` — never served, generated if absent |
| Organizations | `config.d/organizations/<org>.yaml` — served to logged-in browsers |
| Broker accounts, groups, roles | `/var/lib/mosquitto/dynamic-security.json` |
| Legacy broker passwords | `/var/lib/mosquitto/passwords`, with `/etc/mosquitto/aclfile` |
| Bridge credentials | `/etc/mosquitto/conf.d/`, mode 600 root |
| A node's own credential | Its LittleFS: `/mqtt/username`, `/mqtt/password` |
| Readings | `data/<org>/<project>/<node>/` |
| Sessions | Server memory |

---

## 3. Next steps

**S8 — retire the shared organization credential.** Only once every node has re-enrolled. Remove
`<org>` from the broker's password file and `mqtt_password` from
`config.d/organizations/*.yaml`; stop `addorganization` creating one. Until this is done, a
credential extracted from any node's flash can still publish anything in that organization.

**S9 — optional.**

* TLS to the broker for ESP32-class nodes. Small change in the firmware, but it holds ~32 KB of heap
  unless the mbedTLS buffers are tuned. ESP8266 stays on 1883.
* A password on the node's SoftAP, and `ON_AP_FILTER` on its `POST /restart`.
* A version in client asset URLs, so they can be cached for a year and still appear the instant a
  release changes them.

Not fixed by either, and structural: **a node's flash is readable**, so anyone holding a node has
that node's credential. Per-node accounts limit the damage to that one node; nothing prevents the
extraction.

---

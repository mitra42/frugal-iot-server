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
| Bridged Pi | not a broker account | Random token, at pairing | `config.d/secrets.yaml` on the Pi | Read one organization's logins and permissions from production |
| Grafana, or anything reading history | not a broker account | Random token, made by any user who can READ the organization | `frugal-iot.db`, `grafana_tokens` — only a SHA-256 of it | Read what its maker may READ in one organization, over `/grafana/<org>/`; nothing else |
| A forwarder (OpenSearch, Google Sheets) | not a broker account | Whatever the destination takes | `frugal-iot.db`, `forwarders` — in the clear | Send one organization's logged readings where its ADMIN pointed it |
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
| People, capabilities, projects, node approvals and denials, retained messages, OTA uploads | The dashboard, by an organization ADMIN |
| Enrolment secrets | The dashboard's Nodes card, by an organization ADMIN |
| Organizations | `frugal-iot-addorganization`, `frugal-iot-setpassword` |
| Broker accounts | The server, automatically; `frugal-iot-rebuild-dynsec` to repair or report |
| Forwarders | The dashboard's Forwarders card, by an organization ADMIN |
| Grafana tokens | The dashboard's Grafana card, by anyone who can READ the organization (their own tokens) |
| OpenSearch Dashboards logins | The dashboard's OpenSearch card, by anyone who can READ the whole organization (their own login) |
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

A second server can work against a broker it does not own — a laptop developing against production's
live data — by holding the same `user_secret` and setting `broker_managed_elsewhere: true` in
`config.d/secrets.yaml`. It then derives the credentials the owning server already created, and
never tries to create any: enrolling a node, resetting one and rebuilding the broker state all
refuse. Holding that secret is what grants this, and it is not in git, so a checkout of the server
reaches no live data by itself.

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
prove it holds the current password. One whose filesystem was erased cannot, and needs a human.

The secrets are a **list** per organization, managed from the dashboard's Nodes card by an admin:
adding one leaves the others working, so nodes already flashed are unaffected, and rotation is add,
reflash at leisure, withdraw. A leaked secret is withdrawn without reflashing anything. Rate limited
per organization and per node id.

### A node's state, and stopping one

Each node the organization knows about has one state, on the dashboard's Nodes card:

| State | Means |
| --- | --- |
| Enrolled | It has its own credential |
| Failed | It asked and was refused — which is how an admin learns it exists at all |
| Approved | Its next request is accepted whatever secret it presents, and without proving a password. Consumed on use |
| Denied | Its broker account is deleted and enrolment is refused |

**Approved** is the way back for a node nobody can reach: its secret was withdrawn, or it was
flashed with none, or its filesystem was erased so it can prove nothing. The admin's decision is the
authorisation — a node cannot approve itself — and it admits one node once.

A node with no credential asks again every half hour, from its main loop rather than only at
startup, so an approval takes effect without anyone visiting the node. That matters as much as the
approval itself: asking once per boot stranded exactly these nodes, and a node in a field cannot be
restarted.

**Denied** is the kill switch, for a node publishing bad readings. It works at the broker, not on the
node: the node still holds its credential, is refused, discards it, asks to enrol and is refused
again by the stored decision. Two limits: a node behind a LoRa gateway is republished under the
*gateway's* account, so denying it does not stop its readings arriving; and the state is keyed on
(organization, node id), never on the project a node claims, so a denied node cannot return under
another project name.

The list of nodes that asked and failed is untrusted — anyone can make an id appear by attempting
enrolment — so each row shows when it asked and from what address. It is kept in memory and bounded;
a node still retrying reappears after a restart. Approvals and denials are stored, because a restart
must not un-deny a node.

### A bridged Pi, sharing production's people

A bridge relays topics, not accounts, so a person who logs into production has no account on the
Pi's broker — and the Pi is what goes on working when the link is down. So the Pi **pulls**
`GET /replica/:org` from production, on a timer and at startup, authenticated by a token issued at
pairing (`frugal-iot-addbridge-prod`, then `frugal-iot-addbridge-pi`).

What travels is logins, their stored password hashes and salts, and that organization's permission
rows. No secret is shared and nothing derived from a password moves: the Pi checks logins against
the replicated hash itself and derives its own broker credentials from its own `user_secret`, so the
two brokers issue different passwords for the same person and neither could compute the other's.

Each pull **replaces** that organization's replicated rows, so a permission that stops being sent
stops existing. Replicated users take local id `1000 +` their production id, keeping them clear of
locally created ones; a login whose name a **local** account already uses is refused and reported
rather than overwritten. A feed carrying permissions for another organization is rejected whole. The
last replica persists, so people can still log in while production is unreachable.

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

### Reading history from Grafana

`GET /grafana/<org>/{health,topics,data}` serves an organization's readings to Grafana, authenticated by a bearer token. Shown once, stored as SHA-256.

* **Scope.** One organization, read-only. Tokens with wrong organization
refused same as unknown to prevent fishing for orgs.
* **A token acts as the user who made it.** `grafana_tokens.user_id` records who, and each request checks current permissions for READ on the org & projects. Topic lists filtered. 
* **Who may issue them.**  Tokens issued and revokable by anyone with READ perms on org on admin/Grafana card. Org admin can list & revoke everyone's.
refused, as for forwarders. Max 10 tokens per user per org. The reply that carries a token is marked `no-store`.
* **Revocation** is immediate, per token. Making a token with an existing name replaces it. There is no
  expiry: revoke one that is no longer wanted. `last_used` (rewritten at most hourly, to spare the SD
  card) shows which are idle.
* **The topic** comes from the URL, so it is held to five plain levels of `[A-Za-z0-9_.+-]`, the first
  being the token's own organization, with no `.` or `..`, before it is anywhere near a path.
* **Load.** A token can ask for any range, so history is averaged as it is read and never held whole. Max 2 simultaneous reads per org & 4 total. Topic list cached for a minute.
* **Transport.** The token travels in a header, over HTTPS in production. Anyone holding it can read that
  organization, so treat it as a password; the data source file the dashboard offers contains it.

### Forwarders

An organization ADMIN can make this server send that organization's logged 
readings to an OpenSearch server or a Google Sheet. 
Server connects, so URLs restricted.

* Only the settings a type lists are accepted; anything else is refused. Nothing that names
  a file on this machine (a CA certificate, a Firebase service account) can be set from the dashboard,
  nor the index prefix, which would let one organization write into another's index. Those stay in YAML,
  which only whoever runs the server can edit.
* **Where it may connect** is judged by what an address is, not how it is written (`lib/destinations.js`):
  private, link-local (where cloud metadata lives), shared, reserved and multicast addresses are
  refused - including IPv4 hidden inside IPv6 and numeric spellings - and so is a name that resolves to
  one of them, or to any mix that includes one. **Nothing on this machine may be used from the dashboard,
  for any type**: this server's own OpenSearch is the separate "OpenSearch on this server" type, whose
  address and credentials come from `config.d/opensearch.yaml` (never from a request, never sent to a
  browser), so an administrator cannot aim the server at another service on its own machine. A URL may not
  carry a login. This is checked when a forwarder is saved; a name that later resolves elsewhere (DNS rebinding)
  is not caught, and replies are never shown to the browser, which limits what a stray connection can
  reveal. It limits what an administrator can reach and probe; the machine's own firewall is still what
  keeps the server away from a private network.
* **A Google Sheets request never follows a redirect**, and its address - a credential - is kept out of
  the logs, which name only the host.
* There is no "do not check the certificate" for another server's OpenSearch, which must be https: turning
  it off across the internet defeats the point of TLS. (The operator's `insecure` in
  `config.d/opensearch.yaml` is for this machine's own demo certificate, and is theirs alone to set.)
* Secrets (an OpenSearch password or key, the Google Sheets web app URL, which is a credential for writing
  to the sheet) are never sent back to a browser - a forwarder is listed with which are set, and a blank
  on edit keeps the old value. They are stored in the clear in `frugal-iot.db`, as they were in YAML.
* An organization is limited to ten forwarders, each to 100 topic patterns (every logged message is
  matched against every pattern, in the process all organizations share). The limit on forwarders is part
  of the insert, so requests arriving together cannot get past it.
* **Whole-organization ADMIN is required**, not ADMIN for one project: a forwarder sends every project's
  readings. (`can_ADMIN` answers "admin of something in this organization", which a project-scoped
  administrator is.)
* **JSON only.** These routes refuse a form post. The server parses form bodies for every route, and a
  form can be sent from another site with an administrator's session without any permission from this
  server; JSON cannot. The session cookie is `SameSite=Lax` (and `Secure` over HTTPS), so a
  browser does not send it with a form posted from another site.

*Send earlier readings* (`POST /forwarders/:org/backfill`) has the same guards as the rest - JSON only,
whole-organization ADMIN - and sends the organization's own recorded readings to the forwarder's own,
already-checked destination, never to an address in the request. It runs one job at a time per forwarder,
and the request names only a forwarder and a date.

What a forwarder sends is only what the logger logged: not `log: false` topics, duplicates, retained
values or `set/` commands.

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
| Node approvals and denials | `frugal-iot.db`, `node_grants` |
| Bridge tokens (on production) | `frugal-iot.db`, `bridges` |
| Grafana tokens | `frugal-iot.db`, `grafana_tokens` — a SHA-256 only |
| Forwarders (with their passwords and keys) | `frugal-iot.db`, `forwarders` |
| Which production a Pi replicates from | `config.d/replica.yaml`, with the token in `secrets.yaml` |
| Projects | `frugal-iot.db`, `projects` |
| Server secrets | `config.d/secrets.yaml` — never served, generated if absent, never committed |
| Organizations | `config.d/organizations/<org>.yaml` — served to logged-in browsers, except `mqtt_password`, `logger_password` and `forwarders` (with the older `gsheets` and `firebase`), which are credentials |
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

**S10 — OpenSearch for organizations.** Built, **not yet tried on a Linux server** (Homebrew's OpenSearch
has no security plugin). OpenSearch holds every organization's readings in `frugaliot-<org>-<month>`
indices; what keeps one organization from another's is OpenSearch's own role system, not this server:

* Each person who can read the whole organization makes their own login on the dashboard's OpenSearch card
  (`lib/opensearch-access.js`): user `frugaliot_<org>_<username>`, so one person has a separate login per
  organization and people can be removed one at a time. The server, using the account in
  `config.d/opensearch.yaml` (`admin:`), makes the user and the organization's shared role through
  OpenSearch's security API; the user is tied to the role by a backend role, so adding or removing a person
  never rewrites a list another request is changing. The role may **read** `frugaliot-<org>-*` and
  do anything to `.kibana_<org>` and `.kibana_<org>_*` (the organization's own saved-dashboards index, which
  `opensearchDashboards.index` points Dashboards at), and nothing else; it is not granted `.kibana`, any
  other organization's indices, or any cluster-wide management. It also has three read-only checks
  Dashboards will not start without, found by running it: node info, cluster state and looking up
  aliases. The last two let the login see the *names* of other organizations' indices and aliases
  (so it can tell they exist), not their contents. The password is 24 random bytes, shown once.
* Only an organization id of lower-case letters and digits is accepted. That is what keeps the patterns
  exact: with `-` or `_` allowed, `frugaliot-dev-*` would match `dev-x`'s indices.
* Needs READ for the **whole** organization (not one project): the role is not limited to a project, so a
  project-scoped reader is refused and pointed at Grafana, whose tokens do follow project permissions. A
  person manages their own login; an administrator of the whole organization lists and removes anyone's.
  JSON only (a form post is refused). The username must be letters, digits, `.` `_` `-`, so it cannot
  alter the OpenSearch name it becomes.
* **OpenSearch does not follow this server's permissions afterwards.** A login stays until it is removed,
  so someone whose READ is withdrawn keeps reading the organization through Dashboards until an
  administrator removes it (the card lists them). Doing that automatically is not built.
* **Transport.** The login and the readings cross the internet, so they must be HTTPS: Apache terminates
  TLS in front of OpenSearch (INSTALL-OPENSEARCH.md section 3), OpenSearch stays on loopback, and Apache
  refuses `/_plugins/_security/api` so that nobody outside can manage logins. The server's own calls go to
  OpenSearch directly on the machine.
* The `admin` account is now reachable from the internet through Apache by whoever guesses its password.
  Use a long one; rate-limit failures in front of it.
* `config.d/opensearch.yaml` (an account that can change security) is never sent to a browser - it is in
  the list of sections withheld from `/config.json`, with a test.
* A forwarder to **another server's** OpenSearch (an organization's own, elsewhere) is the organization's
  own deliberate choice: what it receives is outside this system's control. It must be https on a public
  address, as above.
* Still to do: removing a login when its owner loses READ; a write-only role for the forwarder in place of `admin`; limiting a login to one project.

**S9 — optional.**

* TLS to the broker for ESP32-class nodes. Small change in the firmware, but it holds ~32 KB of heap
  unless the mbedTLS buffers are tuned. ESP8266 stays on 1883.
* A password on the node's SoftAP, and `ON_AP_FILTER` on its `POST /restart`.
* A version in client asset URLs, so they can be cached for a year and still appear the instant a
  release changes them.

Not fixed by either, and structural: **a node's flash is readable**, so anyone holding a node
has that node's credential. Per-node accounts limit the damage to that one node; nothing prevents
the extraction.

---

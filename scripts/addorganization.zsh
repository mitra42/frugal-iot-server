#!/usr/bin/env zsh
#
# Add a new organization to Frugal IoT: config file, OTA directory, permissions, optionally its
# administrator's login, and its roles and groups on the broker.
# Run from the server's own directory, the one holding frugal-iot.db (all paths below are relative
# to there) - prepare it first with "npx --no frugal-iot-init".
#
# There is no organization password. Every actor on the broker has its own account (SECURITY.md), and
# the shared "<org>" account that nodes and browsers once used was retired by S8.
#
# Three forms, differing in who can administer the organization besides the superuser:
#   - a new login named after the organization (five arguments)
#   - an existing login (three)
#   - nobody yet (two) - so the server side can be set up before going onsite, and the administrator
#     given permissions on the dashboard's People card once they have registered
#
# Usage:
#   npx --no frugal-iot-addorganization <org-id> <org-name> <email> <phone> <login-password>
#   npx --no frugal-iot-addorganization <org-id> <org-name> <existing-login>
#   npx --no frugal-iot-addorganization <org-id> <org-name>
#   scripts/addorganization.zsh ... (the same)
# Example:
#   npx --no frugal-iot-addorganization abc "Clever People" foo@abc.org +61123456 "secret!123"

set -euo pipefail

SCRIPT_NAME=$0

usage() {
  echo "Usage: ${SCRIPT_NAME} <org-id> <org-name> <email> <phone> <login-password>   # new login named <org-id>" >&2
  echo "   or: ${SCRIPT_NAME} <org-id> <org-name> <existing-login>                   # that login administers it" >&2
  echo "   or: ${SCRIPT_NAME} <org-id> <org-name>                                    # only the superuser, for now" >&2
  echo "Example: ${SCRIPT_NAME} abc \"Clever People\" foo@abc.org +61123456 \"secret!123\"" >&2
  exit 1
}

ORG_ID=${1-}
ORG_NAME=${2-}
EXISTING_LOGIN=""
case $# in
  5) EMAIL=$3; PHONE=$4; PASSWORD=$5 ;;
  3) EXISTING_LOGIN=$3 ;;
  2) ;;
  *) usage ;;
esac

# Run from a server's own directory - the one holding its database and configuration. That is where
# npm install was run, or the top level of a git clone. The database being there is what identifies it.

DB="./frugal-iot.db"
CONFIG_FILE="config.d/organizations/${ORG_ID}.yaml"

# ---- Validate parameters ----
if [[ ! "$ORG_ID" =~ ^[a-z0-9]{1,10}$ ]]; then
  echo "Error: org id must be 1-10 lower-case letters/digits (a-z, 0-9), got '${ORG_ID}'" >&2
  exit 1
fi

if [[ -e "$CONFIG_FILE" ]]; then
  echo "Error: organization already registered - ${CONFIG_FILE} already exists" >&2
  exit 1
fi

if [[ $# -eq 5 ]]; then
  if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    echo "Error: '${EMAIL}' does not look like an email address" >&2
    exit 1
  fi

  if [[ ! "$PHONE" =~ ^[+][0-9]+$ ]]; then
    echo "Error: phone must start with + followed by digits only, got '${PHONE}'" >&2
    exit 1
  fi

  if [[ -z "$PASSWORD" ]]; then
    echo "Error: login password must not be empty" >&2
    exit 1
  fi
fi

if [[ ! -f "$DB" ]]; then
  echo "Error: database ${DB} not found in this directory - prepare the directory first with:" >&2
  echo "  npx --no frugal-iot-init" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null; then
  echo "Error: sqlite3 command not found" >&2
  exit 1
fi

# ---- Escaping helpers ----
# Escape a value for embedding in a double-quoted YAML string
yaml_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  print -r -- "$s"
}
# Escape a value for embedding in a single-quoted SQL string literal. Not "${1//\'/...}": inside
# double quotes \' is a backslash and a quote, so that doubled nothing and O'Neil broke the statement.
sql_escape() {
  local s=${1//\'/\'\'}
  print -r -- "$s"
}

# Check the login now rather than when creating or granting it further down: by then the configuration
# file exists, and a re-run with the right login would refuse because the organization is "already registered".
if [[ $# -eq 5 ]]; then
  if [[ -n "$(sqlite3 "$DB" "SELECT id FROM users WHERE username = '${ORG_ID}';")" ]]; then
    echo "Error: a login '${ORG_ID}' already exists - to make it this organization's administrator use:" >&2
    echo "  ${SCRIPT_NAME} ${ORG_ID} \"<org-name>\" ${ORG_ID}" >&2
    exit 1
  fi
elif [[ $# -eq 3 ]]; then
  EXISTING_LOGIN_SQL=$(sql_escape "$EXISTING_LOGIN")
  EXISTING_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE username = '${EXISTING_LOGIN_SQL}';")
  if [[ -z "$EXISTING_ID" || "$EXISTING_ID" == "0" ]]; then
    echo "Error: no login '${EXISTING_LOGIN}' in ${DB}. Existing logins:" >&2
    sqlite3 "$DB" "SELECT '  ' || username FROM users WHERE id > 0 ORDER BY id;" >&2
    exit 1
  fi
fi

mkdir -p "${CONFIG_FILE:h}" "ota"

# ---- 1. Write config.d/organizations/<org>.yaml ----
ORG_NAME_YAML=$(yaml_escape "$ORG_NAME")
cat > "$CONFIG_FILE" <<EOF
# Configuration for FrugalIoT server for organization=${ORG_ID}
name: "${ORG_NAME_YAML}"
projects: {}
EOF
echo "Wrote ${CONFIG_FILE}"

# ---- 2. Create the OTA directory for this organization ----
OTA_DIR="ota/${ORG_ID}"
mkdir -p "$OTA_DIR"
echo "Ensured ${OTA_DIR} exists"

# ---- 3. Insert the permissions every organization has ----
# id 0 is "everyone" and id 1 is this server's superuser - both seeded by frugal-iot-createdb.sql.
# OR IGNORE because permissions has a UNIQUE(id, capability, org) constraint, so a repeat of any of
# these rows would otherwise abort the whole statement part-way through, leaving the organization with
# only some of its permissions.
#
# WRITE is deliberately NOT given to id 0 "everyone": that row would hand write access to every account
# on the server, including a self-registered one, which is what can_WRITE exists to prevent.
sqlite3 "$DB" "
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (0, 'READ', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (1, 'ADMIN', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (1, 'READ', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (1, 'WRITE', '${ORG_ID}');
"
echo "Added permissions for organization ${ORG_ID}"

# ---- 4. Its administrator, if there is one yet ----
# In the five-argument form the login is created, named after the organization; in the three-argument
# form it already exists.
ADMIN_ID=""
if [[ $# -eq 5 ]]; then
  # Generate salt + hashed password the same way frugal-iot-server.js's /register does
  lines=("${(f)$(ADDORG_PASSWORD="$PASSWORD" node <<'NODE_EOF'
const crypto = require('crypto');
const password = process.env.ADDORG_PASSWORD;
crypto.randomBytes(16, (err, salt) => {
  if (err) { console.error(err); process.exit(1); }
  crypto.pbkdf2(password, salt, 310000, 32, 'sha256', (err, hashedPassword) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(salt.toString('hex'));
    console.log(hashedPassword.toString('hex'));
  });
});
NODE_EOF
)}")
  SALT_HEX=${lines[1]}
  HASH_HEX=${lines[2]}
  if [[ -z "$SALT_HEX" || -z "$HASH_HEX" ]]; then
    echo "Error: failed to generate salt/hashed password" >&2
    exit 1
  fi

  # Insert into users table (username = org id; organization/name = org name)
  ORG_NAME_SQL=$(sql_escape "$ORG_NAME")
  EMAIL_SQL=$(sql_escape "$EMAIL")
  ADMIN_ID=$(sqlite3 "$DB" "
INSERT INTO users (username, hashed_password, salt, organization, name, email, phone)
VALUES ('${ORG_ID}', X'${HASH_HEX}', X'${SALT_HEX}', '${ORG_NAME_SQL}', '${ORG_NAME_SQL}', '${EMAIL_SQL}', '${PHONE}');
SELECT last_insert_rowid();
")
  if [[ ! "$ADMIN_ID" =~ ^[0-9]+$ ]]; then
    echo "Error: failed to create user for organization ${ORG_ID}" >&2
    exit 1
  fi
  echo "Created user '${ORG_ID}' (id=${ADMIN_ID})"
elif [[ $# -eq 3 ]]; then
  ADMIN_ID=$EXISTING_ID
fi

if [[ -n "$ADMIN_ID" ]]; then
  sqlite3 "$DB" "
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (${ADMIN_ID}, 'ADMIN', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (${ADMIN_ID}, 'READ', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (${ADMIN_ID}, 'WRITE', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (${ADMIN_ID}, 'OTAUPDATE', '${ORG_ID}');
"
  echo "Made user id ${ADMIN_ID} an administrator of organization ${ORG_ID}"
fi

# ---- 5. The organization's roles and groups on the broker ----
# Nothing else creates them - not the server at startup - and without them the server cannot create
# this organization's logger account, so nothing published in it would be recorded. Rebuilding from
# the database is idempotent, so doing all of it rather than just this organization costs nothing.
REBUILT=1
echo "Creating the broker's roles and groups for ${ORG_ID} ..."
node "${0:A:h}/rebuild-dynsec.js" || REBUILT=0

echo
echo "Organization '${ORG_ID}' added. The server reads organizations only at startup, so now run:"
echo "  sudo systemctl restart frugaliot      (on OpenWrt: /etc/init.d/frugaliot restart)"
if (( ! REBUILT )); then
  echo "But first make the broker match the database - that failed above, and until it is done nothing"
  echo "in ${ORG_ID} is recorded. Once the broker is reachable:"
  echo "  npx --no frugal-iot-rebuild-dynsec"
fi
if [[ $# -eq 2 ]]; then
  echo "Only the superuser can administer it so far. Once its administrator has registered, log in as"
  echo "superuser and give them ADMIN, READ, WRITE and OTAUPDATE on ${ORG_ID} in the dashboard's People card."
fi

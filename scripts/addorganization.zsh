#!/usr/bin/env zsh
#
# Add a new organization to Frugal IoT: config file, user account, permissions, and mqtt credentials.
# Run from the server's own directory, the one holding frugal-iot.db (all paths below are relative
# to there) - prepare it first with "npx frugal-iot-init".
#
# Usage:
#   npx frugal-iot-addorganization <org-id> <org-name> <email> <phone> <password>
#   scripts/addorganization.zsh <org-id> <org-name> <email> <phone> <password>
# Example:
#   npx frugal-iot-addorganization abc "Clever People" foo@abc.org +61123456 "secret!123"

set -euo pipefail

SCRIPT_NAME=$0

usage() {
  echo "Usage: ${SCRIPT_NAME} <org-id> <org-name> <email> <phone> <password>" >&2
  echo "Example: ${SCRIPT_NAME} abc \"Clever People\" foo@abc.org +61123456 \"secret!123\"" >&2
  exit 1
}

if [[ $# -ne 5 ]]; then
  usage
fi

ORG_ID=$1
ORG_NAME=$2
EMAIL=$3
PHONE=$4
PASSWORD=$5

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

if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Error: '${EMAIL}' does not look like an email address" >&2
  exit 1
fi

if [[ ! "$PHONE" =~ ^[+][0-9]+$ ]]; then
  echo "Error: phone must start with + followed by digits only, got '${PHONE}'" >&2
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "Error: database ${DB} not found in this directory - prepare the directory first with:" >&2
  echo "  npx frugal-iot-init" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null; then
  echo "Error: sqlite3 command not found" >&2
  exit 1
fi

mkdir -p "${CONFIG_FILE:h}" "ota"

MOSQUITTO_PASSWD_MISSING=0
if ! command -v mosquitto_passwd >/dev/null; then
  MOSQUITTO_PASSWD_MISSING=1
fi

# Prefer the real system password file; if it's not present (e.g. mosquitto isn't installed on this
# machine), fall back to editing the local copy under extras/ so the script still does something useful.
MOSQUITTO_PASSWD_FILE="/etc/mosquitto/mosquitto_passwords"
USED_LOCAL_MOSQUITTO_FILE=0
if [[ ! -e "$MOSQUITTO_PASSWD_FILE" && -e "extras/mosquitto_passwords" ]]; then
  MOSQUITTO_PASSWD_FILE="extras/mosquitto_passwords"
  USED_LOCAL_MOSQUITTO_FILE=1
fi

# ---- Escaping helpers ----
# Escape a value for embedding in a double-quoted YAML string
yaml_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  print -r -- "$s"
}
# Escape a value for embedding in a single-quoted SQL string literal
sql_escape() {
  print -r -- "${1//\'/\'\'}"
}

# ---- 1. Write config.d/organizations/<org>.yaml ----
ORG_NAME_YAML=$(yaml_escape "$ORG_NAME")
PASSWORD_YAML=$(yaml_escape "$PASSWORD")
cat > "$CONFIG_FILE" <<EOF
# Configuration for FrugalIoT server for organization=${ORG_ID}
mqtt_password: "${PASSWORD_YAML}"
name: "${ORG_NAME_YAML}"
projects: {}
EOF
echo "Wrote ${CONFIG_FILE}"

# ---- 2. Create the OTA directory for this organization ----
OTA_DIR="ota/${ORG_ID}"
mkdir -p "$OTA_DIR"
echo "Ensured ${OTA_DIR} exists"

# ---- 3. Generate salt + hashed password the same way frugal-iot-server.js's /register does ----
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

# ---- 4. Insert into users table (username = org id; organization/name = org name) ----
ORG_NAME_SQL=$(sql_escape "$ORG_NAME")
EMAIL_SQL=$(sql_escape "$EMAIL")
NEW_ID=$(sqlite3 "$DB" "
INSERT INTO users (username, hashed_password, salt, organization, name, email, phone)
VALUES ('${ORG_ID}', X'${HASH_HEX}', X'${SALT_HEX}', '${ORG_NAME_SQL}', '${ORG_NAME_SQL}', '${EMAIL_SQL}', '${PHONE}');
SELECT last_insert_rowid();
")
if [[ ! "$NEW_ID" =~ ^[0-9]+$ ]]; then
  echo "Error: failed to create user for organization ${ORG_ID}" >&2
  exit 1
fi
echo "Created user '${ORG_ID}' (id=${NEW_ID})"

# ---- 5. Insert permissions ----
# id 0 is "everyone" and id 1 is this server's superuser - both seeded by frugal-iot-createdb.sql.
# OR IGNORE because permissions has a UNIQUE(id, capability, org) constraint, so a repeat of any of
# these rows (e.g. on a database where id 1 is also the org's own account) would otherwise abort
# the whole statement part-way through, leaving the organization with only some of its permissions.
sqlite3 "$DB" "
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (${NEW_ID}, 'ADMIN', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (${NEW_ID}, 'READ', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (0, 'READ', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (1, 'ADMIN', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (1, 'READ', '${ORG_ID}');
INSERT OR IGNORE INTO permissions (id, capability, org) VALUES (${NEW_ID}, 'OTAUPDATE', '${ORG_ID}');
"
echo "Added permissions for organization ${ORG_ID}"

# ---- 6. Set the MQTT broker password for this organization ----
MOSQUITTO_PASSWD_FAILED=0
MOSQUITTO_PASSWD_ERROR=""
if [[ "$MOSQUITTO_PASSWD_MISSING" -eq 1 ]]; then
  echo "Warning: mosquitto_passwd command not found - skipped setting MQTT broker password" >&2
else
  # Capture stderr without letting `set -e` abort the whole script on failure - the org's config file
  # and DB rows are already written by this point, so a failure here should be reported, not fatal.
  MOSQUITTO_PASSWD_ERROR=$(mosquitto_passwd -b "$MOSQUITTO_PASSWD_FILE" "${ORG_ID}" "${PASSWORD}" 2>&1 >/dev/null) || MOSQUITTO_PASSWD_FAILED=1
  if [[ "$MOSQUITTO_PASSWD_FAILED" -eq 1 ]]; then
    echo "Warning: mosquitto_passwd failed to set the MQTT broker password:" >&2
    echo "  ${MOSQUITTO_PASSWD_ERROR}" >&2
    if [[ "$MOSQUITTO_PASSWD_ERROR" == *"Permission denied"* || ! -w "$MOSQUITTO_PASSWD_FILE" ]]; then
      echo "This looks like a permissions problem - re-run that command with sudo:" >&2
      echo "  sudo mosquitto_passwd -b \"${MOSQUITTO_PASSWD_FILE}\" \"${ORG_ID}\" \"${PASSWORD}\"" >&2
    fi
  else
    echo "Set mosquitto password for ${ORG_ID} in ${MOSQUITTO_PASSWD_FILE}"
  fi
fi

echo
echo "Organization '${ORG_ID}' added successfully. Now run:"
echo "  service mosquitto restart"
echo "  service frugaliot restart"
if [[ "$MOSQUITTO_PASSWD_MISSING" -eq 1 ]]; then
  echo "NOTE: mosquitto_passwd was not found, so the MQTT broker password was NOT set - run it manually:"
  echo "  mosquitto_passwd -b /etc/mosquitto/mosquitto_passwords ${ORG_ID} <password>"
elif [[ "$MOSQUITTO_PASSWD_FAILED" -eq 1 ]]; then
  echo "NOTE: mosquitto_passwd failed (see warning above), so the MQTT broker password was NOT set."
  echo "  If it was a permissions problem, run it manually with sudo:"
  echo "  sudo mosquitto_passwd -b \"${MOSQUITTO_PASSWD_FILE}\" ${ORG_ID} <password>"
elif [[ "$USED_LOCAL_MOSQUITTO_FILE" -eq 1 ]]; then
  echo "NOTE: /etc/mosquitto/mosquitto_passwords was not found, so the local extras/mosquitto_passwords was updated instead."
fi

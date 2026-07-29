#!/usr/bin/env zsh
#
# Set (or reset) the password of an existing Frugal IoT user account.
# Run from the top level of the frugal-iot-server repo (all paths below are relative to there).
#
# Typically used on a new installation to give the seeded 'superuser' account a password,
# since frugal-iot-createdb.sql seeds it without one:
#   scripts/setpassword.zsh superuser "secret!123"
#
# Usage:
#   scripts/setpassword.zsh <username> <password>

set -euo pipefail

SCRIPT_NAME=$0

usage() {
  echo "Usage: ${SCRIPT_NAME} <username> <password>" >&2
  echo "Example: ${SCRIPT_NAME} superuser \"secret!123\"" >&2
  exit 1
}

if [[ $# -ne 2 ]]; then
  usage
fi

ACCOUNT=$1
PASSWORD=$2

# Must be run from the repo root
if [[ ! -f frugal-iot-server.js || ! -d config.d ]]; then
  echo "Error: must be run from the top level of the frugal-iot-server repo" >&2
  exit 1
fi

DB="./frugal-iot.db"

if [[ -z "$PASSWORD" ]]; then
  echo "Error: password must not be empty" >&2
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "Error: database ${DB} not found - create it with:" >&2
  echo "  sqlite3 ${DB} < frugal-iot-createdb.sql" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null; then
  echo "Error: sqlite3 command not found" >&2
  exit 1
fi

# ---- Escaping helper ----
# Escape a value for embedding in a single-quoted SQL string literal
sql_escape() {
  print -r -- "${1//\'/\'\'}"
}

ACCOUNT_SQL=$(sql_escape "$ACCOUNT")

# ---- Check the account exists (this sets a password, it does not create accounts) ----
USER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE username = '${ACCOUNT_SQL}';")
if [[ -z "$USER_ID" ]]; then
  echo "Error: no user '${ACCOUNT}' in ${DB}" >&2
  echo "Existing usernames:" >&2
  sqlite3 "$DB" "SELECT '  ' || username FROM users ORDER BY id;" >&2
  exit 1
fi

# ---- Generate salt + hashed password the same way frugal-iot-server.js's /register does ----
lines=("${(f)$(SETPW_PASSWORD="$PASSWORD" node <<'NODE_EOF'
const crypto = require('crypto');
const password = process.env.SETPW_PASSWORD;
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

# ---- Store it ----
sqlite3 "$DB" "
UPDATE users SET hashed_password = X'${HASH_HEX}', salt = X'${SALT_HEX}'
WHERE id = ${USER_ID};
"

echo "Set password for '${ACCOUNT}' (id=${USER_ID})"
echo "Restart the server for it to be picked up if the account is already logged in somewhere:"
echo "  service frugaliot restart"

#!/usr/bin/env zsh
#
# Authorize a Raspberry Pi to bridge into this server. RUN THIS ON THE PRODUCTION SERVER.
#
# A bridge relays a Pi's readings to this server, so the same nodes appear on a dashboard here and
# can be controlled from here, while the Pi carries on working on its own when the link is down.
# This end of it is one broker account and one access-control rule. The Pi end is a configuration
# file, written by the companion script - "frugal-iot-addbridge-pi", run on the Pi.
#
# Each Pi gets its own account rather than sharing the organization's, for two reasons: the
# organization's broker password is handed to every browser that logs in, so it is not a secret;
# and a per-Pi account can be confined to one site's topics and revoked without disturbing anyone.
#
# Run from the server's own directory, the one holding frugal-iot.db.
#
# Usage:
#   npx --no frugal-iot-addbridge-prod <org-id> <site-name> [password]
#   scripts/addbridge-prod.zsh <org-id> <site-name> [password]
# Example:
#   npx --no frugal-iot-addbridge-prod myfarm northfield
#
# The site name only distinguishes one Pi from another within an organization, and becomes part of
# the account name ("bridge-northfield"). With no password given, a strong one is generated and
# printed - it is needed once, to type into the Pi.
#
# This assumes the server has already been set up to accept bridges at all: a TLS listener on 8883
# with a certificate. That is a one-off, and INSTALLATION.md step 11 covers it.

set -euo pipefail

SCRIPT_NAME=$0

usage() {
  echo "Usage: ${SCRIPT_NAME} <org-id> <site-name> [password]" >&2
  echo "Example: ${SCRIPT_NAME} myfarm northfield" >&2
  exit 1
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
fi

ORG_ID=$1
SITE=$2
PASSWORD=${3:-}

if [[ ! "$ORG_ID" =~ ^[a-z0-9]{1,10}$ ]]; then
  echo "Error: org id must be 1-10 lower-case letters/digits, got '${ORG_ID}'" >&2
  exit 1
fi
# The site name ends up in an account name and in an ACL file, so keep it to something that cannot
# be mistaken for syntax in either
if [[ ! "$SITE" =~ ^[a-z0-9-]{1,20}$ ]]; then
  echo "Error: site name must be 1-20 lower-case letters, digits or hyphens, got '${SITE}'" >&2
  exit 1
fi

ACCOUNT="bridge-${SITE}"
CONFIG_FILE="config.d/organizations/${ORG_ID}.yaml"

# The organization has to exist here, or the readings will arrive and nothing will record them:
# this server's logger subscribes per organization, driven by these files.
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: no ${CONFIG_FILE} - organization '${ORG_ID}' is not configured on this server." >&2
  echo "Its readings would arrive at the broker and nothing would record them. Add it first:" >&2
  echo "  npx --no frugal-iot-addorganization ${ORG_ID} \"<name>\" <email> <phone> \"<password>\"" >&2
  exit 1
fi

if ! command -v mosquitto_passwd >/dev/null; then
  echo "Error: mosquitto_passwd not found - is mosquitto installed on this machine?" >&2
  exit 1
fi

# Which files the running broker actually uses, rather than where they usually are. Only ".conf"
# files in conf.d are read, and the last setting wins.
MOSQ_CONFS=(/etc/mosquitto/mosquitto.conf(N) /etc/mosquitto/conf.d/*.conf(N))
if (( ${#MOSQ_CONFS} == 0 )); then
  echo "Error: no mosquitto configuration found in /etc/mosquitto" >&2
  exit 1
fi
# Read one setting out of the broker's configuration. Two things to be careful of: a conf.d file
# can be root-only (a bridge configuration holds a password, so it should be), which makes grep
# fail rather than return nothing - and under "set -e" a failing command substitution would end
# this script silently, before it had printed anything at all. Hence "|| true" and the sudo retry.
mosq_setting() {
  local out
  out=$(grep -hE "^[[:space:]]*$1[[:space:]]" "${MOSQ_CONFS[@]}" 2>/dev/null | tail -1 | awk '{print $2}') || true
  if [[ -z "$out" ]] && command -v sudo >/dev/null; then
    out=$(sudo grep -hE "^[[:space:]]*$1[[:space:]]" "${MOSQ_CONFS[@]}" 2>/dev/null | tail -1 | awk '{print $2}') || true
  fi
  print -r -- "$out"
}
PWFILE=$(mosq_setting password_file)
ACLFILE=$(mosq_setting acl_file)

if [[ -z "$PWFILE" ]]; then
  echo "Error: no password_file in the mosquitto configuration - this broker is not using accounts." >&2
  exit 1
fi
if [[ ! -e "$PWFILE" ]]; then
  echo "Error: mosquitto names ${PWFILE} as its password file but it does not exist." >&2
  exit 1
fi

# The account names in the password file. Needs the same sudo retry as the settings above: the
# password file is normally mode 600 owned by the broker's own user, so reading it as anyone else
# silently returns nothing - which would look exactly like "this account does not exist yet".
account_exists() {
  local names
  names=$(cut -d: -f1 "$PWFILE" 2>/dev/null) || true
  if [[ -z "$names" ]] && command -v sudo >/dev/null; then
    names=$(sudo cut -d: -f1 "$PWFILE" 2>/dev/null) || true
  fi
  print -r -- "$names" | grep -qx "$1"
}

# Refuse to rotate the password of a bridge that is presumably working: the Pi holds the old one,
# and it would stop relaying the moment this changed without anyone touching the Pi.
if account_exists "$ACCOUNT"; then
  echo "Error: account '${ACCOUNT}' already exists in ${PWFILE}." >&2
  echo "If a Pi is already using it, leave it alone. To give it a new password, run" >&2
  echo "mosquitto_passwd as the owner of that file - as root it rewrites the file owned by root," >&2
  echo "and the broker, which reads it as the mosquitto user, then will not start:" >&2
  echo "  sudo -u \"\$(stat -c '%U' ${PWFILE})\" mosquitto_passwd -b ${PWFILE} ${ACCOUNT} '<new password>'" >&2
  echo "and then update /etc/mosquitto/conf.d/frugal-iot-bridge.conf on that Pi to match." >&2
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  # Unlike the organization's broker password, this one is never given to a browser - it lives only
  # in a root-owned file on the Pi - so it can and should be a real one.
  # The subshell turns pipefail off: head closes the pipe after 24 characters, tr is killed by
  # SIGPIPE, and with pipefail on that failure would end this script before it printed anything.
  # install-pi.sh's randpw does the same for the same reason.
  PASSWORD=$( set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24 )
  GENERATED=true
else
  GENERATED=false
fi

# Run mosquitto_passwd as whoever owns the password file, the same way addorganization.zsh does.
# Running it as root instead rewrites the file owned by root, and mosquitto drops to the mosquitto
# user *before* reading it - so the broker then cannot read its own password file and refuses to
# start, with an error that says nothing about ownership. mosquitto_passwd also writes a temporary
# backup beside the file, so it needs the directory and not only the file.
#
# Whoever runs it must be able to write the DIRECTORY, not merely the file, and the file's owner
# frequently cannot: a password file at /etc/mosquitto/mosquitto_passwords is owned by mosquitto
# inside a directory owned by root, and picking the owner then fails with "Error creating backup
# password file". So the last resort is root - and because that leaves the file owned by root,
# where mosquitto (which drops privileges before reading it) could no longer read it, the
# ownership and mode are put back immediately afterwards.
# stat's spelling differs between Linux (-c) and BSD/macOS (-f)
PWDIR="${PWFILE:h}"
PWFILE_OWNER=$(stat -c '%U' "$PWFILE" 2>/dev/null || stat -f '%Su' "$PWFILE" 2>/dev/null || true)
PWFILE_GROUP=$(stat -c '%G' "$PWFILE" 2>/dev/null || stat -f '%Sg' "$PWFILE" 2>/dev/null || true)
PWFILE_MODE=$(stat -c '%a' "$PWFILE" 2>/dev/null || stat -f '%Lp' "$PWFILE" 2>/dev/null || true)
RESTORE_OWNER=0
MOSQ_PASSWD_CMD=(mosquitto_passwd)
if [[ ! -w "$PWDIR" || ( -e "$PWFILE" && ! -w "$PWFILE" ) ]]; then
  if command -v sudo >/dev/null; then
    if [[ -n "$PWFILE_OWNER" && "$PWFILE_OWNER" != "$(id -un)" && "$PWFILE_OWNER" != "root" ]] \
       && sudo -u "$PWFILE_OWNER" test -w "$PWDIR" 2>/dev/null; then
      MOSQ_PASSWD_CMD=(sudo -u "$PWFILE_OWNER" mosquitto_passwd)
    else
      MOSQ_PASSWD_CMD=(sudo mosquitto_passwd)
      [[ -n "$PWFILE_OWNER" && "$PWFILE_OWNER" != "root" ]] && RESTORE_OWNER=1
    fi
  fi
fi

echo "Creating broker account ${ACCOUNT} in ${PWFILE} ..."
if ! $MOSQ_PASSWD_CMD -b "$PWFILE" "$ACCOUNT" "$PASSWORD"; then
  echo "Error: mosquitto_passwd failed - nothing has been changed." >&2
  exit 1
fi
if (( RESTORE_OWNER )); then
  # Written as root, so hand it back before mosquitto next needs to read it
  sudo chown "${PWFILE_OWNER}:${PWFILE_GROUP}" "$PWFILE"
  [[ -n "$PWFILE_MODE" ]] && sudo chmod "$PWFILE_MODE" "$PWFILE"
  echo "  (written as root, then given back to ${PWFILE_OWNER}:${PWFILE_GROUP} mode ${PWFILE_MODE})"
fi

# The access control rule. Without one the account can connect and reach nothing at all, because a
# mosquitto acl_file is deny-by-default.
if [[ -n "$ACLFILE" ]]; then
  if [[ ! -e "$ACLFILE" ]]; then
    echo "Error: mosquitto names ${ACLFILE} as its ACL file but it does not exist." >&2
    echo "The account has been created but cannot reach anything until that is sorted out." >&2
    exit 1
  fi
  #
  # Two grants, and the second is easy to leave out.
  #
  # A bridge with "notifications true" publishes a retained 1/0 to
  # $SYS/broker/connection/<clientid>/state on the local AND the remote broker, and that is what the
  # dashboard's Bridges card reads. The bridge's LOCAL side is exempt from the ACL, so the Pi always
  # has it; the remote side is not, and on a deny-by-default broker the write is refused silently -
  # so the card said "Unknown" for a bridge that was up and relaying perfectly. Measured on
  # mosquitto 2.0.20: the write is allowed once the ACL says so, so this is an ACL matter and not
  # one of mosquitto refusing $SYS writes outright.
  ACL_ORG_RULE=0; ACL_SYS_RULE=0
  sudo grep -qE "^[[:space:]]*user[[:space:]]+${ACCOUNT}[[:space:]]*$" "$ACLFILE" && ACL_ORG_RULE=1
  sudo grep -qF "topic write \$SYS/broker/connection/${ACCOUNT}/state" "$ACLFILE" && ACL_SYS_RULE=1

  if (( ACL_ORG_RULE && ACL_SYS_RULE )); then
    echo "ACL rules for ${ACCOUNT} are already in ${ACLFILE} - leaving them alone."
  elif (( ACL_ORG_RULE )); then
    # An existing bridge from before the state grant existed. A second "user" stanza for the same
    # account is valid and additive, which is simpler and safer than editing the first one in place.
    echo "Adding the connection-state ACL rule for ${ACCOUNT} to ${ACLFILE} ..."
    sudo tee -a "$ACLFILE" >/dev/null <<EOF

# Lets the bridge report whether it is connected, for the dashboard's Bridges card
user ${ACCOUNT}
topic write \$SYS/broker/connection/${ACCOUNT}/state
EOF
    echo "  Restart the Pi's broker to have it republish that state: it is sent on connect only."
  else
    echo "Adding ACL rules to ${ACLFILE} ..."
    sudo tee -a "$ACLFILE" >/dev/null <<EOF

# Pi bridge for site "${SITE}", confined to its organization's topics
user ${ACCOUNT}
topic readwrite ${ORG_ID}/#
# ... and its own connection state, which the dashboard's Bridges card reads
topic write \$SYS/broker/connection/${ACCOUNT}/state
EOF
  fi
else
  echo ""
  echo "NOTE: this broker has no acl_file, so ${ACCOUNT} can reach every topic on it, not just"
  echo "  ${ORG_ID}/#. That is how the broker already treats every other account, so this is no"
  echo "  worse than what is there - but see INSTALLATION.md step 11 for restricting it."
fi

# password_file and acl_file are both re-read on a reload, so nothing needs to be disconnected.
echo "Reloading mosquitto ..."
sudo systemctl reload mosquitto || {
  echo "Warning: reload failed - the account exists but the broker has not re-read the files." >&2
  echo "  Try: sudo systemctl restart mosquitto" >&2
}

# ---------------------------------------------------------------------------------------------
# A token for the Pi to pull this organization's logins with (SECURITY.md S11).
#
# The bridge relays topics, not accounts, so without this a person who logs in here has no account
# on the Pi's broker - and the Pi is the machine that goes on working when the link is down.
#
# It reads logins, hashes and permissions for THIS organization and nothing else. Nothing derived
# from a password travels: the Pi checks logins against the replicated hash and derives its own
# broker credentials from its own user_secret, so the two brokers issue different passwords for the
# same person.
#
# Done in node rather than sqlite3, because the sqlite3 command-line tool is not installed
# everywhere the server runs - the same reason scripts/clearretained.js talks MQTT through a library.
REPLICA_TOKEN=$(node -e '
const { randomBytes } = require("crypto");
const sqlite3 = require("sqlite3");
const [org, site] = process.argv.slice(1);
const token = randomBytes(32).toString("base64url");
const db = new sqlite3.Database("./frugal-iot.db", (err) => {
  if (err) { console.error(err.message); process.exit(1); }
  db.run(`CREATE TABLE IF NOT EXISTS bridges (org TEXT NOT NULL, site TEXT NOT NULL,
            token TEXT NOT NULL, created_at INTEGER NOT NULL, last_pull INTEGER,
            UNIQUE(org, site))`, () => {
    db.run(`INSERT INTO bridges (org, site, token, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(org, site) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`,
      [org, site, token, Date.now()], (e) => {
        if (e) { console.error(e.message); process.exit(1); }
        process.stdout.write(token);
        db.close();
      });
  });
});
' "$ORG_ID" "$SITE") || true

if [[ -z "$REPLICA_TOKEN" ]]; then
  echo ""
  echo "Note: could not create a replica token, so the Pi will not be able to share this server's"
  echo "logins. The broker bridge above is unaffected. Re-run this script to try again."
fi

echo ""
echo "Done. Collect these, then run the command at the bottom on the Pi."
echo ""
echo "1. THE FQDN OF THIS SERVER - the DNS name on its TLS certificate."
echo "   The Pi verifies the certificate against exactly what you type, so a local hostname, an IP"
echo "   address, or a domain the certificate does not cover will fail to connect."
echo "   TO TEST IT: open https://<name>/ in a browser. Loading with no certificate warning means"
echo "   the name matches the certificate, which is the part that is easy to get wrong. The bridge"
echo "   then uses port 8883 on that same host, so that port has to be open to the Pi as well."
echo "   This host calls itself \"$(hostname -f 2>/dev/null || hostname)\" - use that only if it is"
echo "   also the name on the certificate and one the Pi can resolve. Not guessed here, because"
echo "   what a machine calls itself usually is not its public name."
echo ""
echo "2. THE PASSWORD for ${ACCOUNT}, which the Pi's script will prompt for:"
echo ""
echo "   ${PASSWORD}"
echo ""
if [[ "$GENERATED" == true ]]; then
  echo "That was generated just now and is not stored anywhere you can read it back - copy it before"
  echo "you lose this output. If it does get lost, set a new one with:"
  echo "  sudo -u \"\$(stat -c '%U' ${PWFILE})\" mosquitto_passwd -b ${PWFILE} ${ACCOUNT} '<new password>'"
  echo "and use that on the Pi instead."
fi
if [[ -n "$REPLICA_TOKEN" ]]; then
  echo "3. THE REPLICA TOKEN, so people registered here can log in on the Pi as well:"
  echo ""
  echo "   ${REPLICA_TOKEN}"
  echo ""
  echo "   A new one replaces the old, so re-running this script revokes the Pi's previous token."
  echo ""
fi
echo "Then, on the Pi at site '${SITE}':"
echo ""
if [[ -n "$REPLICA_TOKEN" ]]; then
  echo "  npx --no frugal-iot-addbridge-pi ${ORG_ID} <fqdn-from-1-above> ${ACCOUNT} -- --replica-token <token-from-3>"
else
  echo "  npx --no frugal-iot-addbridge-pi ${ORG_ID} <fqdn-from-1-above> ${ACCOUNT}"
fi
echo ""
echo "The first three are positional on purpose: npm swallows any --flag it does not recognise and"
echo "passes only the value on, so the --org form would arrive at that script as a bare word."

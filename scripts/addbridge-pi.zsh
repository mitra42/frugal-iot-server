#!/usr/bin/env zsh
#
# Bridge this Pi's broker to a production Frugal IoT server. RUN THIS ON THE PI.
#
# After this, the Pi's readings also appear on the production server, and its nodes can be
# controlled from there - while the Pi carries on recording and serving on its own whenever the
# link is down. Readings taken during an outage stay on the Pi: production gets a gap rather than
# a backlog delivered later with the wrong timestamps. INSTALLATION.md step 11 explains why.
#
# The relaying is done by the broker, so the server, the logger and the nodes are untouched.
#
# Run the companion script on the production server first - "frugal-iot-addbridge-prod" - which
# creates the account this needs and tells you the password.
#
# Run from the server's own directory, the one holding frugal-iot.db.
#
# Usage:
#   npx --no frugal-iot-addbridge-pi <org-id> <prod-host> <account>
#   scripts/addbridge-pi.zsh --org myfarm --host prod.example.org --account bridge-northfield
#
# Both forms work. The positional one is the one to use with npx, because npm swallows any --flag
# it does not recognise ("Unknown cli config") and passes only the values through, so
# "npx ... --org myfarm" reaches this script as just "myfarm". Putting "--" before the flags also
# works, but the positional form is harder to get wrong.
#
# The password is asked for rather than passed on the command line, so it does not end up in your
# shell history. Give it with --password only for an unattended run.

set -euo pipefail

SCRIPT_NAME=$0

usage() {
  echo "Usage: ${SCRIPT_NAME} <org-id> <prod-host> <account> [password]" >&2
  echo "   or: ${SCRIPT_NAME} --org <org-id> --host <prod-host> --account <account> [--port N] [--password PW] [--replica-token T] [--replace]" >&2
  echo "Example: ${SCRIPT_NAME} myfarm prod.example.org bridge-northfield" >&2
  echo "" >&2
  echo "Through npx, use the positional form: npm swallows unrecognised --flags and passes only" >&2
  echo "their values on, so '--org myfarm' arrives here as just 'myfarm'." >&2
  exit 1
}

ORG_ID=""; PROD_HOST=""; ACCOUNT=""; PASSWORD=""; PROD_PORT=8883; REPLACE=false; REPLICA_TOKEN=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org)      ORG_ID=${2:-}; shift 2 ;;
    --host)     PROD_HOST=${2:-}; shift 2 ;;
    --account)  ACCOUNT=${2:-}; shift 2 ;;
    --password) PASSWORD=${2:-}; shift 2 ;;
    --replica-token) REPLICA_TOKEN=${2:-}; shift 2 ;;
    --port)     PROD_PORT=${2:-}; shift 2 ;;
    --replace)  REPLACE=true; shift ;;
    -*) echo "Error: unknown option '$1'" >&2; usage ;;
    *)  POSITIONAL+=("$1"); shift ;;
  esac
done

# Fill anything not given as a flag from the positional arguments, in the order the usage line
# shows. This is what makes the npx form work: npm eats "--org" and hands us a bare "myfarm".
# Written as "if" rather than "[[ ... ]] && X=Y", whose false case is a non-zero last command and
# would end the script under "set -e".
# Fill whichever are still empty, in the order the usage line shows them, consuming the
# positionals in turn rather than by fixed position - so a half-and-half command line still lands
# correctly. Done inline, not through a function returning its value: a command substitution runs
# in a subshell, where the counter would advance and then be thrown away, giving every field the
# same first positional.
POS_N=1
for _field in ORG_ID PROD_HOST ACCOUNT PASSWORD; do
  if [[ -z "${(P)_field}" ]] && (( POS_N <= ${#POSITIONAL} )); then
    typeset -g "${_field}"="${POSITIONAL[POS_N]}"
    POS_N=$((POS_N + 1))
  fi
done
unset _field

if [[ -z "$ORG_ID" || -z "$PROD_HOST" || -z "$ACCOUNT" ]]; then usage; fi

BRIDGE_CONF=/etc/mosquitto/conf.d/frugal-iot-bridge.conf

# This Pi has to know the organization too, or its own logger will not be recording what it relays.
if [[ ! -f "config.d/organizations/${ORG_ID}.yaml" ]]; then
  echo "Error: no config.d/organizations/${ORG_ID}.yaml here." >&2
  echo "Run this from the server's own directory, and check the organization id matches the one" >&2
  echo "used on the production server - it is the first element of every topic, so the two ends" >&2
  echo "must agree exactly." >&2
  exit 1
fi

if [[ -e "$BRIDGE_CONF" && "$REPLACE" != true ]]; then
  echo "Error: ${BRIDGE_CONF} already exists - this Pi is already bridged." >&2
  echo "Add --replace to overwrite it, or edit it by hand. Through npx that flag needs a '--'" >&2
  echo "ahead of it - 'npx --no frugal-iot-addbridge-pi -- --org ... --replace' - or npm eats it." >&2
  exit 1
fi

# The example file ships with the server, so look beside this script rather than guessing a path -
# that works both for an npm install and for a git checkout.
EXAMPLE="${SCRIPT_NAME:A:h}/../extras/mosquitto-bridge.conf.example"
if [[ ! -f "$EXAMPLE" ]]; then
  echo "Error: cannot find mosquitto-bridge.conf.example (looked at ${EXAMPLE})" >&2
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  echo -n "Password for ${ACCOUNT} on ${PROD_HOST} (not echoed): "
  read -rs PASSWORD
  echo ""
  if [[ -z "$PASSWORD" ]]; then
    echo "Error: no password given" >&2
    exit 1
  fi
fi

# Check the far end is reachable and its certificate checks out, before writing anything. Getting
# this wrong is the usual reason a bridge silently fails to connect, and the broker's own log is
# the only place it says so.
if command -v openssl >/dev/null; then
  echo "Checking ${PROD_HOST}:${PROD_PORT} ..."
  if echo | openssl s_client -connect "${PROD_HOST}:${PROD_PORT}" -servername "$PROD_HOST" \
       -verify_hostname "$PROD_HOST" -verify_return_error >/dev/null 2>&1; then
    echo "  reachable, and the certificate is valid for that name"
  else
    echo "Warning: could not complete a TLS handshake with ${PROD_HOST}:${PROD_PORT}." >&2
    echo "  Either the port is not open, or the certificate is not valid for that name." >&2
    echo "  Carrying on - the bridge will keep retrying - but it will not connect until that is fixed." >&2
  fi
fi

# Fill in the example. Everything the bridge needs, including why each setting is what it is, is in
# the comments of that file, so it is copied whole rather than reduced to the active lines.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
sed -e "s|<prod-host>:8883|${PROD_HOST}:${PROD_PORT}|" \
    -e "s|<bridge-account>|${ACCOUNT}|g" \
    -e "s|<bridge-password>|${PASSWORD}|" \
    -e "s|<org>/|${ORG_ID}/|g" \
    -e "s|^# Replace <org> in all four lines with the organization id - the first element of every topic, and|# The organization here is \"${ORG_ID}\" - the first element of every topic, and|" \
    "$EXAMPLE" > "$TMP"

if grep -qE '<(prod-host|bridge-account|bridge-password)>' "$TMP"; then
  echo "Error: some placeholders were not filled in - not installing. This is a bug in this script" >&2
  echo "  or in extras/mosquitto-bridge.conf.example." >&2
  exit 1
fi

# Mode 600 because it holds the password. Mosquitto reads its configuration as root, before
# dropping privileges, so it can still read it - unlike the TLS key, which it reads afterwards.
echo "Writing ${BRIDGE_CONF} ..."
sudo install -o root -g root -m 600 "$TMP" "$BRIDGE_CONF"

# A restart, not a reload: mosquitto does not pick up bridges on a reload signal. Every node
# reconnects on its own afterwards.
echo "Restarting mosquitto (nodes will reconnect on their own) ..."
sudo systemctl restart mosquitto
sleep 4

if [[ "$(systemctl is-active mosquitto 2>/dev/null)" != "active" ]]; then
  echo "Error: mosquitto did not come back up. Its own log says why:" >&2
  echo "  sudo tail -20 /var/log/mosquitto/mosquitto.log" >&2
  echo "To undo this: sudo rm ${BRIDGE_CONF} && sudo systemctl restart mosquitto" >&2
  exit 1
fi

# Did it actually connect? The bridge publishes a retained 1 or 0 here whenever that changes, so
# this is the real answer rather than the absence of an error.
STATE=""
if command -v mosquitto_sub >/dev/null; then
  ORG_PW=$(sed -n 's/^mqtt_password:[[:space:]]*//p' "config.d/organizations/${ORG_ID}.yaml" | head -1 | tr -d '"'"'"'') || true
  for attempt in 1 2 3 4 5; do
    # "|| true" because mosquitto_sub always exits non-zero when -W times out, and under "set -e"
    # that ends this script here - silently, after the restart, without ever printing the verdict
    # below. Likewise "if" rather than "&& break", whose false case is a non-zero last command.
    STATE=$(mosquitto_sub -h localhost -u "$ORG_ID" -P "$ORG_PW" \
      -t "\$SYS/broker/connection/${ACCOUNT}/state" -W 3 2>/dev/null | tail -1) || true
    if [[ "$STATE" == "1" ]]; then break; fi
    sleep 3
  done
fi

echo ""
if [[ "$STATE" == "1" ]]; then
  echo "Connected. This Pi is now relaying ${ORG_ID} to ${PROD_HOST}."
elif [[ -z "$STATE" ]]; then
  echo "Installed, but this script could not tell whether it connected."
  echo "Check with:  npx --no frugal-iot-diagnostic"
else
  echo "Installed, but not connected yet (state=${STATE})."
  echo "It keeps retrying, so a wrong password or an unreachable port will show up in the log:"
  echo "  sudo tail -20 /var/log/mosquitto/mosquitto.log"
  echo "and the state is reported by:  npx --no frugal-iot-diagnostic"
fi
# ---------------------------------------------------------------------------------------------
# Sharing production's logins (SECURITY.md S11).
#
# The bridge above relays topics, not accounts, so without this a person registered on production
# has no account on this Pi's broker - and this Pi is what goes on working when the link is down.
# With it, the server pulls their logins and permissions on a timer and issues its OWN broker
# credentials from its own user_secret; nothing derived from a password travels either way.
#
# Optional: a bridge is useful without it, so a missing token is not an error.
if [[ -z "$REPLICA_TOKEN" ]]; then
  echo -n "Replica token from the production server (blank to skip): "
  read -r REPLICA_TOKEN
fi

if [[ -n "$REPLICA_TOKEN" ]]; then
  # https, and deliberately not asked about: the token is a bearer credential, and over http it
  # would be readable by anything between here and production.
  cat > config.d/replica.yaml <<YAML
# Which production server this Pi takes its logins from, and how often (SECURITY.md S11).
# Written by frugal-iot-addbridge-pi. The token itself lives in config.d/secrets.yaml, which is
# never served to a browser - nothing secret may go in this file.
url: https://${PROD_HOST}
organizations:
  - ${ORG_ID}
intervalSeconds: 900
YAML
  # Appended, or the one line replaced: that file holds this server's own secrets too.
  if grep -q '^replica_token:' config.d/secrets.yaml 2>/dev/null; then
    python3 - "$REPLICA_TOKEN" <<'PYEOF'
import io, re, sys
p = 'config.d/secrets.yaml'
s = io.open(p, encoding='utf-8').read()
io.open(p, 'w', encoding='utf-8').write(
    re.sub(r'^replica_token:.*$', 'replica_token: "%s"' % sys.argv[1], s, count=1, flags=re.M))
PYEOF
  else
    {
      echo ""
      echo "# Pulls this Pi's users from the production server named in config.d/replica.yaml."
      echo "# Issued by frugal-iot-addbridge-prod; re-running that command revokes this one."
      echo "replica_token: \"${REPLICA_TOKEN}\""
    } >> config.d/secrets.yaml
  fi
  chmod 600 config.d/secrets.yaml
  echo ""
  echo "Wrote config.d/replica.yaml and stored the token in config.d/secrets.yaml."
  echo "Restart the server to start pulling:  sudo systemctl restart frugaliot"
else
  echo ""
  echo "No replica token given - the bridge relays readings, but people registered on production"
  echo "will not be able to log in on this Pi. Re-run this script with the token to add it."
fi

echo ""
echo "The readings this Pi has already recorded stay here - only new ones are relayed."

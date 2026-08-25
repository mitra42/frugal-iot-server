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
#   npx --no frugal-iot-addbridge-pi --org <org-id> --host <prod-host> --account <account> [--replace]
#   scripts/addbridge-pi.zsh --org myfarm --host prod.example.org --account bridge-northfield
#
# The password is asked for rather than passed on the command line, so it does not end up in your
# shell history. Give it with --password only for an unattended run.

set -euo pipefail

SCRIPT_NAME=$0

usage() {
  echo "Usage: ${SCRIPT_NAME} --org <org-id> --host <prod-host> --account <account> [--port N] [--password PW] [--replace]" >&2
  echo "Example: ${SCRIPT_NAME} --org myfarm --host prod.example.org --account bridge-northfield" >&2
  exit 1
}

ORG_ID=""; PROD_HOST=""; ACCOUNT=""; PASSWORD=""; PROD_PORT=8883; REPLACE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org)      ORG_ID=${2:-}; shift 2 ;;
    --host)     PROD_HOST=${2:-}; shift 2 ;;
    --account)  ACCOUNT=${2:-}; shift 2 ;;
    --password) PASSWORD=${2:-}; shift 2 ;;
    --port)     PROD_PORT=${2:-}; shift 2 ;;
    --replace)  REPLACE=true; shift ;;
    *) echo "Error: unexpected argument '$1'" >&2; usage ;;
  esac
done

[[ -z "$ORG_ID" || -z "$PROD_HOST" || -z "$ACCOUNT" ]] && usage

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
  echo "Add --replace to overwrite it, or edit it by hand." >&2
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
echo ""
echo "The readings this Pi has already recorded stay here - only new ones are relayed."

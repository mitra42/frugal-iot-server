#!/usr/bin/env zsh
#
# List, and optionally delete, retained MQTT messages.
#
# Nodes publish nearly everything retained, so the broker keeps the last value of every topic and
# hands it to each new subscriber - which is how a dashboard can show a reading straight away
# instead of waiting for the next one. The cost is that a topic published by mistake outlives the
# mistake: rename a module, misspell a field, test a node with the wrong id, and that topic stays
# on the broker for ever, appearing on every dashboard. Restarting the broker does not clear it and
# neither does fixing the node. The only way to remove one is to publish an empty message to that
# exact topic, which is what this does.
#
# Run from the server's own directory, the one holding frugal-iot.db, so that the organization's
# broker password can be read from config.d/organizations/.
#
# Usage:
#   npx --no frugal-iot-clearretained '<topic-pattern>'            # list what is retained
#   npx --no frugal-iot-clearretained '<topic-pattern>' --delete   # delete it
#   scripts/clearretained.zsh '<topic-pattern>' [--delete]
#
# Quote the pattern, or the shell expands the wildcards before this ever sees them. In MQTT
# patterns "+" matches exactly one level and "#" matches the rest:
#   'myfarm/#'                          everything the organization holds - look before deleting
#   'myfarm/lotus/esp8266-fb94bb/#'     one node
#   'myfarm/lotus/+/sht/temperture/#'   a misspelled field, on every node in the project
#
# It lists by default and deletes only when told to, because there is no undo. A node's min, max,
# colour and wiring are retained messages too, and they are how the dashboard knows how to draw it
# - delete those and the node has to be restarted before it looks right again.

set -euo pipefail

SCRIPT_NAME=$0

usage() {
  echo "Usage: ${SCRIPT_NAME} '<topic-pattern>' [--delete] [-h host] [-p port] [-u user] [-P password]" >&2
  echo "Example: ${SCRIPT_NAME} 'myfarm/lotus/+/sht/temperture/#'" >&2
  echo "         ${SCRIPT_NAME} 'myfarm/lotus/+/sht/temperture/#' --delete" >&2
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

PATTERN=$1
shift

# Deliberately not called USERNAME and HOST: zsh makes both of those special parameters, tied to
# the real user and machine, so assigning to them does not do what it looks like. An earlier
# version of this script connected to the broker as the login user instead of as the organization,
# and the only symptom was "not authorised".
DELETE=false
BROKER_HOST=localhost
BROKER_PORT=1883
BROKER_USER=""
PASSWORD=""
# How long to wait for the broker to send what it has. Retained messages arrive immediately on
# subscribing, so this only has to cover the round trip; a busy broker on a slow Pi may want more.
WAIT=3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE=true; shift ;;
    -h) BROKER_HOST=${2:-}; shift 2 ;;
    -p) BROKER_PORT=${2:-}; shift 2 ;;
    -u) BROKER_USER=${2:-}; shift 2 ;;
    -P) PASSWORD=${2:-}; shift 2 ;;
    -w) WAIT=${2:-}; shift 2 ;;
    *) echo "Error: unexpected argument '$1'" >&2; usage ;;
  esac
done

if ! command -v mosquitto_sub >/dev/null || ! command -v mosquitto_pub >/dev/null; then
  echo "Error: mosquitto_sub and mosquitto_pub are needed (sudo apt install mosquitto-clients)" >&2
  exit 1
fi

# A bare "#" would be every topic on the broker, across every organization. Almost always a
# mistake, and the one case where a slip is unrecoverable, so it is not accepted at all.
if [[ "$PATTERN" == "#" || "$PATTERN" == "+/#" ]]; then
  echo "Error: refusing the pattern '${PATTERN}' - that is every topic on the broker." >&2
  echo "Name the organization at least, as in 'myfarm/#'." >&2
  exit 1
fi

# Credentials. The broker requires them, and the organization's are in its config file - the same
# place the server reads them from. The first element of the topic pattern is the organization.
if [[ -z "$BROKER_USER" ]]; then
  BROKER_USER=${PATTERN%%/*}
  CONFIG_FILE="config.d/organizations/${BROKER_USER}.yaml"
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: no ${CONFIG_FILE} here, so the broker password for '${BROKER_USER}' cannot be found." >&2
    echo "Run this from the server's own directory, or give credentials with -u and -P." >&2
    exit 1
  fi
  PASSWORD=$(sed -n 's/^mqtt_password:[[:space:]]*//p' "$CONFIG_FILE" | head -1 | tr -d '"'"'"'')
  if [[ -z "$PASSWORD" ]]; then
    echo "Error: no mqtt_password in ${CONFIG_FILE}" >&2
    exit 1
  fi
fi

# What is actually retained. "--retained-only" ignores anything published while we are listening,
# so a node reporting normally is not mistaken for a leftover, and "-F %t" prints just the topic,
# which matters because a payload can itself contain spaces or newlines.
echo "Looking for retained messages matching '${PATTERN}' on ${BROKER_HOST}:${BROKER_PORT} as ${BROKER_USER} ..."
set +e
TOPICS=$(mosquitto_sub -h "$BROKER_HOST" -p "$BROKER_PORT" -u "$BROKER_USER" -P "$PASSWORD" \
  --retained-only -F '%t' -t "$PATTERN" -W "$WAIT" 2>&1)
set -e

# -W always ends in a timeout, which is not a failure here, but a refused login is
if print -r -- "$TOPICS" | grep -qi "not authorised\|Connection refused\|Connection error"; then
  echo "Error: the broker refused the connection:" >&2
  print -r -- "$TOPICS" | grep -i "not authorised\|Connection refused\|Connection error" >&2
  exit 1
fi
# "|| true" because grep exits non-zero when it filters everything out, and under "set -e" that
# would end the script here - silently, before it could say that nothing matched.
TOPICS=$(print -r -- "$TOPICS" | grep -v '^Timed out$' | grep -v '^$' | sort -u) || true

if [[ -z "$TOPICS" ]]; then
  echo "Nothing retained matches that pattern."
  exit 0
fi

COUNT=$(print -r -- "$TOPICS" | grep -c .) || true
print -r -- "$TOPICS" | sed 's/^/  /'
echo "${COUNT} retained topic(s)."

if [[ "$DELETE" != true ]]; then
  echo ""
  echo "Nothing has been changed. To delete these, run the same command again with --delete"
  exit 0
fi

# Deleting one means publishing a zero-length retained message to it, which is how MQTT spells
# "forget this". Sent at QoS 1 so the broker acknowledges each one rather than dropping it under load.
echo "Deleting ${COUNT} retained topic(s) ..."
print -r -- "$TOPICS" | while IFS= read -r t; do
  if mosquitto_pub -h "$BROKER_HOST" -p "$BROKER_PORT" -u "$BROKER_USER" -P "$PASSWORD" -q 1 -r -n -t "$t"; then
    echo "  cleared ${t}"
  else
    echo "  FAILED  ${t}" >&2
  fi
done

echo ""
echo "Done. Check with the same command without --delete - it should report nothing."
echo "If a topic comes back, a node is still publishing it: fix or restart the node, then re-run."
# A bridged broker forwards these deletions to the other end, so clearing here clears there too.
exit 0

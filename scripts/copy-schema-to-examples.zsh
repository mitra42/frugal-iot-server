#!/usr/bin/env zsh
#
# Copy this server's sensor schema into the examples that ship with frugal-iot-logger, so that they
# do not drift away from the schema actually in use.
#
# Called by the prerelease script of both packages - whichever one you are about to publish, the
# examples end up current. It is here rather than in frugal-iot-logger because this is where the
# schema is maintained.
#
# Usage:
#   scripts/copy-schema-to-examples.zsh [<frugal-iot-logger directory>]
#
# With no argument it looks for frugal-iot-logger beside this checkout, which is how these are
# developed. Says what it did and changes nothing else; committing is up to you.

set -euo pipefail

HERE="${0:A:h:h}"                     # The frugal-iot-server checkout this script is in
SCHEMA="${HERE}/config.d/schema"
LOGGER="${1:-${HERE:h}/frugal-iot-logger}"

if [[ ! -d "$LOGGER" ]]; then
  echo "  No frugal-iot-logger checkout at ${LOGGER}, so nothing copied."
  echo "  The examples in that package keep their own copy of the schema and will drift."
  echo "  Clone it beside this one and run this again if you want them updated."
  exit 0                              # Not an error - you may simply not have it checked out
fi

DIRS=("${LOGGER}"/examples/*/config.d/schema(N/))
if (( ! ${#DIRS} )); then
  echo "  No examples/*/config.d/schema directories under ${LOGGER}"
  exit 0
fi

COPIED=0
for d in $DIRS; do
  for f in topics.yaml modules.yaml; do
    if [[ ! -f "${SCHEMA}/${f}" ]]; then
      echo "  ${SCHEMA}/${f} does not exist - skipped"
      continue
    fi
    if cmp -s "${SCHEMA}/${f}" "${d}/${f}"; then
      echo "  same     ${d#${LOGGER}/}/${f}"
    else
      cp "${SCHEMA}/${f}" "${d}/${f}"
      echo "  updated  ${d#${LOGGER}/}/${f}"
      COPIED=$((COPIED+1))
    fi
  done
done

if (( COPIED )); then
  echo
  echo "  ${COPIED} file(s) changed in ${LOGGER} - commit them there before publishing the logger."
fi

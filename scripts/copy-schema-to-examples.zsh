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
#   scripts/copy-schema-to-examples.zsh [-q|--quiet] [<frugal-iot-logger directory>]
#
# With no argument it looks for frugal-iot-logger beside this checkout, which is how these are
# developed. Says what it did and changes nothing else; committing is up to you.
#
# -q (--quiet) names only the files it changed. A run that copies nothing says nothing, so from a
# release script the output is the list of files you now have to commit.

set -euo pipefail

QUIET=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    -q|--quiet) QUIET=1 ;;
    *)          ARGS+=("$arg") ;;
  esac
done

# Progress, as opposed to a change or a problem: silent under -q
say() { (( QUIET )) || print -r -- "$@" }

HERE="${0:A:h:h}"                     # The frugal-iot-server checkout this script is in
SCHEMA="${HERE}/config.d/schema"
LOGGER="${ARGS[1]:-${HERE:h}/frugal-iot-logger}"

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

# Every yaml in the schema directory, rather than a list to keep in step - devices.yaml was added
# and left behind once already.
FILES=("${SCHEMA}"/*.yaml(N:t))
if (( ! ${#FILES} )); then
  echo "  No yaml files in ${SCHEMA}"
  exit 0
fi

COPIED=0
for d in $DIRS; do
  for f in $FILES; do
    if cmp -s "${SCHEMA}/${f}" "${d}/${f}"; then
      say "  same     ${d#${LOGGER}/}/${f}"
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

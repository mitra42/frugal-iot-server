#!/usr/bin/env zsh
#
# Things to do before publishing frugal-iot-server, that are easy to forget and awkward to notice
# afterwards. Run it, read what it says, then publish:
#
#   npm run prerelease
#
# It checks the sensor schema, and copies it into the examples that ship with frugal-iot-logger, so
# that they do not drift away from the schema this server actually uses. Nothing is published here
# and nothing is committed - that is still yours to do.

set -euo pipefail

HERE="${0:A:h:h}"                     # The frugal-iot-server checkout this script is in
SCHEMA="${HERE}/config.d/schema"

cd "$HERE"

echo "=== Checking ${SCHEMA} ==="
node scripts/check-schema.js config.d/schema || true

echo
echo "=== Copying the schema into the frugal-iot-logger examples ==="
zsh scripts/copy-schema-to-examples.zsh

echo
echo "=== Reminders ==="
echo "  - Is the version in package.json the one you mean to publish?"
echo "  - Does it require a new enough frugal-iot-logger and frugal-iot-client?"
echo "      $(node -e 'const d=require("./package.json").dependencies; console.log("logger", d["frugal-iot-logger"], " client", d["frugal-iot-client"])')"
echo "  - Check what would actually go into the package, since \"files\" in package.json is an"
echo "    allow-list and anything not named in it is left out:"
echo "      npm pack --dry-run"
echo "  - Nothing here is committed or published - do that yourself."

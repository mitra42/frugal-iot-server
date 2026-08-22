#!/usr/bin/env zsh
#
# Things to do before publishing frugal-iot-server, that are easy to forget and awkward to notice
# afterwards. Run it, read what it says, then publish:
#
#   npm run prerelease
#
# It checks the sensor schema, copies it into the examples that ship with frugal-iot-logger so they
# do not drift away from the schema this server actually uses, and looks for the package being wired
# to a local checkout. Nothing is published here and nothing is committed - that is still yours.
#
# Two kinds of finding, deliberately treated differently:
#  - The schema warnings are judgement calls: it says what it noticed and leaves it to you.
#  - The ones under "blockers" are never what you want in a published package, so this exits
#    non-zero for those, and "npm run prerelease" fails visibly rather than scrolling past.

set -euo pipefail

HERE="${0:A:h:h}"                     # The frugal-iot-server checkout this script is in
SCHEMA="${HERE}/config.d/schema"

cd "$HERE"

BLOCKERS=()

echo "=== Checking ${SCHEMA} ==="
node scripts/check-schema.js config.d/schema || true

echo
echo "=== Copying the schema into the frugal-iot-logger examples ==="
zsh scripts/copy-schema-to-examples.zsh

# ---- Is this package wired to a checkout on this machine? ----
# Developing the server, logger and client together means pointing the server at sibling checkouts,
# and every way of doing that is invisible once you have got used to it. Published, each one either
# breaks every install outright or ships code nobody else has.
echo
echo "=== Checking nothing is wired to a local checkout ==="

# 1. "file:" or "link:" dependencies - these would make "npm install frugal-iot-server" fail for
#    everybody, because the path they name does not exist on anyone else's machine
LOCALDEPS=$(node -e '
  const p = require("./package.json");
  const out = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(p[section] || {})) {
      if (/^(file:|link:|\.\.?\/)/.test(String(range))) out.push(`${section} ${name} = ${range}`);
    }
  }
  console.log(out.join("\n"));
')
if [[ -n "$LOCALDEPS" ]]; then
  print -r -- "$LOCALDEPS" | sed 's/^/  /'
  BLOCKERS+=("package.json names a dependency by path - publishing that breaks every install. Put the version range back.")
else
  echo "  package.json names no dependencies by path"
fi

# 2. npm link - node_modules/<pkg> being a symlink means what you have been testing is your
#    checkout, not the published package, so the version you require may not contain your changes
LINKED=()
for p in frugal-iot-logger frugal-iot-client; do
  if [[ -L "node_modules/$p" ]]; then
    LINKED+=("$p -> $(readlink node_modules/$p)")
  fi
done
if (( ${#LINKED} )); then
  for l in $LINKED; do echo "  linked: $l"; done
  echo "  What you have been running is that checkout, not the published package."
  echo "  Publish the linked package first, then require the new version here."
else
  echo "  node_modules holds published packages, not links to checkouts"
fi

# 3. The development alternatives inside the source, which are switched by editing rather than by
#    configuration, so they are only ever one forgotten comment away from being published
if grep -qE '^\s*import .*from\s+"\.\./frugal-iot-logger' frugal-iot-server.js 2>/dev/null; then
  BLOCKERS+=("frugal-iot-server.js is importing the logger from ../frugal-iot-logger - comment that line out and uncomment the \"frugal-iot-logger\" one.")
else
  echo "  frugal-iot-server.js imports the logger as a package, not by path"
fi
if grep -qE '^\s*(htmldir|nodemodulesdir):\s*\.\./' config.d/server.yaml 2>/dev/null; then
  BLOCKERS+=("config.d/server.yaml points htmldir or nodemodulesdir at ../frugal-iot-client - that is the development setting and ships to everyone who installs.")
else
  echo "  config.d/server.yaml points at ./node_modules, not at a sibling checkout"
fi

# ---- Are the versions this requires actually available? ----
# Requiring a version that has not been published yet is the trap that stops "npm install" dead,
# on a Pi as well as here, and nothing in the repo shows it.
echo
echo "=== Checking the versions this requires have been published ==="
for p in frugal-iot-logger frugal-iot-client; do
  RANGE=$(node -e "console.log(require('./package.json').dependencies['$p'] || '')")
  if [[ -z "$RANGE" ]]; then continue; fi
  if ! LATEST=$(npm view "$p" version 2>/dev/null); then
    echo "  $p: could not ask npm (offline?) - requires ${RANGE}, check it yourself"
    continue
  fi
  # "npm view <pkg>@<range> version" prints nothing and exits 1 when no published version satisfies
  # the range - which is the answer we are after, not a failure, hence the "|| true" (this script
  # runs under "set -e -o pipefail", so without it the 404 would stop the whole thing here)
  MATCH=$(npm view "${p}@${RANGE}" version 2>/dev/null | tail -1 || true)
  if [[ -z "$MATCH" ]]; then
    echo "  $p: requires ${RANGE}, but the newest published is ${LATEST}"
    BLOCKERS+=("Nothing published satisfies ${p}@${RANGE} (newest is ${LATEST}) - publish ${p} first, or every \"npm install frugal-iot-server\" fails.")
  else
    echo "  $p: requires ${RANGE}, satisfied by a published version (newest is ${LATEST})"
  fi
done

echo
echo "=== Reminders ==="
echo "  - Is the version in package.json the one you mean to publish?  $(node -e 'console.log(require("./package.json").version)')"
echo "  - Check what would actually go into the package, since \"files\" in package.json is an"
echo "    allow-list and anything not named in it is left out:"
echo "      npm pack --dry-run"
echo "  - Nothing here is committed or published - do that yourself."

if (( ${#BLOCKERS} )); then
  echo
  echo "=== Do not publish yet - ${#BLOCKERS} blocker(s) ==="
  for b in $BLOCKERS; do echo "  * $b"; done
  exit 1
fi

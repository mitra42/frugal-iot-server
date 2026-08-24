#!/usr/bin/env zsh
#
# Things to do before publishing frugal-iot-server, that are easy to forget and awkward to notice
# afterwards. Run it, read what it says, then publish:
#
#   npm run prerelease
#
# It checks the sensor schema and copies it into the examples that ship with frugal-iot-logger, sets
# the service worker's cache version, and looks for the package being wired to a checkout on this
# machine, requiring versions that are not published, or containing files it should not.
#
# Two things it changes, both of which have exactly one right answer: the copied schema files, and
# the CACHE_NAME line in public/service-worker.js. Everything else it only reports on. Nothing is
# committed and nothing is published - that is still yours.
#
# Three kinds of finding:
#  - Schema warnings are judgement calls: it says what it noticed and leaves it to you.
#  - "Worth a look" warnings are usually worth acting on but can be deliberate.
#  - "Blockers" are never what you want in a published package, so this exits non-zero for those,
#    and "npm run prerelease" fails visibly rather than scrolling past.

set -euo pipefail

HERE="${0:A:h:h}"                     # The frugal-iot-server checkout this script is in
SCHEMA="${HERE}/config.d/schema"

cd "$HERE"

BLOCKERS=()   # never right in a published package - this script exits non-zero for these
WARNINGS=()   # probably worth doing something about, but yours to judge

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
# on a Pi as well as here, and nothing in the repo shows it. Asking for one that is published but
# not the newest is a lesser problem - a fresh install resolves to the newest anyway, but an
# existing one is free to stay where it is, so your changes reach nobody who already has it.
echo
echo "=== Checking the versions this requires have been published ==="

# Highest published version of $1 satisfying range $2, or empty if none - and it prints nothing and
# exits 1 when nothing matches, which is an answer rather than a failure, hence the "|| true"
# (this script runs under "set -e -o pipefail", so without it a 404 would stop everything here)
published_match() {
  npm view "${1}@${2}" version 2>/dev/null | awk '{print $NF}' | tr -d "'" | tail -1 || true
}

for p in frugal-iot-logger frugal-iot-client; do
  RANGE=$(node -e "console.log(require('./package.json').dependencies['$p'] || '')")
  if [[ -z "$RANGE" ]]; then continue; fi
  if ! LATEST=$(npm view "$p" version 2>/dev/null); then
    echo "  $p: could not ask npm (offline?) - requires ${RANGE}, check it yourself"
    continue
  fi
  MATCH=$(published_match "$p" "$RANGE")
  if [[ -z "$MATCH" ]]; then
    echo "  $p: requires ${RANGE}, but the newest published is ${LATEST}"
    BLOCKERS+=("Nothing published satisfies ${p}@${RANGE} (newest is ${LATEST}) - publish ${p} first, or every \"npm install frugal-iot-server\" fails.")
  elif [[ "$MATCH" != "$LATEST" ]]; then
    echo "  $p: requires ${RANGE} -> ${MATCH}, but ${LATEST} is published"
    WARNINGS+=("${p}@${RANGE} resolves to ${MATCH}, not the newest published ${LATEST} - bump the range if you meant installs to pick up ${LATEST}.")
  else
    # The range allows the newest, but if its floor is older then an existing install can sit on
    # that floor - "npm install" with a lockfile will not move it, only "npm update" will
    FLOOR=${RANGE#[\^~>=]}
    FLOOR=${FLOOR#=}
    if [[ -n "$FLOOR" && "$FLOOR" != "$LATEST" ]]; then
      echo "  $p: requires ${RANGE}, newest published ${LATEST} (an existing install may stay on ${FLOOR})"
      WARNINGS+=("${p} requires ${RANGE}, so an install that already has ${FLOOR} is not obliged to move to ${LATEST}. Raise the range to ^${LATEST} if this release needs it.")
    else
      echo "  $p: requires ${RANGE}, newest published ${LATEST} - in step"
    fi
  fi
done

# ---- The web client's cache-busting version ----
# public/service-worker.js caches the app in the browser, and CACHE_NAME is what makes an already
# installed PWA fetch it again. Left behind, people keep running the client they already had, which
# looks exactly like a release that did nothing. It tracks the client version, so set it from
# whichever published client this release will actually resolve to.
echo
echo "=== Checking the service worker's cache version ==="
SW=public/service-worker.js
CLIENT_RANGE=$(node -e "console.log(require('./package.json').dependencies['frugal-iot-client'] || '')")
if [[ ! -f "$SW" ]]; then
  echo "  no ${SW} here"
elif [[ -z "$CLIENT_RANGE" ]]; then
  echo "  package.json has no frugal-iot-client dependency to match against"
else
  SW_VERSION=$(sed -n "s/^const CACHE_NAME = 'frugal-iot-cache-\([^']*\)'.*/\1/p" "$SW" | head -1)
  CLIENT_LATEST=$(npm view frugal-iot-client version 2>/dev/null || true)
  CLIENT_WANTED=$(published_match frugal-iot-client "$CLIENT_RANGE")
  if [[ -z "$SW_VERSION" ]]; then
    echo "  could not find a CACHE_NAME line of the form frugal-iot-cache-<version> in ${SW}"
    WARNINGS+=("Could not read CACHE_NAME from ${SW} - check by hand that it changes when the client does.")
  elif [[ -z "$CLIENT_WANTED" ]]; then
    echo "  CACHE_NAME says ${SW_VERSION}, and nothing published satisfies ${CLIENT_RANGE}"
    BLOCKERS+=("Cannot set CACHE_NAME: no published frugal-iot-client satisfies ${CLIENT_RANGE}.")
  else
    if [[ "$SW_VERSION" == "$CLIENT_WANTED" ]]; then
      echo "  CACHE_NAME is ${SW_VERSION}, matching the client this release installs"
    else
      # An in-place edit rather than a warning: there is only one right answer, and a stale cache
      # name is invisible until somebody's browser keeps serving them last month's dashboard
      sed -i.bak "s/^const CACHE_NAME = 'frugal-iot-cache-[^']*'/const CACHE_NAME = 'frugal-iot-cache-${CLIENT_WANTED}'/" "$SW"
      rm -f "${SW}.bak"
      echo "  CACHE_NAME updated from ${SW_VERSION} to ${CLIENT_WANTED} - commit ${SW}"
    fi
    if [[ -n "$CLIENT_LATEST" && "$CLIENT_WANTED" != "$CLIENT_LATEST" ]]; then
      WARNINGS+=("CACHE_NAME follows ${CLIENT_WANTED} because that is what ${CLIENT_RANGE} allows, while ${CLIENT_LATEST} is published.")
    fi
  fi
fi

# ---- What would and would not be published ----
echo
echo "=== Checking what the package would contain ==="
if ! node scripts/check-published-files.js; then
  BLOCKERS+=("Something git ignores would be published - see above.")
fi

echo
echo "=== Reminders ==="
echo "  - Is the version in package.json the one you mean to publish?  $(node -e 'console.log(require("./package.json").version)')"
echo "  - Nothing here is committed or published - do that yourself."

if (( ${#WARNINGS} )); then
  echo
  echo "=== Worth a look - ${#WARNINGS} warning(s) ==="
  for w in $WARNINGS; do echo "  - $w"; done
fi

if (( ${#BLOCKERS} )); then
  echo
  echo "=== Do not publish yet - ${#BLOCKERS} blocker(s) ==="
  for b in $BLOCKERS; do echo "  * $b"; done
  exit 1
fi

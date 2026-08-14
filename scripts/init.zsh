#!/usr/bin/env zsh
#
# Prepare the current directory to run a Frugal IoT server: configuration, directories, database.
# Everything a server instance owns lives here, separate from the software itself, which npm keeps
# in node_modules (or which sits in a git clone).
#
# Usage:
#   npx frugal-iot-init          # after: npm install frugal-iot-server
#   scripts/init.zsh             # in a git clone, where the config files are already present
#
# Safe to run again: existing files are left exactly as they are, only missing ones are added,
# so it can also be used after an upgrade to pick up newly added configuration files.

set -euo pipefail

# Where the package itself lives - :A resolves the npm symlink in node_modules/.bin
PKG="${0:A:h:h}"
DB="./frugal-iot.db"

if ! command -v sqlite3 >/dev/null; then
  echo "Error: sqlite3 command not found - install it with: sudo apt install sqlite3" >&2
  exit 1
fi

if [[ ! -f "${PKG}/frugal-iot-createdb.sql" ]]; then
  echo "Error: cannot find the frugal-iot-server package files (looked in ${PKG})" >&2
  exit 1
fi

# ---- 1. Configuration files, copied only if not already here ----
COPIED=()      # which files this run actually created, so existing ones are never rewritten below
DIFFER_TO=()   # files kept that no longer match what this release ships, and where to compare them
DIFFER_FROM=()
# copy_if_missing <packaged file> <local file> [compare]
# "compare" asks for a warning when the file exists but differs from the one this release ships.
# Only pass it for files nobody is expected to edit - config.yaml, mqtt.yaml and server.yaml are
# this installation's own settings, so of course they differ, and warning about them every time
# would train you to ignore the warning that matters.
copy_if_missing() {
  local from=$1 to=$2 compare=${3:-}
  if [[ -e "$to" ]]; then
    if [[ "$compare" == compare && -e "$from" ]] && ! cmp -s "$from" "$to"; then
      DIFFER_TO+=("$to")
      DIFFER_FROM+=("$from")
      echo "  kept    ${to} (DIFFERS from this release - see below)"
    else
      echo "  kept    ${to} (already present)"
    fi
  elif [[ -e "$from" ]]; then
    mkdir -p "${to:h}"
    cp "$from" "$to"
    COPIED+=("$to")
    echo "  created ${to}"
  fi
}

echo "Configuration:"
copy_if_missing "${PKG}/config.yaml" "./config.yaml"
for f in logger.yaml mqtt.yaml server.yaml; do
  copy_if_missing "${PKG}/config.d/${f}" "./config.d/${f}"
done
# The schema describes the sensor types the software understands, so a release changing it matters
for f in "${PKG}"/config.d/schema/*.yaml(N); do
  copy_if_missing "$f" "./config.d/schema/${f:t}" compare
done
# Copied so that mosquitto.conf and frugaliot.service can be edited and installed from here. Worth
# comparing: these get copied on somewhere else (/etc/...), where an old version lingers unnoticed.
for f in "${PKG}"/extras/*(N); do
  copy_if_missing "$f" "./extras/${f:t}" compare
done

# ---- 1a. Point server.yaml at the web client this instance actually has ----
# The packaged server.yaml may have been published from a development checkout, where the client is
# a sibling directory (../frugal-iot-client). When installed with npm the client is a dependency,
# under this directory's node_modules, so correct the two paths rather than trusting how it shipped.
# Only ever applied to a file this run created - an existing server.yaml is somebody's own setup.
if [[ "$PKG" == */node_modules/frugal-iot-server && " ${COPIED[*]} " == *" ./config.d/server.yaml "* ]]; then
  # Drop every existing form of these two settings (the commented alternatives as well, so the file
  # cannot end up with the same key twice) and state them once for this installation.
  sed -i.bak \
    -e '/^[#[:space:]]*htmldir:/d' \
    -e '/^[#[:space:]]*nodemodulesdir:/d' \
    -e '/^[#[:space:]]*publicdir:/d' \
    -e '/^[#[:space:]]*privatedir:/d' \
    -e '/[Pp]roduction mode/d' \
    -e '/[Dd]evelopment mode/d' \
    -e '/path to the private directory/d' \
    ./config.d/server.yaml
  rm -f ./config.d/server.yaml.bak
  cat >> ./config.d/server.yaml <<'YAML'
# Files that belong to the software rather than to this server - set by frugal-iot-init.
# datadir and otadir are left pointing here, because that content is this server's own.
htmldir: ./node_modules/frugal-iot-client
nodemodulesdir: ./node_modules
publicdir: ./node_modules/frugal-iot-server/public
privatedir: ./node_modules/frugal-iot-server/private
YAML
  echo "  set     ./config.d/server.yaml to serve the client from ./node_modules"
fi

# ---- 2. Directories this instance writes to ----
echo "Directories:"
for d in config.d/organizations data ota; do
  if [[ -d "$d" ]]; then
    echo "  kept    ${d}/ (already present)"
  else
    mkdir -p "$d"
    echo "  created ${d}/"
  fi
done

# ---- 3. Database - creating tables it does not have yet, leaving any data alone ----
echo "Database:"
if [[ -f "$DB" ]]; then
  sqlite3 "$DB" < "${PKG}/frugal-iot-createdb.sql"
  echo "  updated ${DB} (added any missing tables, existing data untouched)"
else
  sqlite3 "$DB" < "${PKG}/frugal-iot-createdb.sql"
  echo "  created ${DB}"
fi

if (( ${#DIFFER_TO} )); then
  echo
  echo "These files were left as you have them, but this release ships a different version:"
  for i in {1..${#DIFFER_TO}}; do
    echo "  ${DIFFER_TO[$i]}"
    echo "    compare with:  diff ${DIFFER_TO[$i]} ${DIFFER_FROM[$i]}"
  done
  echo "Usually that just means you edited it, and there is nothing to do. But a release can also"
  echo "change one of these files - and anything installed elsewhere from it, such as"
  echo "/etc/mosquitto/conf.d/frugal-iot.conf, keeps the old content until you copy it again."
fi

echo
echo "Ready. Next:"
echo "  npx frugal-iot-setpassword superuser <password>            # so you can log in as the administrator"
echo "  npx frugal-iot-addorganization <org-id> <name> <email> <phone> <broker-password>"
echo "  npx frugal-iot-server                                      # start it"

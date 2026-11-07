#!/usr/bin/env zsh
#
# Prepare the current directory to run a Frugal IoT server: configuration, directories, database.
# Everything a server instance owns lives here, separate from the software itself, which npm keeps
# in node_modules (or which sits in a git clone).
#
# Usage:
#   npx --no frugal-iot-init          # after: npm install frugal-iot-server
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
DIFFER_OURS=() # ...and the lines in each that this release does not have
# copy_if_missing <packaged file> <local file> [compare]
# "compare" is for a file a release extends - the schema - and that someone may also have added to
# here. When it differs, the question is whether this copy has anything the release does not:
#  - nothing: every line here is still in the release's version, so all the release did was add
#    (a new sensor type, a new field). Installing it loses nothing, so it is installed. Asking
#    instead was a question with only one answer, put to someone who then had to read a diff of a
#    file they never touched to find that out.
#  - something: either it was added here, or the release changed or removed it - and only a person
#    can tell which. So it is kept, and those lines, and only those, are shown.
# Only pass "compare" for files like that - config.yaml, mqtt.yaml and server.yaml are this
# installation's own settings, so of course they differ, and warning about them every time would
# train you to ignore the warning that matters.
copy_if_missing() {
  local from=$1 to=$2 compare=${3:-} ours
  if [[ -e "$to" ]]; then
    if [[ "$compare" == compare && -e "$from" ]] && ! cmp -s "$from" "$to"; then
      ours=$(diff "$to" "$from" | sed -n 's/^< //p') || true
      if [[ -z "$ours" ]]; then
        cp "$from" "$to"
        echo "  updated ${to} (this release only adds to it)"
      else
        DIFFER_TO+=("$to")
        DIFFER_FROM+=("$from")
        DIFFER_OURS+=("$ours")
        echo "  kept    ${to} (has lines this release does not - see below)"
      fi
    else
      echo "  kept    ${to} (already present)"
    fi
  elif [[ -e "$from" ]]; then
    mkdir -p "${to:h}"
    # extras/ holds a directory (grafana/) as well as files, and a plain cp refuses a directory -
    # which under "set -e" ended the whole init, after server.yaml had been created but before it
    # was pointed at node_modules. The re-run then saw an existing server.yaml and left it alone, so
    # "/" 404ed. -R for a directory, so a failure here cannot strand a half-initialised install.
    if [[ -d "$from" ]]; then cp -R "$from" "$to"; else cp "$from" "$to"; fi
    COPIED+=("$to")
    echo "  created ${to}"
  fi
}

echo "Configuration:"
copy_if_missing "${PKG}/config.yaml" "./config.yaml"
for f in logger.yaml mqtt.yaml server.yaml email.yaml mapping.yaml; do
  copy_if_missing "${PKG}/config.d/${f}" "./config.d/${f}"
done
# The schema describes the sensor types the software understands, so a release changing it matters
for f in "${PKG}"/config.d/schema/*.yaml(N); do
  copy_if_missing "$f" "./config.d/schema/${f:t}" compare
done
# Copied so that mosquitto.conf and frugaliot.service can be there to read and install from.
#
# NOT compared against the packaged copy. This copy is never overwritten - that is the whole point
# of copy_if_missing - so once a release changes one of these it differs for ever, and says so at
# every upgrade whether or not anything is actually out of date. A warning that is always wrong is
# one you learn to skip past, and then miss on the day it is right. What matters is not whether
# this copy is current but whether the file actually in use is, so that is what is checked, below,
# where it really lives.
for f in "${PKG}"/extras/*(N); do
  copy_if_missing "$f" "./extras/${f:t}"
done

# ---- 1b. Secrets this server generates for itself ----
# Kept in config.d like everything else - that directory is not served (the static mounts are
# publicdir, htmldir, datadir, privatedir and node_modules), and what does reach a browser goes
# through unsafeCopyConfigFor, which withholds this section. Mode 600 because these are secrets
# whatever else is true.
#
# Never regenerated: rotating session_secret logs everyone out, and rotating user_secret invalidates
# every browser's broker credential until its next login. Both are recoverable, neither should
# happen because somebody re-ran init.
#
# Written here as well as by the server (lib/secrets.js fills in anything missing at startup) so
# that a permissions problem with this directory shows up now, while somebody is watching the
# install, rather than in the journal at first boot. The server appends only what it does not find,
# so the two cannot fight, and a release adding a new secret needs no change here.
if [[ ! -e ./config.d/secrets.yaml ]]; then
  # ( set +o pipefail ) because head closing the pipe makes tr fail, which under pipefail would
  # end the script - see the note in claude.md about this exact trap.
  randsecret() { ( set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 43 ); }
  mkdir -p ./config.d
  # No "secrets:" wrapper inside the file: readConfigFromDir keys each config.d file by its own
  # name, so this file's contents land at config.secrets - the same way server.yaml's contents land
  # at config.server. A wrapper here would give config.secrets.secrets.
  cat > ./config.d/secrets.yaml <<YAML
# Secrets belonging to this server. Generated by frugal-iot-init; never served to a browser
# (unsafeCopyConfigFor withholds this whole file's section). Not in git, and worth backing up
# alongside frugal-iot.db.

# Signs the session cookie. Changing it ends every session.
session_secret: "$(randsecret)"

# Mixed into each user's derived MQTT password. Changing it invalidates every browser's broker
# credential until its next login, and nothing else.
user_secret: "$(randsecret)"
YAML
  chmod 600 ./config.d/secrets.yaml
  COPIED+=("./config.d/secrets.yaml")
  echo "  created ./config.d/secrets.yaml (generated secrets, mode 600)"
else
  chmod 600 ./config.d/secrets.yaml
  echo "  kept    ./config.d/secrets.yaml (already present)"
fi

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

# ---- 3a. Schema changes that CREATE TABLE IF NOT EXISTS cannot make ----
# Adding permissions.project needs the UNIQUE constraint changed as well, and SQLite cannot alter a
# constraint - so the table is rebuilt. Guarded on the column being absent, because init runs on
# every upgrade. See scripts/migrate-permissions-project.sql for what it does and why.
PERM_COLS=$(sqlite3 "$DB" "pragma table_info(permissions);" | cut -d'|' -f2) || true
if ! print -r -- "$PERM_COLS" | grep -qx project; then
  # A rebuild is the one change here that is not a no-op if it goes wrong, so keep a copy first.
  DB_BACKUP="${DB}.bak-$(date +%Y%m%d%H%M%S)"
  cp "$DB" "$DB_BACKUP"
  if sqlite3 "$DB" < "${PKG}/scripts/migrate-permissions-project.sql"; then
    echo "  updated ${DB} (added permissions.project; existing rows are organization-wide)"
    echo "          previous copy kept at ${DB_BACKUP}"
  else
    echo "  ERROR: failed to add permissions.project to ${DB}" >&2
    echo "         the database is unchanged; a copy from before the attempt is at ${DB_BACKUP}" >&2
    exit 1
  fi
else
  echo "  kept    ${DB} permissions.project (already present)"
fi

# ---- 3b. Dependency overrides, which npm reads only from THIS directory's package.json ----
# frugal-iot-server's package.json carries "overrides" that fix vulnerable transitive dependencies
# (uuid, below firebase-admin in the logger). npm honours overrides only in the top-level project,
# and here that is this directory's package.json, which just lists frugal-iot-server - so the
# package's own overrides are ignored, and "npm audit" on an install reports what it reports clean
# in a checkout. Copied here so that they apply. A dependency needing an override has to have it
# repeated in the server's package.json, since the logger's own is ignored for the same reason.
#
# The release's value replaces a different one here: these exist to raise a floor, and a stale one
# would bring the vulnerability back. One a release drops is left in place - it is harmless.
if [[ "$PKG" == */node_modules/frugal-iot-server && -f ./package.json ]]; then
  echo "Dependencies:"
  OVR_SET=$(node -e '
    const fs = require("fs");
    const want = JSON.parse(fs.readFileSync(process.argv[1])).overrides || {};
    const local = JSON.parse(fs.readFileSync("./package.json"));
    const have = local.overrides || {};
    const changed = Object.keys(want).filter(k => JSON.stringify(have[k]) !== JSON.stringify(want[k]));
    if (changed.length) {
      local.overrides = { ...have, ...want };
      fs.writeFileSync("./package.json", JSON.stringify(local, null, 2) + "\n");
    }
    console.log(changed.map(k => k + " " + JSON.stringify(want[k])).join("\n"));
  ' "${PKG}/package.json") || OVR_SET="ERROR"
  if [[ "$OVR_SET" == ERROR ]]; then
    echo "  ERROR: could not read or update ./package.json - its overrides are unchanged" >&2
  elif [[ -z "$OVR_SET" ]]; then
    echo "  kept    ./package.json overrides (already present)"
  else
    for l in ${(f)OVR_SET}; do echo "  set     ./package.json override ${l}"; done
    # The override changes nothing in node_modules until npm installs again
    if npm install --no-fund --no-audit; then
      echo "  updated ./node_modules to match"
    else
      echo "  ERROR: npm install failed - run it again in $(pwd) before restarting the server" >&2
    fi
  fi
fi

# ---- 4. Is what was installed FROM extras/ still current? ----
# The files in extras/ are templates for files that live somewhere else - the broker's
# configuration, its ACL, the systemd units. Whether this directory's copy matches the release says
# nothing about any of them, so the question is asked of the file actually in use - found by asking
# the broker and systemd where that is, never by assuming a Pi's layout. Production's broker
# configuration is several hand-written files in conf.d, its unit is in /usr/lib/systemd/system, and
# checking "the usual place" there reported everything as absent, which was true and no help.
#
# Each is compared in the way it is allowed to differ, and what is reported is the lines that
# differ, not an instruction to go and diff it:
#  - the broker's configuration, setting by setting across every file it reads
#    (broker_conf_compare in scripts/broker-config.zsh)
#  - aclfile as a subset: addbridge-prod appends a stanza per bridge, so only a line this release
#    ships and the installed file lacks is a finding
#  - frugaliot.service with User, WorkingDirectory and ExecStart normalised, because the installer
#    rewrites those for whoever runs it and wherever the server went
STALE=()        # "installed|packaged" - and STALE_LINES, what differs, in the same order
STALE_LINES=()
UNREADABLE=()   # there, but not readable even with sudo -n

# norm_text <how>: settings only - comments and blank lines gone - with what an installer
# legitimately rewrites reduced to its name. Reads its standard input.
norm_text() {
  local expr='s#^##'
  [[ $1 == service ]] && expr='s#^(User|WorkingDirectory|ExecStart)=.*#\1=(set by the installer)#'
  sed -E "$expr" | grep -vE '^[[:space:]]*(#|$)' || true
}

# check_installed <packaged file> <installed path> <exact|service|subset>
# The installed file is read with broker_conf_cat, which retries with sudo -n: the aclfile is
# mosquitto:mosquitto 600, so reading it plainly as the service user always fails.
check_installed() {
  local from=$1 to=$2 how=$3 here lines
  [[ -e "$from" && -e "$to" ]] || return 0
  if ! here=$(broker_conf_cat "$to"); then
    UNREADABLE+=("$to")
    return 0
  fi
  case "$how" in
    subset)
      lines=$(comm -23 <(norm_text exact < "$from" | sort -u) <(print -r -- "$here" | norm_text exact | sort -u) |
        sed 's/^/release only: /') || true
      ;;
    *)
      # "here" and "release", from diff's < and >; its hunk headers say nothing to a reader
      lines=$(diff <(print -r -- "$here" | norm_text "$how") <(norm_text "$how" < "$from") |
        sed -n -e 's/^< /here only:    /p' -e 's/^> /release only: /p') || true
      ;;
  esac
  if [[ -n "$lines" ]]; then
    STALE+=("${to}|${from}")
    STALE_LINES+=("$lines")
  fi
}

# Where systemd keeps a unit, if it has one - /etc/systemd/system on a Pi, /usr/lib/systemd/system
# on production
unit_path() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl show -p FragmentPath --value "$1" 2>/dev/null || true
}

# The broker: what it reads, asked of its own configuration
source "${PKG}/scripts/broker-config.zsh"
broker_conf_read
BROKER_FINDINGS=""
if (( ${#BROKER_CONF_FILES} )); then
  BROKER_FINDINGS=$(broker_conf_compare "${PKG}/extras/mosquitto.conf")
  broker_setting acl_file
  [[ -n "$BROKER_SETTING" ]] && check_installed "${PKG}/extras/aclfile" "$BROKER_SETTING" subset
fi

SERVICE_UNIT=$(unit_path frugaliot.service)
[[ -n "$SERVICE_UNIT" ]] && check_installed "${PKG}/extras/frugaliot.service" "$SERVICE_UNIT" service
# The setup network's watchdog exists only on a Pi with WiFi that install-pi.sh gave one. Anywhere
# else it is simply not there, and saying so at every upgrade was noise.
WATCHDOG_UNIT=$(unit_path frugaliot-ap-watchdog.service)
if [[ -n "$WATCHDOG_UNIT" ]]; then
  check_installed "${PKG}/extras/frugaliot-ap-watchdog.service" "$WATCHDOG_UNIT" exact
  check_installed "${PKG}/extras/frugaliot-ap-watchdog.timer" "$(unit_path frugaliot-ap-watchdog.timer)" exact
  check_installed "${PKG}/extras/frugaliot-ap-watchdog" /usr/local/sbin/frugaliot-ap-watchdog exact
fi

if (( ${#DIFFER_TO} )); then
  echo
  echo "Kept as you have them, because they have lines this release's version does not:"
  for i in {1..${#DIFFER_TO}}; do
    echo "  ${DIFFER_TO[$i]}"
    print -r -- "${DIFFER_OURS[$i]}" | head -10 | sed 's/^/      /'
    (( $(print -r -- "${DIFFER_OURS[$i]}" | wc -l) > 10 )) && echo "      ..."
  done
  echo "If you added those, nothing needs doing. If you did not, this release changed or removed"
  echo "them, and taking its version is safe:"
  for i in {1..${#DIFFER_TO}}; do echo "  cp ${DIFFER_FROM[$i]} ${DIFFER_TO[$i]}"; done
fi

if [[ -n "$BROKER_FINDINGS" ]]; then
  echo
  echo "The broker's configuration, compared setting by setting with this release's"
  echo "extras/mosquitto.conf, across the ${#BROKER_CONF_FILES} file(s) it reads:"
  BROKER_REAL=0
  for l in ${(f)BROKER_FINDINGS}; do
    case ${l%%$'\t'*} in
      missing)   echo "  missing:     ${l#*$'\t'}"; (( BROKER_REAL++ )) || true ;;
      differs)   echo "  different:   ${l#*$'\t'}"; (( BROKER_REAL++ )) || true ;;
      elsewhere) echo "  (fine)       ${l#*$'\t'}" ;;
    esac
  done
  if (( BROKER_REAL )); then
    echo "To bring it in line, put the settings above in any file in /etc/mosquitto/conf.d/ - on a Pi"
    echo "set up by install-pi.sh, re-running it does that - then: sudo systemctl restart mosquitto"
  fi
fi
(( ${#BROKER_CONF_UNREADABLE} )) &&
  { echo; echo "Broker configuration not readable as $(id -un), so the comparison above is incomplete: ${(j:, :)BROKER_CONF_UNREADABLE}"; }

if (( ${#STALE} )); then
  echo
  echo "Installed elsewhere from extras/, and different from this release:"
  for i in {1..${#STALE}}; do
    echo "  ${STALE[$i]%%|*}"
    print -r -- "${STALE_LINES[$i]}" | sed 's/^/      /'
  done
  echo "Bring them in line by hand - change the \"here only\" lines to the \"release only\" ones - or on"
  echo "a Pi set up by it, by re-running install-pi.sh. The whole difference, if you want it:"
  for e in $STALE; do echo "  sudo diff ${e%%|*} ${e#*|}"; done
fi

if (( ${#UNREADABLE} )); then
  echo
  echo "There, but not readable as $(id -un) without a sudo password, so not compared: ${(j:, :)UNREADABLE}"
  echo "To compare them too: sudo -v, then run this again"
fi

echo
echo "Ready. Next:"
echo "  npx --no frugal-iot-setpassword superuser <password>            # so you can log in as the administrator"
echo "  npx --no frugal-iot-addorganization <org-id> <name> <email> <phone> <broker-password>"
echo "  npx --no frugal-iot-server                                      # start it"

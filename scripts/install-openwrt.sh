#!/bin/sh
#
# Install a complete Frugal IoT server - broker, server, service - on an OpenWrt router.
#
# UNTESTED ON REAL HARDWARE. It is install-pi.sh's job done with opkg, procd and BusyBox, written
# from knowledge of OpenWrt rather than from a router. Run scripts/openwrt-preflight.sh first; if that
# reports FAIL, this will too. OPENWRT.md says what to send back when something goes wrong.
#
#   wget -O install-openwrt.sh https://raw.githubusercontent.com/mitra42/frugal-iot-server/openwrt/scripts/install-openwrt.sh
#   sh install-openwrt.sh --org myfarm --name "My Farm" --email you@example.com --phone +61123456789 \
#                         --dir /mnt/sda1/frugal-iot
#
# Plain /bin/sh on purpose - a fresh OpenWrt has neither bash nor zsh. (zsh IS installed here, because
# the server's own setup commands - npx frugal-iot-addorganization and friends - are zsh scripts.)
#
# Passwords not given are generated and printed at the end, and kept in a log readable only by root.
# Safe to run again: each step checks whether it is already done.
#
# What it does NOT do: set up HTTPS (over-the-air updates need it), open anything in the firewall, or
# flash your sensor nodes. It prints the settings to give them.

# ---------------------------------------------------------------- log everything, keep the exit code
# Re-run ourselves with output going to the terminal and a log. A pipe to tee loses the exit status
# in plain sh, so it is passed out through a file.
case " $* " in
  *" --dry-run "*|*" --help "*|*" -h "*) ;;
  *)
    if [ -z "${FRUGAL_INSTALL_LOGGING:-}" ] && [ -f "$0" ]; then
      FRUGAL_INSTALL_LOG="/root/frugal-iot-install-$(date +%Y%m%d-%H%M%S).log"
      ( umask 077; : >> "$FRUGAL_INSTALL_LOG" )
      RC_FILE=$(mktemp)
      export FRUGAL_INSTALL_LOGGING=1 FRUGAL_INSTALL_LOG
      ( sh "$0" "$@" && echo 0 > "$RC_FILE" || echo $? > "$RC_FILE" ) 2>&1 | tee -a "$FRUGAL_INSTALL_LOG"
      RC=$(cat "$RC_FILE"); rm -f "$RC_FILE"
      exit "${RC:-1}"
    fi ;;
esac

set -eu

# ---------------------------------------------------------------- settings and arguments

ORG_ID=""; ORG_NAME=""; ORG_EMAIL=""; ORG_PHONE=""
BROKER_PW=""; SUPER_PW=""; LOGIN_PW=""; BROKER_HOST=""
INSTALL_DIR="/opt/frugal-iot"; RUN_USER="root"
ASSUME_YES=0; DRY_RUN=0; FORCE=0
LOG="${FRUGAL_INSTALL_LOG:-none}"
MQ_STATE="/etc/mosquitto/state"

usage() {
  cat <<USAGE
Usage: sh install-openwrt.sh [options]

  --org <id>           organization id, 1-10 lower-case letters or digits. Becomes the first part of
                       every MQTT topic, so it must match what your nodes publish to.
  --name "<name>"      organization display name
  --email <address>    contact address for the organization
  --phone <number>     contact phone, "+" and digits only
  --superuser-password password for this server's administrator login (generated if not given)
  --login-password     web login password for the organization's own account (generated if not given)
  --broker-password    the organization's shared broker credential. Generated, and not needed: nodes
                       are issued their own when they enrol. Set it only to match nodes flashed
                       before enrolment existed.
  --broker-host <host> what browsers and nodes should call this router. Default: its LAN address.
  --dir <path>         where to install. Default: ${INSTALL_DIR}. Needs ~400 MB free on ext4/f2fs/btrfs,
                       so on most routers this is a USB or SSD drive: --dir /mnt/sda1/frugal-iot
  --user <name>        account to run the server as. Default: root, which is what most OpenWrt
                       services do. A named account is created if it does not exist.
  --yes                never ask anything
  --force              carry on past checks that would otherwise stop the install
  --dry-run            check the arguments and the router, say what would be done, change nothing
  --help
USAGE
  exit "${1:-0}"
}

need_arg() { [ $# -ge 2 ] || { echo "$1 needs a value" >&2; usage 1; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --org)                 need_arg "$@"; ORG_ID=$2; shift 2 ;;
    --name)                need_arg "$@"; ORG_NAME=$2; shift 2 ;;
    --email)               need_arg "$@"; ORG_EMAIL=$2; shift 2 ;;
    --phone)               need_arg "$@"; ORG_PHONE=$2; shift 2 ;;
    --superuser-password)  need_arg "$@"; SUPER_PW=$2; shift 2 ;;
    --login-password)      need_arg "$@"; LOGIN_PW=$2; shift 2 ;;
    --broker-password)     need_arg "$@"; BROKER_PW=$2; shift 2 ;;
    --broker-host)         need_arg "$@"; BROKER_HOST=$2; shift 2 ;;
    --dir)                 need_arg "$@"; INSTALL_DIR=$2; shift 2 ;;
    --user)                need_arg "$@"; RUN_USER=$2; shift 2 ;;
    --yes|-y)              ASSUME_YES=1; shift ;;
    --force)               FORCE=1; shift ;;
    --dry-run)             DRY_RUN=1; shift ;;
    --help|-h)             usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

STEP_N=0
step()  { STEP_N=$((STEP_N+1)); echo; echo "=== ${STEP_N}. $* ==="; }
info()  { echo "    $*"; }
ok()    { echo "    ok: $*"; }
skip()  { echo "    already done: $*"; }
warn()  { echo "    WARNING: $*"; }
die()   { echo; echo "STOPPED: $*" >&2; exit 1; }

on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$DRY_RUN" = 0 ]; then
    echo
    echo "=== Stopped (exit ${rc}) ==="
    echo "Nothing after the last 'ok' above has been done. Run it again once the cause is dealt"
    echo "with - the steps that succeeded are not repeated."
    [ "$LOG" != none ] && echo "The log of this run, to send back if you need help: ${LOG}"
  fi
}
trap on_exit EXIT

randpw() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16 || true; }

ask() { # ask <variable> <prompt>
  eval "cur=\${$1:-}"
  [ -n "$cur" ] && return 0
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    die "nothing given for '$2', and there is no terminal to ask at. Pass it on the command line - see --help."
  fi
  printf '    %s: ' "$2"; read -r reply
  [ -n "$reply" ] || die "that cannot be empty"
  eval "$1=\$reply"
}

# Passwords go inside single quotes on a shell command line, so refuse one that contains a quote
no_quote() { case "$2" in *\'*) die "$1 must not contain a single quote" ;; esac; }

# ---------------------------------------------------------------- package manager
if command -v opkg >/dev/null 2>&1; then PM=opkg
elif command -v apk >/dev/null 2>&1; then PM=apk
else PM=""; fi

pkg_update() { case "$PM" in opkg) opkg update ;; apk) apk update ;; esac; }
pkg_installed() {
  case "$PM" in
    opkg) opkg list-installed 2>/dev/null | grep -q "^$1 " ;;
    apk)  apk info -e "$1" >/dev/null 2>&1 ;;
    *)    return 1 ;;
  esac
}
pkg_available() {
  case "$PM" in
    opkg) opkg list 2>/dev/null | grep -q "^$1 - " ;;
    apk)  apk search -e "$1" 2>/dev/null | grep -q . ;;
    *)    return 1 ;;
  esac
}
pkg_add() { # install packages, stopping on the first that cannot be had, and saying which
  for p in "$@"; do
    pkg_installed "$p" && continue
    case "$PM" in
      opkg) opkg install "$p" ;;
      apk)  apk add "$p" ;;
    esac || die "could not install package '${p}'"
    info "installed ${p}"
  done
}

node_version_ok() { # "v20.17.0" -> succeeds if at least 20.17
  echo "$1" | sed 's/^v//' | awk -F'[.-]' '{ exit !($1 > 20 || ($1 == 20 && $2 >= 17)) }'
}

mount_info() { # "mountpoint fstype" of whatever holds a path (or its nearest existing parent)
  p=$1
  while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done
  p=$(cd "$p" 2>/dev/null && pwd -P || echo "$p")
  awk -v p="$p" '
    { m = $2; pre = (m == "/") ? "/" : (m "/")
      if ((p == m || index(p, pre) == 1) && length(m) >= length(best)) { best = m; fs = $3 } }
    END { print best, fs }' /proc/mounts
}
free_mb() {
  p=$1; while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done
  df -Pk "$p" 2>/dev/null | awk 'NR==2 {print int($4/1024)}'
}

# Run a command as the account that owns the install, from the install directory. npm's cache goes
# under the install directory too: the router's own flash is small, and the default is ~/.npm.
in_dir() {
  cmd="export HOME='${INSTALL_DIR}' npm_config_cache='${INSTALL_DIR}/.npm-cache' NPM_CONFIG_UPDATE_NOTIFIER=false; cd '${INSTALL_DIR}' && $1"
  if [ "$RUN_USER" = root ]; then sh -c "$cmd"; else su -s /bin/sh "$RUN_USER" -c "$cmd"; fi
}

# ---------------------------------------------------------------- is this a machine we can do this on

echo "Frugal IoT server installation - OpenWrt"
[ "$DRY_RUN" = 1 ] && echo "Dry run - nothing will be changed" || echo "Log: ${LOG}"

step "Checking the router"
[ "$(uname -s)" = Linux ] || die "this is $(uname -s), not Linux"
[ "$(id -u)" = 0 ] || die "run this as root - it installs packages and a system service"
if [ -r /etc/openwrt_release ]; then
  . /etc/openwrt_release
  info "${DISTRIB_DESCRIPTION:-OpenWrt}  (${DISTRIB_TARGET:-?}, ${DISTRIB_ARCH:-?})"
elif [ "$FORCE" = 1 ]; then
  warn "not OpenWrt - carrying on because of --force"
  DISTRIB_ARCH=$(uname -m)
else
  die "this does not look like OpenWrt (no /etc/openwrt_release). For Raspberry Pi OS or Debian use install-pi.sh. --force overrides."
fi
[ -n "$PM" ] || die "found neither opkg nor apk"
info "package manager: ${PM}"
[ -r /tmp/sysinfo/model ] && info "board: $(cat /tmp/sysinfo/model)"

case "${DISTRIB_ARCH:-}" in
  x86_64*|aarch64*) ;;
  *) warn "CPU architecture ${DISTRIB_ARCH:-unknown}: node and the sqlite3 module may not exist for it. openwrt-preflight.sh says whether they do." ;;
esac

MEM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
info "memory: $((MEM_KB / 1024)) MB"
if [ "$MEM_KB" -lt 240000 ] && [ "$FORCE" != 1 ]; then die "under 256 MB of memory - the server alone uses about 250 MB. --force overrides."; fi
NPM_FLAGS="--no-audit --no-fund"
[ "$MEM_KB" -lt 1200000 ] && NPM_FLAGS="--maxsockets 1 --no-audit --no-fund"

set -- $(mount_info "$INSTALL_DIR"); DMNT=${1:-/}; DFS=${2:-?}
DFREE=$(free_mb "$INSTALL_DIR"); DFREE=${DFREE:-0}
info "install into ${INSTALL_DIR}: on ${DMNT} (${DFS}), ${DFREE} MB free"
case "$DFS" in
  vfat|exfat|msdos|ntfs|fuseblk)
    die "${INSTALL_DIR} is on ${DFS}, which has no Unix permissions or symlinks. Use an ext4 drive: --dir /mnt/<drive>/frugal-iot" ;;
esac
if [ "$DFREE" -lt 400 ] && [ "$FORCE" != 1 ]; then
  die "only ${DFREE} MB free under ${INSTALL_DIR}; about 400 MB is wanted. Attach a drive and use --dir, or --force."
fi

ask ORG_ID    "Organization id (1-10 lower-case letters or digits, e.g. myfarm)"
echo "$ORG_ID" | grep -qE '^[a-z0-9]{1,10}$' || die "organization id must be 1-10 lower-case letters or digits: '${ORG_ID}'"
ask ORG_NAME  "Organization display name (e.g. My Farm)"
ask ORG_EMAIL "Contact email"
ask ORG_PHONE "Contact phone ('+' and digits only)"
echo "$ORG_PHONE" | grep -qE '^[+]?[0-9]+$' || die "phone must be '+' and digits only: '${ORG_PHONE}'"
for v in "ORG_NAME:$ORG_NAME" "ORG_EMAIL:$ORG_EMAIL" "SUPER_PW:$SUPER_PW" "LOGIN_PW:$LOGIN_PW" "BROKER_PW:$BROKER_PW"; do
  no_quote "${v%%:*}" "${v#*:}"
done

GENERATED=""
[ -n "$SUPER_PW" ] || { SUPER_PW=$(randpw); GENERATED="$GENERATED SUPER_PW"; }
[ -n "$LOGIN_PW" ] || { LOGIN_PW=$(randpw); GENERATED="$GENERATED LOGIN_PW"; }
[ -n "$BROKER_PW" ] || BROKER_PW=$(randpw)

# A router has a fixed LAN address, which beats a ".local" name: that needs umdns installed, and
# Android cannot resolve it at all.
if [ -z "$BROKER_HOST" ]; then
  BROKER_HOST=$(uci -q get network.lan.ipaddr 2>/dev/null | sed 's|/.*||' || true)
  [ -n "$BROKER_HOST" ] || BROKER_HOST=$(ip -4 -o addr show br-lan 2>/dev/null | awk '{print $4}' | sed 's|/.*||' | head -1 || true)
  [ -n "$BROKER_HOST" ] || die "could not work out this router's LAN address - say it with --broker-host"
fi
info "organization: ${ORG_ID} (${ORG_NAME})"
info "broker URL:   ws://${BROKER_HOST}:9012"
info "run as:       ${RUN_USER}"

if [ "$DRY_RUN" = 1 ]; then
  cat <<PLAN

Nothing has been changed. With the same arguments and without --dry-run, this would:
  * install packages: node node-npm zsh sqlite3-cli curl ca-bundle, and mosquitto with its clients
  * npm install frugal-iot-server into ${INSTALL_DIR}
  * point the broker at ws://${BROKER_HOST}:9012, keeping its state under ${MQ_STATE} (not /var,
    which OpenWrt keeps in RAM and empties at every reboot)
  * configure mosquitto, with listeners on 1883 and 9012, then create the superuser and the ${ORG_ID} organization
  * install /etc/init.d/frugaliot (procd) and start it
PLAN
  exit 0
fi

# ---------------------------------------------------------------- packages

step "Installing packages"
info "refreshing the package list"
pkg_update || die "could not refresh the package list - does the router have internet?"

if pkg_installed mosquitto-ssl || pkg_installed mosquitto-nossl; then MQ_PKG=installed
elif pkg_available mosquitto-ssl; then MQ_PKG=mosquitto-ssl
elif pkg_available mosquitto-nossl; then MQ_PKG=mosquitto-nossl
else die "this package feed has neither mosquitto-ssl nor mosquitto-nossl"; fi
case "$MQ_PKG" in
  mosquitto-nossl) MQ_CLIENT=mosquitto-client-nossl ;;
  *)               MQ_CLIENT=mosquitto-client-ssl ;;
esac
[ "$MQ_PKG" = installed ] && MQ_PKG=""; pkg_installed mosquitto-nossl && MQ_CLIENT=mosquitto-client-nossl

info "free space on the router's own flash before: $(free_mb /) MB"
# shellcheck disable=SC2086
pkg_add ca-bundle node node-npm zsh sqlite3-cli curl ${MQ_PKG} ${MQ_CLIENT}
info "free space on the router's own flash after:  $(free_mb /) MB"
# Written to the log on purpose: which mosquitto parts this OpenWrt ships is the main unknown
case "$PM" in
  opkg) info "mosquitto packages in this feed: $(opkg list 2>/dev/null | awk '/^(lib)?mosquitto/ {printf "%s ", $1}')" ;;
  apk)  info "mosquitto packages in this feed: $(apk search mosquitto 2>/dev/null | tr '\n' ' ')" ;;
esac

NODE_VERSION=$(node -v)
info "node ${NODE_VERSION}, npm $(npm -v)"
node_version_ok "$NODE_VERSION" || die "node ${NODE_VERSION} is older than the 20.17 the server needs"
command -v mosquitto_passwd >/dev/null 2>&1 || die "no mosquitto_passwd command after installing mosquitto - the organization's broker account cannot be created"
command -v mosquitto_pub >/dev/null 2>&1 || die "no mosquitto_pub - the broker test cannot run"
ok "packages installed"

# ---------------------------------------------------------------- the account that runs it

step "The account the server runs as"
if [ "$RUN_USER" = root ]; then
  info "root - as most OpenWrt services run. Use --user <name> to run as a separate account."
else
  if id "$RUN_USER" >/dev/null 2>&1; then
    skip "user ${RUN_USER} exists"
  else
    # BusyBox adduser: -D no password, -H no home directory. The shell is /bin/false, so everything
    # run as this account goes through "su -s /bin/sh".
    if command -v adduser >/dev/null 2>&1 && adduser -D -H -s /bin/false -h "$INSTALL_DIR" "$RUN_USER" 2>/dev/null; then :
    elif command -v useradd >/dev/null 2>&1 && useradd -M -s /bin/false -d "$INSTALL_DIR" "$RUN_USER"; then :
    else die "could not create user ${RUN_USER}. Install the 'shadow-useradd' package, or leave --user out to run as root."; fi
    ok "created user ${RUN_USER}"
  fi
fi
mkdir -p "$INSTALL_DIR"
[ "$RUN_USER" = root ] || chown "$RUN_USER" "$INSTALL_DIR"

# ---------------------------------------------------------------- the server

step "Installing the Frugal IoT server"
PKG_DIR="${INSTALL_DIR}/node_modules/frugal-iot-server"
if [ -d "$PKG_DIR" ]; then
  skip "already installed in ${INSTALL_DIR}"
else
  # shellcheck disable=SC2086
  in_dir "npm install ${NPM_FLAGS} frugal-iot-server" || die "npm install failed. The reason is above."
  ok "installed"
fi
info "server $(in_dir "node -e \"console.log(require('${PKG_DIR}/package.json').version)\"")"

step "Checking the compiled part of sqlite3 actually loads"
if in_dir "node -e \"require('sqlite3')\"" >/dev/null 2>&1; then
  ok "sqlite3 loads"
else
  in_dir "node -e \"require('sqlite3')\"" 2>&1 | tail -5 | sed 's/^/    /' || true
  die "sqlite3 will not load on this router. It is a compiled module, and the ready-made binary the server relies on is probably not published for this CPU and C library (OpenWrt uses musl). The messages above are what to send back."
fi

step "Setting up the server's directory"
in_dir "npx --no frugal-iot-init" || die "frugal-iot-init failed"
ok "configuration, directories and database in place"

step "Pointing the server at this router's own broker"
MQTT_YAML="${INSTALL_DIR}/config.d/mqtt.yaml"
CURRENT_BROKER=$(sed -n 's/^broker:[[:space:]]*//p' "$MQTT_YAML" 2>/dev/null | head -1 || true)
WANTED_BROKER="ws://${BROKER_HOST}:9012"
if [ "$CURRENT_BROKER" = "$WANTED_BROKER" ]; then
  skip "broker already ${WANTED_BROKER}"
else
  in_dir "printf '# This router is its own broker - see OPENWRT.md\nbroker: %s\n' '${WANTED_BROKER}' > '${MQTT_YAML}'"
  ok "broker set to ${WANTED_BROKER} (was ${CURRENT_BROKER:-unset})"
fi

# ---------------------------------------------------------------- the broker

step "Configuring the broker"
# Who mosquitto drops to after reading its configuration. Everything it opens afterwards - the
# password file, the ACL, the plugin's state - has to belong to that account.
MQ_CONF=/etc/mosquitto/mosquitto.conf
MQ_USER=$(awk '/^[[:space:]]*user[[:space:]]/ {print $2}' "$MQ_CONF" 2>/dev/null | tail -1 || true)
[ -n "$MQ_USER" ] || MQ_USER=mosquitto
id "$MQ_USER" >/dev/null 2>&1 || { warn "no '${MQ_USER}' account on this router - the broker will use 'nobody'"; MQ_USER=nobody; }
MQ_GROUP=$(id -gn "$MQ_USER")
info "the broker runs as ${MQ_USER}:${MQ_GROUP}"

mkdir -p /etc/mosquitto/conf.d "$MQ_STATE"
chown "$MQ_USER:$MQ_GROUP" "$MQ_STATE"; chmod 700 "$MQ_STATE"

# OpenWrt's /var is /tmp, i.e. RAM. The shipped configuration keeps the password file and the dynamic
# security state in /var/lib/mosquitto, which here would be gone at every reboot - taking every
# account with it - so both are redirected to ${MQ_STATE}.
SRC_CONF="${PKG_DIR}/extras/mosquitto.conf"; [ -f "$SRC_CONF" ] || die "no extras/mosquitto.conf in ${PKG_DIR}"
SRC_ACL="${PKG_DIR}/extras/aclfile";         [ -f "$SRC_ACL" ]  || die "no extras/aclfile in ${PKG_DIR}"

# The main configuration must read conf.d, and must keep its persistence somewhere that survives a
# reboot: retained values are how the dashboard shows something the moment it opens.
if [ ! -f "$MQ_CONF" ]; then
  printf 'user %s\npersistence true\npersistence_location %s/\ninclude_dir /etc/mosquitto/conf.d\n' "$MQ_USER" "$MQ_STATE" > "$MQ_CONF"
  ok "wrote ${MQ_CONF}"
else
  [ -f "${MQ_CONF}.pre-frugal" ] || cp -p "$MQ_CONF" "${MQ_CONF}.pre-frugal"
  grep -qE '^[[:space:]]*include_dir' "$MQ_CONF" || { printf '\ninclude_dir /etc/mosquitto/conf.d\n' >> "$MQ_CONF"; ok "added include_dir to ${MQ_CONF}"; }
  if grep -qE '^[[:space:]]*persistence[[:space:]]' "$MQ_CONF"; then
    sed -i 's/^[[:space:]]*persistence[[:space:]].*/persistence true/' "$MQ_CONF"
  else
    printf 'persistence true\n' >> "$MQ_CONF"
  fi
  PLOC=$(awk '/^[[:space:]]*persistence_location[[:space:]]/ {print $2}' "$MQ_CONF" | tail -1)
  case "$PLOC" in
    ""|/tmp*|/var/*|/run/*)
      if [ -n "$PLOC" ]; then sed -i "s|^[[:space:]]*persistence_location[[:space:]].*|persistence_location ${MQ_STATE}/|" "$MQ_CONF"
      else printf 'persistence_location %s/\n' "$MQ_STATE" >> "$MQ_CONF"; fi
      ok "persistence moved from '${PLOC:-unset}' to ${MQ_STATE}/ so it survives a reboot (original saved as ${MQ_CONF}.pre-frugal)" ;;
    *) skip "persistence already at ${PLOC}" ;;
  esac
fi

# The ACL goes in first: the configuration names it, and the broker will not start without it
if [ ! -e /etc/mosquitto/aclfile ]; then
  install -o "$MQ_USER" -g "$MQ_GROUP" -m 600 "$SRC_ACL" /etc/mosquitto/aclfile
  ok "access control list installed"
else
  T1=$(mktemp); T2=$(mktemp)
  grep -vE '^[[:space:]]*(#|$)' "$SRC_ACL" > "$T1" || true
  grep -vE '^[[:space:]]*(#|$)' /etc/mosquitto/aclfile > "$T2" || true
  ACL_MISSING=$(grep -vxFf "$T2" "$T1" || true)
  ACL_ADDED=$(grep -cE '^[[:space:]]*user[[:space:]]' /etc/mosquitto/aclfile || true)
  rm -f "$T1" "$T2"
  if [ -z "$ACL_MISSING" ]; then skip "/etc/mosquitto/aclfile already has every rule this release ships"
  elif [ "${ACL_ADDED:-0}" = 0 ]; then
    install -o "$MQ_USER" -g "$MQ_GROUP" -m 600 "$SRC_ACL" /etc/mosquitto/aclfile
    ok "access control list brought up to date"
  else
    warn "/etc/mosquitto/aclfile is missing rules this release ships and holds ${ACL_ADDED} added by hand, which replacing it would delete. Add these yourself:"
    echo "$ACL_MISSING" | sed 's/^/        /'
  fi
fi

# The dynamic security plugin, if this mosquitto has one
DYNSEC_SO=""
for cand in /usr/lib/mosquitto/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so \
            /usr/lib/*/mosquitto_dynamic_security.so /usr/lib/*/mosquitto/mosquitto_dynamic_security.so; do
  [ -f "$cand" ] && { DYNSEC_SO=$cand; break; }
done
DYNSEC_JSON="${MQ_STATE}/dynamic-security.json"
SECRETS="${INSTALL_DIR}/config.d/secrets.yaml"
if [ -z "$DYNSEC_SO" ]; then
  warn "no mosquitto dynamic security plugin on this router. The broker will run on the organization's"
  warn "  shared password instead: every node and browser uses the same credential. It works, but it"
  warn "  is the older and weaker scheme. Tell whoever sent you this - it matters."
elif ! command -v mosquitto_ctrl >/dev/null 2>&1; then
  warn "the plugin is there (${DYNSEC_SO}) but there is no mosquitto_ctrl to initialise it - carrying on without it"
  DYNSEC_SO=""
elif [ -f "$DYNSEC_JSON" ]; then
  if grep -q '^dynsec_admin_password:' "$SECRETS" 2>/dev/null; then skip "dynamic security already initialised"
  else
    warn "${DYNSEC_JSON} exists but ${SECRETS} has no dynsec_admin_password - a previous run stopped between the two."
    warn "  Remove ${DYNSEC_JSON} and run this again."
    DYNSEC_SO=""
  fi
else
  DYNSEC_PW=$(randpw)
  if printf '%s\n%s\n' "$DYNSEC_PW" "$DYNSEC_PW" | mosquitto_ctrl dynsec init "$DYNSEC_JSON" frugal-admin >/dev/null 2>&1 && [ -s "$DYNSEC_JSON" ]; then
    chown "$MQ_USER:$MQ_GROUP" "$DYNSEC_JSON"; chmod 600 "$DYNSEC_JSON"
    {
      echo ""
      echo "# The broker account the server uses to create and remove other accounts, over"
      echo "# \$CONTROL/dynamic-security/v1. Created by install-openwrt.sh."
      echo "dynsec_admin_user: \"frugal-admin\""
      echo "dynsec_admin_password: \"${DYNSEC_PW}\""
    } >> "$SECRETS"
    chmod 600 "$SECRETS"; [ "$RUN_USER" = root ] || chown "$RUN_USER" "$SECRETS"
    ok "dynamic security initialised; admin credential saved to config.d/secrets.yaml"
  else
    warn "mosquitto_ctrl dynsec init failed - continuing without it"
    rm -f "$DYNSEC_JSON"; DYNSEC_SO=""
  fi
fi

# The shipped configuration, with the plugin path and the state directory filled in
TMP_CONF=$(mktemp)
if [ -n "$DYNSEC_SO" ]; then
  sed -e "s|^plugin PLUGIN_PATH_SET_BY_INSTALLER|plugin ${DYNSEC_SO}|" \
      -e "s|/var/lib/mosquitto/|${MQ_STATE}/|g" "$SRC_CONF" > "$TMP_CONF"
else
  sed -e "s|^plugin PLUGIN_PATH_SET_BY_INSTALLER|#plugin (not installed)|" \
      -e "s|^plugin_opt_config_file|#plugin_opt_config_file|" \
      -e "s|/var/lib/mosquitto/|${MQ_STATE}/|g" "$SRC_CONF" > "$TMP_CONF"
fi
if cmp -s "$TMP_CONF" /etc/mosquitto/conf.d/frugal-iot.conf 2>/dev/null; then
  skip "/etc/mosquitto/conf.d/frugal-iot.conf already current"
else
  install -o root -g root -m 644 "$TMP_CONF" /etc/mosquitto/conf.d/frugal-iot.conf
  ok "configuration installed at /etc/mosquitto/conf.d/frugal-iot.conf"
fi
rm -f "$TMP_CONF"

PWFILE=$(grep -hE '^[[:space:]]*password_file[[:space:]]' /etc/mosquitto/conf.d/frugal-iot.conf | tail -1 | awk '{print $2}' || true)
[ -n "$PWFILE" ] || die "no password_file line in /etc/mosquitto/conf.d/frugal-iot.conf"
if [ -f "$PWFILE" ]; then skip "password file ${PWFILE} exists"
else install -o "$MQ_USER" -g "$MQ_GROUP" -m 600 /dev/null "$PWFILE"; ok "empty password file created at ${PWFILE}"; fi

# Everything the broker opens after dropping privileges must be its own. mosquitto_passwd run as
# root rewrites the password file as root, and the broker then cannot read it - so this is repeated
# after each step below that touches it.
fix_broker_files() {
  [ -e "$PWFILE" ] && { chown "$MQ_USER:$MQ_GROUP" "$PWFILE"; chmod 600 "$PWFILE"; }
  [ -e "$DYNSEC_JSON" ] && { chown "$MQ_USER:$MQ_GROUP" "$DYNSEC_JSON"; chmod 600 "$DYNSEC_JSON"; }
  [ -e /etc/mosquitto/aclfile ] && { chown "$MQ_USER:$MQ_GROUP" /etc/mosquitto/aclfile; chmod 600 /etc/mosquitto/aclfile; }
  return 0
}
broker_listening() { netstat -ln 2>/dev/null | grep -q "[:.]$1 "; }
restart_broker() {
  fix_broker_files
  /etc/init.d/mosquitto enable
  /etc/init.d/mosquitto restart
  sleep 3
  if ! pidof mosquitto >/dev/null 2>&1; then
    echo "Mosquitto did not start. What it logged:" >&2
    logread -e mosquitto 2>/dev/null | tail -15 >&2 || true
    die "the broker is not running (see above)"
  fi
  broker_listening 1883 || die "the broker is running but not listening on 1883"
  broker_listening 9012 || die "the broker is running but not listening on 9012 - its websockets listener. This mosquitto build probably has no websockets support, and the browser dashboard cannot work without it."
}
restart_broker
ok "broker running, listening on 1883 and 9012"

# ---------------------------------------------------------------- accounts

step "Creating the administrator login"
if in_dir "sqlite3 frugal-iot.db \"SELECT 1 FROM users WHERE username='superuser' AND hashed_password IS NOT NULL;\"" | grep -q 1; then
  skip "superuser already has a password"
else
  in_dir "npx --no frugal-iot-setpassword superuser '${SUPER_PW}'" >/dev/null
  ok "superuser password set"
fi

step "Creating the organization"
if [ -f "${INSTALL_DIR}/config.d/organizations/${ORG_ID}.yaml" ]; then
  skip "organization ${ORG_ID} already exists"
  BROKER_PW=$(sed -n 's/^mqtt_password:[[:space:]]*//p' "${INSTALL_DIR}/config.d/organizations/${ORG_ID}.yaml" | head -1 | tr -d "\"'" || true)
  info "using the broker password already in its configuration"
else
  in_dir "npx --no frugal-iot-addorganization '${ORG_ID}' '${ORG_NAME}' '${ORG_EMAIL}' '${ORG_PHONE}' '${BROKER_PW}'"
  fix_broker_files
  ok "organization ${ORG_ID} created"
  # addorganization set the web login password to the broker password; they are for different things
  in_dir "npx --no frugal-iot-setpassword '${ORG_ID}' '${LOGIN_PW}'" >/dev/null
  ok "web login password for ${ORG_ID} set, different from the broker password"
fi
/etc/init.d/mosquitto restart   # so it re-reads the password file
sleep 3

step "Creating the broker's roles and groups"
if [ -n "$DYNSEC_SO" ]; then
  in_dir "npx --no frugal-iot-rebuild-dynsec"
  ok "roles and groups built from the database"
else
  skip "no dynamic security plugin, so there are no groups to build"
fi

step "Testing the broker end to end"
TEST_TOPIC="${ORG_ID}/installtest/hello"
SUB_OUT=$(mktemp)
mosquitto_sub -h localhost -u "$ORG_ID" -P "$BROKER_PW" -t "$TEST_TOPIC" -C 1 -W 10 > "$SUB_OUT" 2>&1 &
SUB_PID=$!
sleep 2
mosquitto_pub -h localhost -u "$ORG_ID" -P "$BROKER_PW" -t "$TEST_TOPIC" -m '42' || true
wait "$SUB_PID" 2>/dev/null || true
if grep -qx '42' "$SUB_OUT"; then
  ok "published and received on ${TEST_TOPIC}"
else
  echo "The broker did not deliver a test message. It said:" >&2
  cat "$SUB_OUT" >&2
  rm -f "$SUB_OUT"
  die "broker test failed"
fi
rm -f "$SUB_OUT"

# ---------------------------------------------------------------- the service

step "Running the server as a service"
# procd, not systemd. It has no "working directory" setting, so the command changes directory itself,
# and "respawn 3600 10 0" restarts the server for ever, ten seconds after each exit. Output goes to
# the system log: read it with "logread -e frugaliot".
USER_LINE=""
[ "$RUN_USER" = root ] || USER_LINE="  procd_set_param user ${RUN_USER}"
TMP_INIT=$(mktemp)
cat > "$TMP_INIT" <<INIT
#!/bin/sh /etc/rc.common
# Written by install-openwrt.sh. The Frugal IoT server.
START=95
STOP=10
USE_PROCD=1

start_service() {
  procd_open_instance
  procd_set_param command /bin/sh -c "cd '${INSTALL_DIR}' && exec '${INSTALL_DIR}/node_modules/.bin/frugal-iot-server'"
${USER_LINE}
  procd_set_param env HOME='${INSTALL_DIR}'
  procd_set_param respawn 3600 10 0
  procd_set_param stdout 1
  procd_set_param stderr 1
  procd_close_instance
}
INIT
if cmp -s "$TMP_INIT" /etc/init.d/frugaliot 2>/dev/null; then
  skip "/etc/init.d/frugaliot already current"
else
  install -o root -g root -m 755 "$TMP_INIT" /etc/init.d/frugaliot
  ok "/etc/init.d/frugaliot installed, running as ${RUN_USER} from ${INSTALL_DIR}"
fi
rm -f "$TMP_INIT"
/etc/init.d/frugaliot enable
/etc/init.d/frugaliot restart

step "Checking the server answers"
PORT=$(sed -n 's/^port:[[:space:]]*//p' "${INSTALL_DIR}/config.d/server.yaml" 2>/dev/null | head -1 || true)
PORT=${PORT:-8080}
CODE=""; i=0
while [ "$i" -lt 20 ]; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://localhost:${PORT}/" || true)
  [ "$CODE" = 200 ] && break
  sleep 2; i=$((i+1))
done
if [ "$CODE" = 200 ]; then
  ok "http://localhost:${PORT}/ answered 200"
else
  echo "The server is not answering on port ${PORT} (last response: ${CODE:-none}). What it logged:" >&2
  logread -e frugaliot 2>/dev/null | tail -30 >&2 || true
  die "server not answering"
fi
ls /etc/rc.d/ 2>/dev/null | grep -q 'frugaliot$' && ok "will start again at boot"

# ---------------------------------------------------------------- what is left to do

ENROL_SECRET=$(grep -A1 "^enrolment_${ORG_ID}:" "$SECRETS" 2>/dev/null | tail -1 | sed -e 's/^[[:space:]]*-[[:space:]]*//' -e 's/^"//' -e 's/"$//' || true)

shown() { case " $GENERATED " in *" $1 "*) eval "echo \"\$$1\"" ;; *) echo "(the one you gave)" ;; esac; }

cat <<SUMMARY

=======================================================================
 Frugal IoT is installed and running.
=======================================================================

 Dashboard      http://${BROKER_HOST}:${PORT}/

 Logins         superuser / $(shown SUPER_PW)
                ${ORG_ID} / $(shown LOGIN_PW)
 (Change either with: cd ${INSTALL_DIR} && npx --no frugal-iot-setpassword <login> "<password>")

 Broker         ws://${BROKER_HOST}:9012        for browsers
                ${BROKER_HOST}:1883             for sensor nodes

 Installed in   ${INSTALL_DIR}, running as ${RUN_USER}
 Log of this run ${LOG}   (readable only by root; any generated password above is in it)

 Still to do:

 1. A project. Create one on the dashboard before flashing any node: a node says which project
    it is in, and enrolling into one this server does not know is refused.

 2. Your sensor nodes. In the PlatformIO project's platformio-secrets-local.ini:

        build_flags_local =
            '-D SYSTEM_FRUGAL_ORG="${ORG_ID}"'
            '-D SYSTEM_FRUGAL_PROJECT="<the project from 1>"'
            '-D SYSTEM_MQTT_HOST="${BROKER_HOST}"'
            '-D SYSTEM_MQTT_ENROL_URL="http://${BROKER_HOST}:${PORT}/enrol"'
            '-D SYSTEM_MQTT_ENROL_SECRET="${ENROL_SECRET:-see the dashboard, gear icon -> Nodes}"'

    http and not https, because this router has no certificate yet, so no over-the-air updates.

 3. The firewall. By default OpenWrt accepts connections from the LAN and refuses them from the
    WAN, which is what you want: do NOT forward or open ports 1883, 9012 or ${PORT} to the internet.

 Useful:
     logread -e frugaliot        the server's log
     logread -e mosquitto        the broker's log
     service frugaliot restart
     cd ${INSTALL_DIR} && npx --no frugal-iot-diagnostic     (written for systemd; parts of it will
                                                              report things that do not apply here)

SUMMARY

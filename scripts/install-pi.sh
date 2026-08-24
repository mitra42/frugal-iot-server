#!/usr/bin/env bash
#
# Install a complete Frugal IoT server - broker, server, service - on a freshly flashed Raspberry Pi.
#
# This does automatically what INSTALLATION.md walks through by hand, steps 3 to 8. Read that if you
# want to know why any of it is being done; this only says what it is doing as it goes.
#
#   curl -fsSLO https://raw.githubusercontent.com/mitra42/frugal-iot-server/main/scripts/install-pi.sh
#   bash install-pi.sh --org myfarm --name "My Farm" --email you@example.com --phone +61123456789
#
# Written in bash on purpose: a fresh Raspberry Pi OS Lite image has no zsh, which the server's own
# setup commands need, so this cannot be a zsh script - it is what installs zsh.
#
# Anything not given on the command line is asked for, or made up where that is reasonable
# (passwords). With --yes it never asks and invents whatever is missing, for an unattended run.
#
# Safe to run again. Every step checks whether it has already been done, so a run that stopped
# half way - or was interrupted by the board running out of memory, which a Pi Zero W will do -
# carries on from where it got to rather than starting over. That matters most for the one slow
# step: compiling sqlite3 on a Zero W takes about 40 minutes and is not repeated once it is done.
#
# What it does NOT do:
#   * flash the SD card, or set up wifi - INSTALLATION.md steps 1 and 2, before you can ssh in
#   * point your sensor nodes at this server - that means flashing the nodes, which happens on your
#     workstation, not here. It prints the settings to give them.
#   * HTTPS, which over-the-air firmware updates to ESP32 need - INSTALLATION.md step 10
#   * reboot. A reboot is worth doing afterwards if the upgrade brought a new kernel.

set -Eeuo pipefail

# ---------------------------------------------------------------- settings and arguments

ORG_ID=""; ORG_NAME=""; ORG_EMAIL=""; ORG_PHONE=""
BROKER_PW=""; SUPER_PW=""; LOGIN_PW=""; BROKER_HOST=""
INSTALL_DIR=""; RUN_USER=""; ASSUME_YES=0; DRY_RUN=0; RANDOM_PASSWORDS=0

usage() {
  cat <<USAGE
Usage: bash install-pi.sh [options]

  --org <id>           organization id, 1-10 lower-case letters or digits. Becomes the first part
                       of every MQTT topic, so it must match what your nodes publish to.
  --name "<name>"      organization display name
  --email <address>    contact address for the organization
  --phone <number>     contact phone, "+" and digits only
  --broker-password    the machine credential shared by the server, nodes and dashboards.
  --superuser-password password for this server's administrator login.
  --login-password     web login password for the organization's own account, which is a different
                       thing from the broker credential above and should not be the same string.
                       Any of these three not given is asked for, and generated if you just press
                       Enter, or if there is no terminal to ask at.
  --broker-host <host> what the browser and the nodes should call this Pi.
                       Default: this Pi's hostname with ".local". Use an IP address if you will
                       view the dashboard on Android, which cannot resolve ".local" names.
  --dir <path>         where to install. Default: ~/frugal-iot of the user running this.
  --user <name>        account to own and run the server. Default: whoever invoked this.
  --yes                never ask anything; invent whatever was not given.
  --random-passwords   generate the passwords instead of asking, even at a terminal.
  --dry-run            work out what would be done, check the arguments, and stop before
                       changing anything. Also the way to see the generated passwords first.
  --help
USAGE
  exit "${1:-0}"
}

while (( $# )); do
  case "$1" in
    --org)                 ORG_ID="${2:-}"; shift 2 ;;
    --name)                ORG_NAME="${2:-}"; shift 2 ;;
    --email)               ORG_EMAIL="${2:-}"; shift 2 ;;
    --phone)               ORG_PHONE="${2:-}"; shift 2 ;;
    --broker-password)     BROKER_PW="${2:-}"; shift 2 ;;
    --superuser-password)  SUPER_PW="${2:-}"; shift 2 ;;
    --login-password)      LOGIN_PW="${2:-}"; shift 2 ;;
    --broker-host)         BROKER_HOST="${2:-}"; shift 2 ;;
    --dir)                 INSTALL_DIR="${2:-}"; shift 2 ;;
    --user)                RUN_USER="${2:-}"; shift 2 ;;
    --yes|-y)              ASSUME_YES=1; shift ;;
    --dry-run)             DRY_RUN=1; shift ;;
    --random-passwords)    RANDOM_PASSWORDS=1; shift ;;
    --help|-h)             usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

# ---------------------------------------------------------------- who this runs as
# npm must not run as root: it would leave root-owned files in the install directory, and the
# service runs as an ordinary user, so the server would then be unable to write its own database.
# Being invoked with sudo is fine and expected - the user-level parts are handed back to the
# account that called it.

if [[ -z "$RUN_USER" ]]; then
  if [[ ${EUID} -eq 0 ]]; then
    RUN_USER="${SUDO_USER:-}"
    if [[ -z "$RUN_USER" ]]; then
      echo "Running as root with no SUDO_USER to hand back to." >&2
      echo "Either run this as your ordinary account (it will use sudo where it needs to)," >&2
      echo "or say which account should own the server:  --user pi" >&2
      exit 1
    fi
  else
    RUN_USER="$(id -un)"
  fi
fi
id "$RUN_USER" >/dev/null 2>&1 || { echo "No such user: $RUN_USER" >&2; exit 1; }
if command -v getent >/dev/null 2>&1; then
  RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
else
  RUN_HOME="$(eval echo "~${RUN_USER}")"   # no getent outside linux; only reached on the wrong OS
fi
[[ -n "$RUN_HOME" ]] || { echo "Could not find the home directory of ${RUN_USER}" >&2; exit 1; }
[[ -n "$INSTALL_DIR" ]] || INSTALL_DIR="${RUN_HOME}/frugal-iot"

# Run a command as the owning account, or straight through if that is already us
as_user() {
  if [[ "$(id -un)" == "$RUN_USER" ]]; then
    "$@"
  else
    sudo -u "$RUN_USER" -H "$@"
  fi
}
# Same, but for something that has to be a shell line (cd, pipes, redirection)
as_user_sh() {
  if [[ "$(id -un)" == "$RUN_USER" ]]; then
    bash -c "$1"
  else
    sudo -u "$RUN_USER" -H bash -c "$1"
  fi
}
# sudo, or nothing if we are already root
sudo_() { if [[ ${EUID} -eq 0 ]]; then "$@"; else sudo "$@"; fi; }

# ---------------------------------------------------------------- logging

if (( DRY_RUN )); then
  LOG=/dev/null      # --dry-run changes nothing, and that includes not leaving a log behind
else
  LOG="${RUN_HOME}/frugal-iot-install-$(date +%Y%m%d-%H%M%S).log"
  touch "$LOG"; chmod 600 "$LOG"; chown "$RUN_USER" "$LOG" 2>/dev/null || true
  # Everything from here on goes to the terminal and to the log. The log holds the passwords, which
  # is why it is readable only by its owner.
  exec > >(tee -a "$LOG") 2>&1
fi

STEP_N=0
step()  { STEP_N=$((STEP_N+1)); echo; echo "=== ${STEP_N}. $* ==="; }
info()  { echo "    $*"; }
ok()    { echo "    ok: $*"; }
skip()  { echo "    already done: $*"; }
warn()  { echo "    WARNING: $*"; }

on_error() {
  local line=$1
  echo
  echo "=== Stopped at line ${line} ==="
  echo "Nothing after this point has been done."
  if [[ "$LOG" != /dev/null ]]; then
    echo "The log of this run is:"
    echo "    ${LOG}"
  fi
  echo
  echo "Run it again once the cause is dealt with - the steps that succeeded are not repeated."
  if [[ -x "${INSTALL_DIR}/node_modules/.bin/frugal-iot-diagnostic" ]]; then
    echo "For what state the installation is in now:"
    echo "    cd ${INSTALL_DIR} && npx --no frugal-iot-diagnostic"
  fi
  exit 1
}
trap 'on_error $LINENO' ERR

randpw() { ( set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16 ); }

REBOOT_REASONS=()

# Size and modification time of every kernel and initrd image, so that the upgrade replacing one can
# be noticed. /boot/firmware is where Raspberry Pi OS keeps them from Debian 12 on, /boot before that.
boot_fingerprint() {
  local f
  for f in /boot/*.img /boot/vmlinuz* /boot/initrd* /boot/firmware/*.img /boot/firmware/vmlinuz* /boot/firmware/initrd*; do
    [[ -e "$f" ]] || continue
    printf '%s %s\n' "$f" "$(stat -c '%Y:%s' "$f" 2>/dev/null || echo '?')"
  done | sort
}

# Which passwords were made up rather than given, so the summary can print those and leave the ones
# you already know out of the log
GENERATED=()

ask_password() { # ask_password <variable name> <what it is for>
  local var=$1 what=$2
  if [[ -n "${!var}" ]]; then
    return 0                      # given on the command line
  fi
  if (( RANDOM_PASSWORDS )) || (( ASSUME_YES )) || [[ ! -t 0 ]]; then
    printf -v "$var" '%s' "$(randpw)"
    GENERATED+=("$var")
    info "generated a password for ${what}$( [[ -t 0 ]] || echo ' (no terminal to ask at)' )"
    return 0
  fi
  # Prompt and reply both go straight to the terminal rather than through the log: nothing typed
  # here is echoed, and nothing typed here is written to the log either. Going via stdout would also
  # mean the prompt queued behind tee. Empty means "make one up", which is the quickest answer for
  # the broker credential - a machine password nobody wants to type twice.
  local first second
  while true; do
    printf '    Password for %s\n      (or press Enter to have one generated): ' "$what" > /dev/tty
    read -rs first < /dev/tty; printf '\n' > /dev/tty
    if [[ -z "$first" ]]; then
      printf -v "$var" '%s' "$(randpw)"
      GENERATED+=("$var")
      info "generated a password for ${what}"
      return 0
    fi
    printf '      Again, to be sure: ' > /dev/tty
    read -rs second < /dev/tty; printf '\n' > /dev/tty
    if [[ "$first" == "$second" ]]; then
      printf -v "$var" '%s' "$first"
      info "took the password you typed for ${what}"
      return 0
    fi
    printf '      Those did not match - try again.\n' > /dev/tty
  done
}

ask() { # ask <variable name> <prompt> [generated]
  local var=$1 prompt=$2 generate=${3:-}
  local current="${!var}"
  [[ -n "$current" ]] && return 0
  if [[ -n "$generate" ]]; then
    printf -v "$var" '%s' "$(randpw)"
    return 0
  fi
  if (( ASSUME_YES )) || [[ ! -t 0 ]]; then
    echo "Nothing given for '${prompt}', and there is no terminal to ask at (or --yes was given)." >&2
    echo "Pass it on the command line - see --help." >&2
    return 1
  fi
  local reply
  read -r -p "    ${prompt}: " reply
  printf -v "$var" '%s' "$reply"
  [[ -n "${!var}" ]] || { echo "That cannot be empty" >&2; return 1; }
}

echo "Frugal IoT server installation"
(( DRY_RUN )) && echo "Dry run - nothing will be changed" || echo "Log: ${LOG}"

# Everything below assumes a Debian with systemd - Raspberry Pi OS, or Debian/Ubuntu on anything
# else. Say so now rather than failing obscurely four steps in.
MISSING_PLATFORM=()
[[ "$(uname -s)" == "Linux" ]] || MISSING_PLATFORM+=("this is $(uname -s), not Linux")
command -v apt-get   >/dev/null 2>&1 || MISSING_PLATFORM+=("no apt-get")
command -v systemctl >/dev/null 2>&1 || MISSING_PLATFORM+=("no systemctl")
if (( ${#MISSING_PLATFORM[@]} )); then
  if (( DRY_RUN )); then
    warn "not a Debian with systemd (${MISSING_PLATFORM[*]}) - checking the arguments anyway"
  else
    echo "This installs onto a Debian system with systemd - Raspberry Pi OS, or Debian or Ubuntu." >&2
    printf '  %s\n' "${MISSING_PLATFORM[@]}" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------- what we are installing

step "Working out what to install"

if [[ -r /etc/os-release ]]; then
  info "os:      $(sed -n 's/^PRETTY_NAME="\(.*\)"$/\1/p' /etc/os-release)"
fi
[[ -r /proc/device-tree/model ]] && info "board:   $(tr -d '\0' < /proc/device-tree/model)"
ARCH="$(uname -m)"
MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
info "arch:    ${ARCH}, memory: $((MEM_KB / 1024)) MB"

# A 32-bit ARMv6 board (Pi Zero W, Pi 1) has no ready-made sqlite3 binary, so it has to compile it,
# which needs a compiler and more memory than the board has.
NEEDS_BUILD_TOOLS=0
NPM_SLOW_FLAGS=()
case "$ARCH" in
  armv6l|armv7l) NEEDS_BUILD_TOOLS=1; NPM_SLOW_FLAGS=(--maxsockets 1 --no-audit --no-fund) ;;
esac
if (( MEM_KB > 0 && MEM_KB < 700000 )); then NEEDS_SWAP=1; else NEEDS_SWAP=0; fi
(( NEEDS_BUILD_TOOLS )) && info "32-bit ARM: sqlite3 will be compiled, which is slow (allow 40 minutes on a Zero W)"
(( NEEDS_SWAP ))        && info "under 700 MB of memory: a swap file will be added so the install can finish"

ask ORG_ID    "Organization id (1-10 lower-case letters or digits, e.g. myfarm)" || exit 1
[[ "$ORG_ID" =~ ^[a-z0-9]{1,10}$ ]] || { echo "Organization id must be 1-10 lower-case letters or digits: '${ORG_ID}'" >&2; exit 1; }
ask ORG_NAME  "Organization display name (e.g. My Farm)" || exit 1
ask ORG_EMAIL "Contact email" || exit 1
ask ORG_PHONE "Contact phone ('+' and digits only)" || exit 1
[[ "$ORG_PHONE" =~ ^[+]?[0-9]+$ ]] || { echo "Phone must be '+' and digits only: '${ORG_PHONE}'" >&2; exit 1; }
# Asked for in the order they matter. Each may be typed, passed as an option, or generated.
ask_password SUPER_PW  "the superuser login (this server's administrator)"
ask_password LOGIN_PW  "the ${ORG_ID} web login"
ask_password BROKER_PW "the ${ORG_ID} broker credential, shared by the nodes and dashboards"
[[ -n "$BROKER_HOST" ]] || BROKER_HOST="$(hostname).local"

info "install into:  ${INSTALL_DIR}  (owned by ${RUN_USER})"
info "organization:  ${ORG_ID} (${ORG_NAME})"
info "broker URL:    ws://${BROKER_HOST}:9012"

if (( DRY_RUN )); then
  cat <<PLAN

Nothing has been changed. With the same arguments and without --dry-run, this would:
  * apt update, full-upgrade, and install: nodejs npm sqlite3 zsh curl$( (( NEEDS_BUILD_TOOLS )) && echo " build-essential python3-dev python3-setuptools" )
  * cap the systemd journal at 16M and set vm.swappiness=1
$( (( NEEDS_SWAP )) && echo "  * add a 2G swap file, because this board has under 700 MB of memory" )
  * npm install frugal-iot-server into ${INSTALL_DIR} as ${RUN_USER}$( (( NEEDS_BUILD_TOOLS )) && echo ", compiling sqlite3 (slow)" )
  * set the broker to ws://${BROKER_HOST}:9012
  * install and configure mosquitto, with listeners on 1883 and 9012
  * create the superuser login and the ${ORG_ID} organization, and test the broker
  * install and start the frugaliot service, running as ${RUN_USER}

Passwords it would use. A generated one is different on every run, so pass it or type it if you
want this exact set. All of them are shown here because a dry run writes no log; a real run prints
only the generated ones, so the ones you chose stay out of the log:
$(printf '  %-22s %s\n' "superuser login" "${SUPER_PW}" "${ORG_ID} web login" "${LOGIN_PW}" "${ORG_ID} broker" "${BROKER_PW}")
PLAN
  exit 0
fi

# ---------------------------------------------------------------- the system

step "Updating the operating system"
sudo_ apt-get update -qq
# What is about to be upgraded, asked for before doing it: "-s" simulates, and each package it would
# install shows up as an "Inst" line. Doing it this way rather than reading the real output means the
# upgrade itself can stay quiet.
UPGRADE_PLAN="$(sudo_ apt-get -s full-upgrade 2>/dev/null | awk '/^Inst /{print $2}' | sort -u || true)"
BOOT_BEFORE="$(boot_fingerprint)"
# No reboot here even if this brings a new kernel, so that the run can continue unattended. Whether
# one is needed is worked out below and said plainly in the summary.
sudo_ env DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y -qq
if [[ -n "$UPGRADE_PLAN" ]]; then
  info "upgraded: $(echo "$UPGRADE_PLAN" | wc -l | tr -d ' ') package(s)"
else
  info "nothing needed upgrading"
fi
ok "system up to date"

# The running kernel is whatever was loaded at boot; replacing the file on disk does not change it.
# Three ways to notice, because no single one is reliable on every image:
#   * a kernel or firmware package in the upgrade list
#   * the boot images on disk having changed underneath us
#   * /var/run/reboot-required, which only appears if update-notifier-common is installed - it is
#     not on a Lite image, which is why the other two matter
if [[ -n "$UPGRADE_PLAN" ]]; then
  KERNEL_PKGS="$(echo "$UPGRADE_PLAN" | grep -E '^(linux-image|linux-headers|linux-firmware|raspberrypi-kernel|raspberrypi-bootloader|raspi-firmware)' || true)"
  [[ -n "$KERNEL_PKGS" ]] && REBOOT_REASONS+=("a new kernel or boot firmware was installed: $(echo "$KERNEL_PKGS" | tr '\n' ' ')")
  CORE_PKGS="$(echo "$UPGRADE_PLAN" | grep -E '^(libc6|libssl[0-9]|systemd)$' || true)"
  [[ -n "$CORE_PKGS" ]] && REBOOT_REASONS+=("core libraries were replaced, and running programs still have the old ones in memory: $(echo "$CORE_PKGS" | tr '\n' ' ')")
fi
if [[ "$(boot_fingerprint)" != "$BOOT_BEFORE" ]]; then
  REBOOT_REASONS+=("the kernel images in /boot changed, so the kernel running now is not the one on disk")
fi
[[ -f /var/run/reboot-required ]] && REBOOT_REASONS+=("the system itself asked for one (/var/run/reboot-required)")
if (( ${#REBOOT_REASONS[@]} )); then
  warn "a reboot will be needed when this finishes - the summary says so again"
else
  ok "no reboot needed: the kernel running now is the one on disk"
fi

step "Installing the packages the server needs"
PACKAGES=(nodejs npm sqlite3 zsh curl)
(( NEEDS_BUILD_TOOLS )) && PACKAGES+=(build-essential python3-dev python3-setuptools)
sudo_ env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${PACKAGES[@]}"
NODE_VERSION="$(node -v)"
info "node ${NODE_VERSION}, npm $(npm -v), sqlite3 $(sqlite3 --version | awk '{print $1}')"
# The server needs node 18 or later
NODE_MAJOR="$(echo "${NODE_VERSION#v}" | cut -d. -f1)"
if (( NODE_MAJOR < 18 )); then
  echo "node ${NODE_VERSION} is too old - the server needs 18 or later." >&2
  echo "Install a current version from https://github.com/nodesource/distributions and run this again." >&2
  exit 1
fi
ok "packages installed"

step "Settings that make the SD card last longer"
# The journal would otherwise be allowed to grow to a tenth of the card, and every line in it is a
# write; swapping to an SD card wears it out fastest of all.
if [[ -f /etc/systemd/journald.conf.d/frugal-iot.conf ]]; then
  skip "journal size already capped"
else
  sudo_ mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nSystemMaxUse=16M\nSystemMaxFileSize=4M\n' | sudo_ tee /etc/systemd/journald.conf.d/frugal-iot.conf >/dev/null
  sudo_ systemctl restart systemd-journald
  ok "journal capped at 16M"
fi
if [[ -f /etc/sysctl.d/99-frugal-iot-swappiness.conf ]]; then
  skip "swappiness already set"
else
  echo 'vm.swappiness=1' | sudo_ tee /etc/sysctl.d/99-frugal-iot-swappiness.conf >/dev/null
  sudo_ sysctl -q -w vm.swappiness=1
  ok "swappiness set to 1 (swap only as a last resort)"
fi

if (( NEEDS_SWAP )); then
  step "Adding swap, so the install can finish on a small board"
  if [[ -f /swapfile ]]; then
    skip "/swapfile exists"
    swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile || sudo_ swapon /swapfile
  else
    # zram alone is not enough here: compressed RAM does not help when the working set is genuinely
    # large, and without this the board stops answering ssh and has to have its power pulled.
    sudo_ fallocate -l 2G /swapfile
    sudo_ chmod 600 /swapfile
    sudo_ mkswap -q /swapfile
    sudo_ swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo_ tee -a /etc/fstab >/dev/null
    ok "2G swap file added and enabled"
  fi
  info "swap now: $(free -h | awk '/^Swap:/ {print $3 " used of " $2}')"
fi

# ---------------------------------------------------------------- the server

step "Installing the Frugal IoT server"
as_user mkdir -p "$INSTALL_DIR"
if [[ -d "${INSTALL_DIR}/node_modules/frugal-iot-server" ]]; then
  skip "already installed in ${INSTALL_DIR}"
else
  if (( NEEDS_BUILD_TOOLS )); then
    info "this is the slow part - sqlite3 is compiled here. Leave it running."
  fi
  as_user_sh "cd '${INSTALL_DIR}' && npm install ${NPM_SLOW_FLAGS[*]:-} frugal-iot-server"
  ok "installed"
fi
info "server $(as_user_sh "node -e \"console.log(require('${INSTALL_DIR}/node_modules/frugal-iot-server/package.json').version)\"")"

step "Checking the compiled part of sqlite3 actually built"
# npm can report success while leaving this out, and nothing else looks wrong when it does - the
# server simply refuses to start later.
if as_user_sh "cd '${INSTALL_DIR}' && node -e \"require('sqlite3')\"" >/dev/null 2>&1; then
  ok "sqlite3 loads"
else
  warn "sqlite3 did not build on the first attempt - rebuilding it"
  (( NEEDS_BUILD_TOOLS )) && info "expect around 40 minutes on a Pi Zero W; it is working as long as output keeps appearing"
  as_user_sh "cd '${INSTALL_DIR}' && npm rebuild sqlite3 --foreground-scripts"
  as_user_sh "cd '${INSTALL_DIR}' && node -e \"require('sqlite3')\"" >/dev/null 2>&1 \
    || { echo "sqlite3 still will not load - the server cannot run without it." >&2; exit 1; }
  ok "sqlite3 loads after rebuilding"
fi

step "Setting up the server's directory"
as_user_sh "cd '${INSTALL_DIR}' && npx --no frugal-iot-init"
ok "configuration, directories and database in place"

step "Pointing the server at this Pi's own broker"
# One URL, used by the server's own logger and by the browser, so it has to be an address the phone
# or laptop showing the dashboard can reach - not localhost.
MQTT_YAML="${INSTALL_DIR}/config.d/mqtt.yaml"
CURRENT_BROKER="$(sed -n 's/^broker:[[:space:]]*//p' "$MQTT_YAML" 2>/dev/null | head -1 || true)"
WANTED_BROKER="ws://${BROKER_HOST}:9012"
if [[ "$CURRENT_BROKER" == "$WANTED_BROKER" ]]; then
  skip "broker already ${WANTED_BROKER}"
else
  as_user_sh "printf '# This Pi is its own broker - see INSTALLATION.md step 4\nbroker: %s\n' '${WANTED_BROKER}' > '${MQTT_YAML}'"
  ok "broker set to ${WANTED_BROKER} (was ${CURRENT_BROKER:-unset})"
fi

# ---------------------------------------------------------------- the broker

step "Installing the MQTT broker"
sudo_ env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mosquitto mosquitto-clients
ok "mosquitto $(mosquitto -h 2>&1 | head -1 | awk '{print $3}' || true)"

step "Configuring the broker"
# Two listeners: 1883 for the sensor nodes, 9012 websockets for the browser. Shipped with the
# server, so it is copied rather than written here.
SRC_CONF="${INSTALL_DIR}/extras/mosquitto.conf"
[[ -f "$SRC_CONF" ]] || { echo "Expected ${SRC_CONF} to exist after frugal-iot-init" >&2; exit 1; }
if cmp -s "$SRC_CONF" /etc/mosquitto/conf.d/frugal-iot.conf 2>/dev/null; then
  skip "/etc/mosquitto/conf.d/frugal-iot.conf already current"
else
  sudo_ cp "$SRC_CONF" /etc/mosquitto/conf.d/frugal-iot.conf
  ok "configuration copied to /etc/mosquitto/conf.d/frugal-iot.conf"
fi
# The broker refuses to start if the password file it is told about does not exist. It has to belong
# to the mosquitto user, because both the broker and mosquitto_passwd warn unless the file belongs to
# whoever opened it - and mosquitto_passwd writes a temporary file beside it, so the directory has to
# be writable by that user too.
PWFILE="$(grep -hE '^[[:space:]]*password_file[[:space:]]' /etc/mosquitto/conf.d/frugal-iot.conf | tail -1 | awk '{print $2}' || true)"
[[ -n "$PWFILE" ]] || { echo "No password_file line in /etc/mosquitto/conf.d/frugal-iot.conf" >&2; exit 1; }
if [[ -f "$PWFILE" ]]; then
  skip "password file ${PWFILE} exists"
else
  sudo_ install -o mosquitto -g mosquitto -m 600 /dev/null "$PWFILE"
  ok "empty password file created at ${PWFILE}"
fi
sudo_ systemctl restart mosquitto
sleep 2
systemctl is-active --quiet mosquitto \
  || { echo "Mosquitto did not start. Its own log says why - the journal usually does not:" >&2
       sudo_ tail -20 /var/log/mosquitto/mosquitto.log >&2 || true
       exit 1; }
ok "broker running"

# ---------------------------------------------------------------- accounts

step "Creating the administrator login"
if as_user_sh "cd '${INSTALL_DIR}' && sqlite3 frugal-iot.db \"SELECT 1 FROM users WHERE username='superuser' AND hashed_password IS NOT NULL;\"" | grep -q 1; then
  skip "superuser already has a password"
else
  as_user_sh "cd '${INSTALL_DIR}' && npx --no frugal-iot-setpassword superuser '${SUPER_PW}'" >/dev/null
  ok "superuser password set"
fi

step "Creating the organization"
if [[ -f "${INSTALL_DIR}/config.d/organizations/${ORG_ID}.yaml" ]]; then
  skip "organization ${ORG_ID} already exists"
  BROKER_PW="$(sed -n 's/^mqtt_password:[[:space:]]*//p' "${INSTALL_DIR}/config.d/organizations/${ORG_ID}.yaml" | head -1 | tr -d "\"'" || true)"
  info "using the broker password already in its configuration"
else
  # Writes the organization's yaml, creates a login account of the same name, grants it admin, makes
  # its OTA directory, and adds it to the broker's password file
  as_user_sh "cd '${INSTALL_DIR}' && npx --no frugal-iot-addorganization '${ORG_ID}' '${ORG_NAME}' '${ORG_EMAIL}' '${ORG_PHONE}' '${BROKER_PW}'"
  ok "organization ${ORG_ID} created"
  # addorganization set the web login password to the broker password as a side effect. They are for
  # entirely different things, so give the login its own.
  as_user_sh "cd '${INSTALL_DIR}' && npx --no frugal-iot-setpassword '${ORG_ID}' '${LOGIN_PW}'" >/dev/null
  ok "web login password for ${ORG_ID} set, different from the broker password"
fi
sudo_ systemctl restart mosquitto   # so it re-reads the password file
sleep 2

step "Testing the broker end to end"
# Proves the account, the password file and the port 1883 listener the nodes use all work together.
TEST_TOPIC="${ORG_ID}/installtest/hello"
SUB_OUT="$(mktemp)"
mosquitto_sub -h localhost -u "$ORG_ID" -P "$BROKER_PW" -t "$TEST_TOPIC" -C 1 -W 10 > "$SUB_OUT" 2>&1 &
SUB_PID=$!
sleep 2
mosquitto_pub -h localhost -u "$ORG_ID" -P "$BROKER_PW" -t "$TEST_TOPIC" -m '42'
wait "$SUB_PID" 2>/dev/null || true
if grep -qx '42' "$SUB_OUT"; then
  ok "published and received on ${TEST_TOPIC}"
else
  echo "The broker did not deliver a test message. It said:" >&2
  cat "$SUB_OUT" >&2
  rm -f "$SUB_OUT"
  exit 1
fi
rm -f "$SUB_OUT"

# ---------------------------------------------------------------- the service

step "Running the server as a service"
# The shipped unit is written for user "pi" installing into /home/pi/frugal-iot, so the three lines
# that depend on that are rewritten for wherever this actually went.
SRC_SERVICE="${INSTALL_DIR}/extras/frugaliot.service"
[[ -f "$SRC_SERVICE" ]] || { echo "Expected ${SRC_SERVICE} to exist after frugal-iot-init" >&2; exit 1; }
TMP_SERVICE="$(mktemp)"
sed -e "s|^User=.*|User=${RUN_USER}|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
    -e "s|^ExecStart=/home/pi/frugal-iot/node_modules/.bin/frugal-iot-server|ExecStart=${INSTALL_DIR}/node_modules/.bin/frugal-iot-server|" \
    "$SRC_SERVICE" > "$TMP_SERVICE"
if cmp -s "$TMP_SERVICE" /etc/systemd/system/frugaliot.service 2>/dev/null; then
  skip "service file already current"
else
  sudo_ cp "$TMP_SERVICE" /etc/systemd/system/frugaliot.service
  ok "service installed, running as ${RUN_USER} from ${INSTALL_DIR}"
fi
rm -f "$TMP_SERVICE"
sudo_ systemctl daemon-reload
sudo_ systemctl enable -q frugaliot
sudo_ systemctl restart frugaliot

step "Checking the server answers"
PORT="$(sed -n 's/^port:[[:space:]]*//p' "${INSTALL_DIR}/config.d/server.yaml" | head -1 || true)"
PORT="${PORT:-8080}"
for attempt in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://localhost:${PORT}/" || true)"
  [[ "$CODE" == "200" ]] && break
  sleep 2
done
if [[ "${CODE:-}" == "200" ]]; then
  ok "http://localhost:${PORT}/ answered 200"
else
  echo "The server is not answering on port ${PORT} (last response: ${CODE:-none})." >&2
  echo "What it logged:" >&2
  sudo_ journalctl -u frugaliot -n 30 --no-pager >&2 || true
  exit 1
fi
systemctl is-enabled --quiet frugaliot && ok "will start again at boot"

# ---------------------------------------------------------------- what is left to do

IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

# Only the generated ones are worth printing - and printing a password you typed would put it in the
# log for no reason
was_generated() { local v; for v in ${GENERATED[@]+"${GENERATED[@]}"}; do [[ "$v" == "$1" ]] && return 0; done; return 1; }
shown() { if was_generated "$1"; then echo "${!1}"; else echo "(the one you gave)"; fi; }

if (( ${#REBOOT_REASONS[@]} )); then
  REBOOT_TEXT=" 2. REBOOT NEEDED - $(printf '%s' "${REBOOT_REASONS[0]}")."
  for r in "${REBOOT_REASONS[@]:1}"; do REBOOT_TEXT="${REBOOT_TEXT}"$'\n'"    Also: ${r}."; done
  REBOOT_TEXT="${REBOOT_TEXT}"$'\n'"        sudo reboot"$'\n'"    The server and broker both come back by themselves afterwards."
else
  REBOOT_TEXT=" 2. No reboot needed. The kernel running now is the one on disk, and everything
    installed here is already running."
fi

cat <<SUMMARY

=======================================================================
 Frugal IoT is installed and running.
=======================================================================

 Dashboard      http://${BROKER_HOST}:${PORT}/
                http://${IP_ADDR:-this-pi}:${PORT}/     (if .local does not resolve for you)

 Logins         superuser / $(shown SUPER_PW)
                ${ORG_ID} / $(shown LOGIN_PW)

 Broker         ws://${BROKER_HOST}:9012        for browsers
                ${BROKER_HOST}:1883             for sensor nodes
                user ${ORG_ID}, password $(shown BROKER_PW)

 Installed in   ${INSTALL_DIR}, running as ${RUN_USER}
 Log of this run ${LOG}   (readable only by you; any generated password above is in it)

 Still to do:

 1. Your sensor nodes. This cannot be done from here - a node learns the broker by being
    flashed with it, which happens on your workstation. Build each node's firmware with:
        broker    ${BROKER_HOST}
        org       ${ORG_ID}
        password  $(shown BROKER_PW)
    They appear on the dashboard by themselves once they connect.

${REBOOT_TEXT}

 3. HTTPS, if you want over-the-air firmware updates - ESP32 requires it for those.
    See INSTALLATION.md step 10.

 If anything looks wrong:
     cd ${INSTALL_DIR} && npx --no frugal-iot-diagnostic

 Note the server is deliberately quiet - it does not log every message or web request,
 because writes wear out SD cards. To watch messages while setting nodes up, set
 "verbose: true" in ${INSTALL_DIR}/config.d/logger.yaml and restart with
 "sudo service frugaliot restart".

SUMMARY

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
  --broker-password    the organization's shared broker credential. Generated, and not needed on a
                       Pi installed by this script: nodes are issued their own when they enrol and
                       browsers derive their own at login. Set it only to match nodes flashed
                       before enrolment existed.
  --superuser-password password for this server's administrator login.
  --login-password     web login password for the organization's own account, which is a different
                       thing from the broker credential above and should not be the same string.
                       Either of the two logins, if not given, is asked for - and generated if you
                       just press Enter, or if there is no terminal to ask at.
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

# Read a file under /etc that may be readable only by root. An ordinary user gets "Permission
# denied" on stderr and nothing on stdout, which is indistinguishable from "the setting you were
# looking for is not in there" - so a grep over it reports the wrong problem entirely. Try plainly,
# and fall back to sudo when a file that exists yields nothing.
read_maybe_root() {
  local f=$1 out
  [[ -e "$f" ]] || return 0
  out="$(cat "$f" 2>/dev/null || true)"
  [[ -n "$out" ]] || out="$(sudo_ cat "$f" 2>/dev/null || true)"
  printf '%s\n' "$out"
}

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

# Everything a native module needs to compile. python3-setuptools is the one that is easy to miss:
# node-gyp 8 imports Python's distutils, removed from the standard library in 3.12, and setuptools
# is what puts an importable one back. Without it the build ends in "No module named 'distutils'".
BUILD_PACKAGES=(build-essential python3-dev python3-setuptools)
have_build_tools() { dpkg -s "${BUILD_PACKAGES[@]}" >/dev/null 2>&1; }
install_build_tools() {
  sudo_ env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${BUILD_PACKAGES[@]}"
}

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
# What the USERLAND is, which is not necessarily what "uname -m" says. uname reports the KERNEL, and
# Raspberry Pi OS 32-bit boots the 64-bit kernel by default on any 64-bit-capable board - so a
# perfectly ordinary Pi 4 running the 32-bit image reports "armv8l" while every binary on it is
# 32-bit armhf. npm resolves prebuilt binaries against the userland, so that is what decides whether
# anything has to be compiled. Deciding it from uname installed no compiler on exactly that
# configuration, and the install then died part-way through building sqlite3.
DEB_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
info "kernel:  ${ARCH}    userland: ${DEB_ARCH:-unknown}    memory: $((MEM_KB / 1024)) MB"

# No ready-made sqlite3 binary is published for 32-bit ARM, so there it has to be compiled.
NEEDS_BUILD_TOOLS=0
case "$DEB_ARCH" in
  armhf|armel)  NEEDS_BUILD_TOOLS=1 ;;
  arm64|amd64)  NEEDS_BUILD_TOOLS=0 ;;
  *)
    # dpkg could not say. Fall back to the kernel, and lean towards installing the compiler: having
    # it and not needing it costs disk, not having it and needing it stops the install dead.
    case "$ARCH" in
      aarch64|arm64|x86_64) NEEDS_BUILD_TOOLS=0 ;;
      *)              NEEDS_BUILD_TOOLS=1 ;;
    esac
    ;;
esac

# A 64-bit kernel over a 32-bit userland means 64-bit hardware running the 32-bit image - almost
# always the wrong card written by mistake, and worth saying before the 40 minutes rather than
# after. It does work, so this warns and carries on rather than refusing.
WRONG_IMAGE=0
if [[ "$DEB_ARCH" == armhf ]]; then
  case "$ARCH" in
    aarch64|armv8l) WRONG_IMAGE=1 ;;
  esac
fi
if (( WRONG_IMAGE )); then
  BOARD="$( [[ -r /proc/device-tree/model ]] && tr -d '\0' < /proc/device-tree/model || echo "this board" )"
  warn "-----------------------------------------------------------------------"
  warn "${BOARD} is 64-bit, but the OS on the card is 32-bit (armhf)."
  warn "That is almost always the wrong image written to the card."
  warn ""
  warn "It will work, but no ready-made sqlite3 is published for 32-bit ARM, so"
  warn "it has to be compiled: minutes here, about 40 on a Pi Zero W."
  warn ""
  warn "To use the right one instead: write Raspberry Pi OS Lite (64-bit) to the"
  warn "card and start again from step 1. Nothing here is worth keeping yet."
  warn "-----------------------------------------------------------------------"
  if (( ! ASSUME_YES )) && [[ -t 0 ]]; then
    printf '    Carry on with the 32-bit OS anyway? [y/N] ' > /dev/tty
    read -r REPLY < /dev/tty
    [[ "$REPLY" == [yY]* ]] || { echo "Stopped. Nothing has been changed."; exit 0; }
  fi
fi

# One thing at a time, which lowers npm's peak memory as much as it spares the card. This is about
# how little memory the board has, not about its architecture - a 32-bit Pi 4 has plenty.
NPM_SLOW_FLAGS=()
if (( MEM_KB > 0 && MEM_KB < 1200000 )); then NPM_SLOW_FLAGS=(--maxsockets 1 --no-audit --no-fund); fi
if (( MEM_KB > 0 && MEM_KB < 700000 )); then NEEDS_SWAP=1; else NEEDS_SWAP=0; fi
(( NEEDS_BUILD_TOOLS )) && info "no ready-made sqlite3 for ${DEB_ARCH:-this architecture}, so it is compiled here (minutes on a Pi 4, about 40 on a Zero W)"
(( ${#NPM_SLOW_FLAGS[@]} )) && info "limited memory: npm will be told to do one thing at a time"
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
# Not asked for. addorganization.zsh requires one, and lib/retained.js falls back to it on a broker
# with no dynamic security - but this installer always sets dynamic security up, so on this Pi every
# node is issued its own credential when it enrols and every browser derives its own when it logs
# in, and nothing reads this. Generated rather than asked, so there is one less thing to choose.
# --broker-password still sets it, for an organization whose nodes predate enrolment.
if [[ -z "$BROKER_PW" ]]; then
  BROKER_PW="$(randpw)"
  GENERATED+=(BROKER_PW)
fi
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
$(printf '  %-22s %s\n' "superuser login" "${SUPER_PW}" "${ORG_ID} web login" "${LOGIN_PW}")
The organization's broker credential is generated too, but not shown: nothing needs you to know it,
since nodes are issued their own when they enrol. It lands in config.d/organizations/${ORG_ID}.yaml.
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
(( NEEDS_BUILD_TOOLS )) && PACKAGES+=("${BUILD_PACKAGES[@]}")
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
  # A failure here is nearly always the native module having to be compiled with no compiler
  # present - which means the architecture was read wrong above. Rather than stopping and making
  # you run the whole thing again, install what a build needs and have one more go.
  if ! as_user_sh "cd '${INSTALL_DIR}' && npm install ${NPM_SLOW_FLAGS[*]:-} frugal-iot-server"; then
    if have_build_tools; then
      echo "npm install failed, and the compiler it would need is already installed - so this is" >&2
      echo "something else. The reason is above, and in ${LOG}." >&2
      exit 1
    fi
    warn "npm install failed and nothing here can compile a native module - installing the"
    warn "  compiler and trying once more. (If it ended in \"No module named 'distutils'\", that"
    warn "  is exactly this.)"
    install_build_tools
    NEEDS_BUILD_TOOLS=1
    as_user_sh "cd '${INSTALL_DIR}' && npm install ${NPM_SLOW_FLAGS[*]:-} frugal-iot-server"
  fi
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
  if ! have_build_tools; then
    info "installing the compiler first - a rebuild cannot work without it"
    install_build_tools
  fi
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
# Read the broker configuration from the INSTALLED PACKAGE, not from ${INSTALL_DIR}/extras.
#
# frugal-iot-init copies extras/ into the install directory but never overwrites what is already
# there - it prints "kept ... (DIFFERS from this release)" and leaves it. That is right for a file
# somebody may have edited, and wrong for this one: it means a security-relevant change to the
# shipped broker configuration does not reach /etc on an upgrade, however many times this script is
# re-run. That is how a broker with no acl_file survived several releases.
#
# The package's own copy is authoritative, so an upgrade followed by a re-run of this script applies
# the current configuration. ${INSTALL_DIR}/extras stays as the fallback for an installation whose
# layout predates this.
PKG_DIR="${INSTALL_DIR}/node_modules/frugal-iot-server"
SRC_CONF="${PKG_DIR}/extras/mosquitto.conf"
[[ -f "$SRC_CONF" ]] || SRC_CONF="${INSTALL_DIR}/extras/mosquitto.conf"
[[ -f "$SRC_CONF" ]] || { echo "Expected extras/mosquitto.conf in ${PKG_DIR} or ${INSTALL_DIR}" >&2; exit 1; }

# The ACL file goes in FIRST, because the configuration copied below names it and mosquitto will not
# start if it is missing. Owned by mosquitto, mode 600: the broker reads it after dropping
# privileges, and 2.0.21 warns that a file it does not own, or one that is world readable, will be
# refused by a future version. Same rule as the password file below.
SRC_ACL="${PKG_DIR}/extras/aclfile"
[[ -f "$SRC_ACL" ]] || SRC_ACL="${INSTALL_DIR}/extras/aclfile"
[[ -f "$SRC_ACL" ]] || { echo "Expected extras/aclfile in ${PKG_DIR} or ${INSTALL_DIR}" >&2; exit 1; }

# An existing ACL file is NOT simply replaced. addbridge-prod.zsh appends a stanza to it per Pi:
#
#   user <account>
#   topic readwrite <org>/#
#
# Overwriting the file drops those, and because a mosquitto acl_file is deny-by-default the result
# is every bridge account still logging in and reaching nothing at all - every site stops relaying,
# on a broker that looks perfectly healthy. So the shipped file is treated as the set of lines that
# must be PRESENT, not as the whole contents.
#
# Ownership and mode of a file that already exists are left alone deliberately. An older install has
# it root-owned 644, which works and only draws a warning from the broker; "fixing" it to 600
# without also chowning it to mosquitto stops the broker starting, because it reads this file after
# dropping privileges. That is a migration to make deliberately, not a side effect of an upgrade -
# INSTALLATION.md step 11 has it.
if [[ ! -e /etc/mosquitto/aclfile ]]; then
  sudo_ install -o mosquitto -g mosquitto -m 600 "$SRC_ACL" /etc/mosquitto/aclfile
  ok "access control list installed at /etc/mosquitto/aclfile"
else
  # Read with sudo: the file is normally mode 600 owned by the broker's own user, so reading it as
  # anyone else returns nothing, which would look exactly like "every shipped rule is missing".
  ACL_MISSING=$(comm -23 \
      <(grep -vE '^[[:space:]]*(#|$)' "$SRC_ACL" | sort -u) \
      <(sudo_ grep -vE '^[[:space:]]*(#|$)' /etc/mosquitto/aclfile 2>/dev/null | sort -u) || true)
  ACL_ADDED=$(sudo_ grep -cE '^[[:space:]]*user[[:space:]]' /etc/mosquitto/aclfile 2>/dev/null || true)
  ACL_ADDED=${ACL_ADDED:-0}
  if [[ -z "$ACL_MISSING" ]]; then
    skip "/etc/mosquitto/aclfile has every rule this release ships${ACL_ADDED:+ (plus ${ACL_ADDED} added per bridge)}"
  elif (( ACL_ADDED == 0 )); then
    # Nothing has been added by hand, so there is nothing to lose by replacing it
    sudo_ install -m "$(stat -c '%a' /etc/mosquitto/aclfile 2>/dev/null || echo 600)" \
          "$SRC_ACL" /etc/mosquitto/aclfile
    ok "access control list at /etc/mosquitto/aclfile brought up to date"
  else
    warn "/etc/mosquitto/aclfile is missing rules this release ships, and holds ${ACL_ADDED} rule(s)"
    warn "  added per bridge, which replacing it would delete. Add these by hand instead:"
    while IFS= read -r line; do [[ -n "$line" ]] && info "    ${line}"; done <<< "$ACL_MISSING"
    warn "  then: sudo systemctl reload mosquitto"
  fi
fi

# The dynamic security plugin. Its state file has to exist before the configuration naming it is
# installed, or the broker will not start - same ordering as the ACL above.
#
# The plugin path varies by distribution, so it is found rather than assumed: Debian and Raspberry Pi
# OS ship it as /usr/lib/<arch>/mosquitto_dynamic_security.so, others use a mosquitto/ subdirectory.
DYNSEC_SO=""
for cand in /usr/lib/*/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so             /usr/lib/*/mosquitto/mosquitto_dynamic_security.so /usr/lib/mosquitto/mosquitto_dynamic_security.so; do
  [[ -f "$cand" ]] && { DYNSEC_SO="$cand"; break; }
done
# An earlier release appended to this as whoever ran the script, so a run under sudo left it owned
# by root - unreadable to the server, which is an ordinary user, and the symptom is every login
# being told there is no broker credential. Put it right before anything below reads it.
if [[ -f "${INSTALL_DIR}/config.d/secrets.yaml" ]]; then
  SECRETS_OWNER="$(stat -c '%U' "${INSTALL_DIR}/config.d/secrets.yaml" 2>/dev/null || true)"
  if [[ -n "$SECRETS_OWNER" && "$SECRETS_OWNER" != "$RUN_USER" ]]; then
    sudo_ chown "${RUN_USER}" "${INSTALL_DIR}/config.d/secrets.yaml"
    sudo_ chmod 600 "${INSTALL_DIR}/config.d/secrets.yaml"
    ok "config.d/secrets.yaml belonged to ${SECRETS_OWNER}, not ${RUN_USER} - ownership corrected"
  fi
fi

DYNSEC_JSON=/var/lib/mosquitto/dynamic-security.json
if [[ -z "$DYNSEC_SO" ]]; then
  warn "mosquitto's dynamic security plugin was not found - per-user broker accounts will not work."
  warn "  Looked in /usr/lib. The broker will still run on the organization passwords."
elif [[ -f "$DYNSEC_JSON" ]]; then
  if as_user_sh "grep -q '^dynsec_admin_password:' '${INSTALL_DIR}/config.d/secrets.yaml'" 2>/dev/null; then
    skip "dynamic security already initialised at ${DYNSEC_JSON}"
  else
    # Re-running cannot mend this: mosquitto_ctrl will not re-initialise over an existing state
    # file, and the password it chose the first time was never written down anywhere.
    warn "${DYNSEC_JSON} exists but config.d/secrets.yaml has no dynsec_admin_password."
    warn "  A previous run must have stopped between the two. The password it used is not"
    warn "  recoverable, so start that part again:"
    warn "    sudo rm ${DYNSEC_JSON}"
    warn "  then run this script again. Nothing else is affected - no accounts exist yet."
  fi
else
  # dynsec init asks for the admin password twice on stdin. The password is generated here and kept
  # in the server's own config.d/secrets.yaml, which is never served to a browser.
  DYNSEC_PW="$(randpw)"
  if printf '%s\n%s\n' "$DYNSEC_PW" "$DYNSEC_PW"        | sudo_ mosquitto_ctrl dynsec init "$DYNSEC_JSON" frugal-admin >/dev/null 2>&1      && [[ -s "$DYNSEC_JSON" ]]; then
    # Written after dropping privileges, so owned by mosquitto like the password and ACL files
    sudo_ chown mosquitto:mosquitto "$DYNSEC_JSON"
    sudo_ chmod 600 "$DYNSEC_JSON"
    {
      echo ""
      echo "# The broker account the server uses to create and remove other accounts, over"
      echo "# \$CONTROL/dynamic-security/v1. Created by install-pi.sh."
      echo "dynsec_admin_user: \"frugal-admin\""
      echo "dynsec_admin_password: \"${DYNSEC_PW}\""
    } | as_user_sh "cat >> '${INSTALL_DIR}/config.d/secrets.yaml' && chmod 600 '${INSTALL_DIR}/config.d/secrets.yaml'"
    # Through a pipe, not on the command line: an argument to sudo would put the password in "ps"
    ok "dynamic security initialised; admin credential saved to config.d/secrets.yaml"
  else
    warn "mosquitto_ctrl dynsec init failed - continuing without it"
    sudo_ rm -f "$DYNSEC_JSON"
    DYNSEC_SO=""
  fi
fi

# The shipped configuration carries a placeholder for the plugin path, because it differs per
# distribution. Substitute it here - or comment the plugin out entirely if there is no plugin.
TMP_CONF="$(mktemp)"
if [[ -n "$DYNSEC_SO" ]]; then
  sed "s|^plugin PLUGIN_PATH_SET_BY_INSTALLER|plugin ${DYNSEC_SO}|" "$SRC_CONF" > "$TMP_CONF"
else
  sed -e "s|^plugin PLUGIN_PATH_SET_BY_INSTALLER|#plugin (not installed)|"       -e "s|^plugin_opt_config_file|#plugin_opt_config_file|" "$SRC_CONF" > "$TMP_CONF"
fi
if [[ "$(read_maybe_root /etc/mosquitto/conf.d/frugal-iot.conf)" == "$(cat "$TMP_CONF")" ]]; then
  skip "/etc/mosquitto/conf.d/frugal-iot.conf already current"
else
  # "install" and not "cp": cp gives a new destination the mode of its source, and the source here
  # is a mktemp file, which is 600. That left this root-only - unreadable to the grep below, to
  # frugal-iot-init's comparison, and to the diagnostic. It holds paths, not secrets.
  sudo_ install -o root -g root -m 644 "$TMP_CONF" /etc/mosquitto/conf.d/frugal-iot.conf
  ok "configuration copied to /etc/mosquitto/conf.d/frugal-iot.conf"
fi
# Repair the mode even when the contents already matched. A release before this one installed this
# file with "cp" from a mktemp file, leaving it 600 root - and since the contents are right, the
# branch above skips, so nothing else would ever put that straight.
CONF_MODE="$(stat -c '%a' /etc/mosquitto/conf.d/frugal-iot.conf 2>/dev/null || true)"
if [[ -n "$CONF_MODE" && "$CONF_MODE" != 644 ]]; then
  sudo_ chown root:root /etc/mosquitto/conf.d/frugal-iot.conf
  sudo_ chmod 644 /etc/mosquitto/conf.d/frugal-iot.conf
  ok "mode corrected to 644 (was ${CONF_MODE}) - it holds paths, not secrets, and several things read it"
fi
rm -f "$TMP_CONF"
# The broker refuses to start if the password file it is told about does not exist. It has to belong
# to the mosquitto user, because both the broker and mosquitto_passwd warn unless the file belongs to
# whoever opened it - and mosquitto_passwd writes a temporary file beside it, so the directory has to
# be writable by that user too.
PWFILE="$(read_maybe_root /etc/mosquitto/conf.d/frugal-iot.conf | grep -hE '^[[:space:]]*password_file[[:space:]]' | tail -1 | awk '{print $2}' || true)"
if [[ -z "$PWFILE" ]]; then
  echo "No password_file line found in /etc/mosquitto/conf.d/frugal-iot.conf" >&2
  echo "That file is: $(ls -ld /etc/mosquitto/conf.d/frugal-iot.conf 2>&1)" >&2
  echo "If it cannot be read even with sudo, check what is in it - the broker needs that line." >&2
  exit 1
fi
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
# From the installed package, not ${INSTALL_DIR}/extras - for the same reason as the broker
# configuration above. frugal-iot-init never overwrites its copy, so a release that changes the
# unit would otherwise never reach /etc however often this is re-run.
SRC_SERVICE="${PKG_DIR}/extras/frugaliot.service"
[[ -f "$SRC_SERVICE" ]] || SRC_SERVICE="${INSTALL_DIR}/extras/frugaliot.service"
[[ -f "$SRC_SERVICE" ]] || { echo "Expected extras/frugaliot.service in ${PKG_DIR} or ${INSTALL_DIR}" >&2; exit 1; }
TMP_SERVICE="$(mktemp)"
sed -e "s|^User=.*|User=${RUN_USER}|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
    -e "s|^ExecStart=/home/pi/frugal-iot/node_modules/.bin/frugal-iot-server|ExecStart=${INSTALL_DIR}/node_modules/.bin/frugal-iot-server|" \
    "$SRC_SERVICE" > "$TMP_SERVICE"
if cmp -s "$TMP_SERVICE" /etc/systemd/system/frugaliot.service 2>/dev/null; then
  skip "service file already current"
else
  # "install" not "cp", for the reason given at the broker configuration above: a unit file copied
  # from a mktemp file inherits mode 600, which "systemctl cat" and frugal-iot-init cannot read
  sudo_ install -o root -g root -m 644 "$TMP_SERVICE" /etc/systemd/system/frugaliot.service
  ok "service installed, running as ${RUN_USER} from ${INSTALL_DIR}"
fi
# Same repair as for the broker configuration above, and for the same reason
SERVICE_MODE="$(stat -c '%a' /etc/systemd/system/frugaliot.service 2>/dev/null || true)"
if [[ -n "$SERVICE_MODE" && "$SERVICE_MODE" != 644 ]]; then
  sudo_ chown root:root /etc/systemd/system/frugaliot.service
  sudo_ chmod 644 /etc/systemd/system/frugaliot.service
  ok "service file mode corrected to 644 (was ${SERVICE_MODE}) - systemctl cat could not read it"
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

# What a node presents once to be issued its own broker credential. The server generates one per
# organization at startup, so it exists by now; secrets.yaml is 600 and owned by the server's user.
ENROL_SECRET="$(as_user_sh "grep -A1 '^enrolment_${ORG_ID}:' '${INSTALL_DIR}/config.d/secrets.yaml' 2>/dev/null | tail -1" 2>/dev/null | sed -e 's/^[[:space:]]*-[[:space:]]*//' -e 's/^"//' -e 's/"$//' || true)"

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

 Broker         ws://${BROKER_HOST}:9012        for browsers - each login is issued its own
                                                credential, so there is nothing to type in
                ${BROKER_HOST}:1883             for sensor nodes, which are issued their own
                                                credential when they enrol (below)

 Installed in   ${INSTALL_DIR}, running as ${RUN_USER}
 Log of this run ${LOG}   (readable only by you; any generated password above is in it)

 Still to do:

 1. Your sensor nodes. This cannot be done from here - a node learns the broker by being
    flashed with it, which happens on your workstation. Build each node's firmware with:
        broker           ${BROKER_HOST}
        org              ${ORG_ID}
        enrolment secret ${ENROL_SECRET:-see config.d/secrets.yaml, enrolment_${ORG_ID}}
    A node presents that secret once, is issued a broker credential of its own, and stores it.
    The secret grants nothing else - no read and no write - so it is not the thing to guard.
    They appear on the dashboard by themselves once they connect.

    To rotate it, add a line above the old one in ${INSTALL_DIR}/config.d/secrets.yaml and leave
    the old one until every node flashed with it has enrolled - deleting it first strands them.

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

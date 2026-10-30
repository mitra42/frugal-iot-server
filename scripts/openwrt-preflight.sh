#!/bin/sh
#
# Will a Frugal IoT server run on this OpenWrt router?  Run this BEFORE install-openwrt.sh.
#
#   wget -O openwrt-preflight.sh https://raw.githubusercontent.com/mitra42/frugal-iot-server/openwrt/scripts/openwrt-preflight.sh
#   sh openwrt-preflight.sh --install 2>&1 | tee preflight.txt
#
# It looks at the things that have decided whether this works, in the order they are likely to stop it:
# the CPU, memory, a place to put ~400 MB, whether OpenWrt's package feed has a recent enough node,
# and - by actually trying them - whether this build of mosquitto can do websockets and load the dynamic
# security plugin, and whether the sqlite3 module can be installed here at all.
#
# Without --install it changes nothing except refreshing the package list. With --install it also
# installs the packages the server needs (the same ones install-openwrt.sh would), so the last three
# checks can be run for real. It asks first.
#
# Plain /bin/sh on purpose: a fresh OpenWrt has no bash. Safe to run as often as you like.

set -u

DIR=/opt/frugal-iot; INSTALL=0; ASSUME_YES=0

usage() {
  cat <<USAGE
Usage: sh openwrt-preflight.sh [options]

  --dir <path>   where the server would be installed (default: ${DIR}). Only used to check there is
                 room, and as the place to try the sqlite3 module.
  --install      also install node, mosquitto and the other packages, so everything can be tested
  --yes          do not ask before installing
  --help
USAGE
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      [ $# -ge 2 ] || usage 1; DIR=$2; shift 2 ;;
    --install)  INSTALL=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --help|-h)  usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

N_PASS=0; N_WARN=0; N_FAIL=0
BLOCKERS=""
pass()  { N_PASS=$((N_PASS+1)); echo "  PASS  $*"; }
warn()  { N_WARN=$((N_WARN+1)); echo "  WARN  $*"; }
fail()  { N_FAIL=$((N_FAIL+1)); echo "  FAIL  $*"; BLOCKERS="${BLOCKERS}
    - $*"; }
info()  { echo "        $*"; }
head_() { echo; echo "== $* =="; }

# Needed by the server and its setup commands. zsh because every "npx frugal-iot-..." command is a
# zsh script; ca-bundle because npm fetches over https; sqlite3-cli because frugal-iot-init uses it.
PKGS="node node-npm zsh sqlite3-cli curl ca-bundle"

# ---------------------------------------------------------------- package manager
if command -v opkg >/dev/null 2>&1; then PM=opkg
elif command -v apk >/dev/null 2>&1; then PM=apk
else PM=""; fi

pkg_update() { case "$PM" in opkg) opkg update >/dev/null 2>&1 ;; apk) apk update >/dev/null 2>&1 ;; esac; }
pkg_installed() {
  case "$PM" in
    opkg) opkg list-installed 2>/dev/null | grep -q "^$1 " ;;
    apk)  apk info -e "$1" >/dev/null 2>&1 ;;
    *)    return 1 ;;
  esac
}
# Prints the version a feed offers for a package, nothing if it has none
pkg_version() {
  case "$PM" in
    opkg) opkg list "$1" 2>/dev/null | awk -v n="$1" '$1==n {print $3; exit}' ;;
    apk)  apk search -e -v "$1" 2>/dev/null | head -1 | sed "s/^$1-//" ;;
  esac
}
pkg_install() {
  case "$PM" in
    opkg) opkg install "$@" ;;
    apk)  apk add "$@" ;;
  esac
}

# "20.18.1-r1" -> true if at least 20.17
node_version_ok() {
  echo "$1" | sed 's/^v//' | awk -F'[.-]' '{ exit !($1 > 20 || ($1 == 20 && $2 >= 17)) }'
}

# Longest mount point that holds a path, and its filesystem type
mount_info() {
  p=$1
  while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done
  p=$(cd "$p" 2>/dev/null && pwd -P || echo "$p")
  awk -v p="$p" '
    { m = $2; pre = (m == "/") ? "/" : (m "/")
      if ((p == m || index(p, pre) == 1) && length(m) >= length(best)) { best = m; fs = $3 } }
    END { print best, fs }' /proc/mounts
}
free_mb() { p=$1; while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done
            df -Pk "$p" 2>/dev/null | awk 'NR==2 {print int($4/1024)}'; }

echo "Frugal IoT on OpenWrt - preflight check"
echo "Date: $(date)"

# ---------------------------------------------------------------- the machine
head_ "The router"
if [ -r /etc/openwrt_release ]; then
  . /etc/openwrt_release
  info "${DISTRIB_DESCRIPTION:-OpenWrt}   target ${DISTRIB_TARGET:-?}   package arch ${DISTRIB_ARCH:-?}"
  pass "this is OpenWrt"
else
  warn "no /etc/openwrt_release - this does not look like OpenWrt. The checks below still run."
  DISTRIB_ARCH=$(uname -m)
fi
MODEL=$( { cat /tmp/sysinfo/model || tr -d '\0' < /proc/device-tree/model; } 2>/dev/null || echo unknown)
info "board:  ${MODEL}"
info "kernel: $(uname -m)   $(uname -r)"
[ -n "$PM" ] && pass "package manager: ${PM}" || fail "neither opkg nor apk found"
[ "$(id -u)" = 0 ] && pass "running as root" || warn "not root - the installer must run as root"

case "${DISTRIB_ARCH:-}" in
  x86_64*|aarch64*)
    pass "CPU architecture ${DISTRIB_ARCH} - the kind this is most likely to work on" ;;
  arm_*|i386*|x86*)
    warn "CPU architecture ${DISTRIB_ARCH}: 32-bit. node may exist for it, but sqlite3 has no ready-made binary there, so it would have to be compiled" ;;
  *)
    fail "CPU architecture ${DISTRIB_ARCH}: OpenWrt is not known to have node for this (mips, powerpc, riscv...). The feed check below is the real test" ;;
esac

MEM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
AVAIL_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
info "memory: $((MEM_KB/1024)) MB total, $((AVAIL_KB/1024)) MB available now"
if   [ "$MEM_KB" -lt 240000 ]; then fail "under 256 MB of memory: the server alone uses about 250 MB"
elif [ "$MEM_KB" -lt 460000 ]; then warn "under 512 MB: may work, but the router's own services and the server will be competing"
else pass "memory"; fi

YEAR=$(date +%Y)
if [ "$YEAR" -lt 2024 ]; then warn "the clock says ${YEAR}. Readings are stamped on arrival, so set the time (NTP) first"
else pass "clock is set (${YEAR})"; fi

# ---------------------------------------------------------------- storage
head_ "Storage"
info "wanted: about 400 MB free on a normal Linux filesystem (ext4, f2fs, btrfs). The software is"
info "~100 MB, npm needs room while installing, and sensor data keeps growing."
info "Not FAT/exFAT/NTFS - the install uses symlinks and Unix permissions."
echo "  Filesystems with room:"
awk '$3 ~ /^(ext2|ext3|ext4|f2fs|btrfs|xfs|overlay|ubifs|jffs2)$/ {print $2, $3}' /proc/mounts | sort -u | while read -r mnt fs; do
  mb=$(free_mb "$mnt"); [ -n "$mb" ] && echo "        ${mnt}  (${fs})  ${mb} MB free"
done

set -- $(mount_info "$DIR"); DMNT=${1:-/}; DFS=${2:-?}
DFREE=$(free_mb "$DIR"); DFREE=${DFREE:-0}
info "install directory ${DIR} is on ${DMNT} (${DFS}), ${DFREE} MB free"
case "$DFS" in
  vfat|exfat|msdos|ntfs|fuseblk) fail "${DIR} is on ${DFS}, which cannot hold the install. Put it on an ext4 drive: --dir /mnt/<drive>/frugal-iot" ;;
  *) if [ "$DFREE" -lt 400 ]; then
       fail "only ${DFREE} MB free for ${DIR}. Attach a USB/SSD drive (extroot, or mount it) and use --dir"
     else pass "room for the install (${DFREE} MB)"; fi ;;
esac

# ---------------------------------------------------------------- the package feed
head_ "OpenWrt's package feed"
if [ -n "$PM" ]; then
  info "refreshing the package list ($PM) - this changes nothing else"
  pkg_update || warn "could not refresh the package list - no internet from the router?"
  for p in $PKGS; do
    v=$(pkg_version "$p")
    if pkg_installed "$p"; then info "${p}: installed"
    elif [ -n "$v" ]; then info "${p}: available (${v})"
    else
      case "$p" in
        node|node-npm|zsh) fail "package '${p}' is not in this feed" ;;
        *) warn "package '${p}' is not in this feed" ;;
      esac
    fi
  done
  NV=$(pkg_version node)
  if pkg_installed node && command -v node >/dev/null 2>&1; then NV=$(node -v); fi
  if [ -n "$NV" ]; then
    if node_version_ok "$NV"; then pass "node ${NV} (the server needs 20.17 or later)"
    else fail "node ${NV} is older than the 20.17 the server needs"; fi
  fi
  MQ=""
  for cand in mosquitto-ssl mosquitto-nossl; do
    if pkg_installed "$cand" || [ -n "$(pkg_version "$cand")" ]; then MQ=$cand; break; fi
  done
  [ -n "$MQ" ] && pass "mosquitto package: ${MQ}" || fail "no mosquitto-ssl or mosquitto-nossl package in this feed"
  info "everything the feed has with 'mosquitto' in its name:"
  case "$PM" in
    opkg) opkg list 2>/dev/null | awk '/^(lib)?mosquitto/ {print "        " $1, $2, $3}' ;;
    apk)  apk search mosquitto 2>/dev/null | sed 's/^/        /' ;;
  esac
fi

# ---------------------------------------------------------------- optional install
if [ "$INSTALL" = 1 ] && [ -n "$PM" ]; then
  head_ "Installing what is needed to test the rest"
  MQ_ALL="${MQ:-mosquitto-ssl}"
  case "$MQ_ALL" in *-nossl) MQC=mosquitto-client-nossl ;; *) MQC=mosquitto-client-ssl ;; esac
  WANT="$PKGS $MQ_ALL $MQC"
  info "will install: ${WANT}"
  info "free space on the router's own flash: $(free_mb /) MB. Node alone is tens of MB."
  go=1
  if [ "$ASSUME_YES" != 1 ]; then
    printf '        Install these now? [y/N] '; read -r reply || reply=n
    case "$reply" in y|Y|yes) ;; *) go=0 ;; esac
  fi
  if [ "$go" = 1 ]; then
    for p in $WANT; do
      pkg_installed "$p" && continue
      pkg_install "$p" >/dev/null 2>&1 && info "installed ${p}" || warn "could not install ${p}"
    done
  else
    info "skipped - the broker and sqlite3 tests below will be skipped too"
  fi
fi

# ---------------------------------------------------------------- the broker, tried for real
head_ "mosquitto, tried for real"
TMP=$(mktemp -d 2>/dev/null || echo /tmp/frugal-preflight-$$); mkdir -p "$TMP"
cleanup() {
  [ -n "${MQPID:-}" ] && kill "$MQPID" 2>/dev/null
  rm -rf "$TMP"
  [ -n "${SQDIR:-}" ] && rm -rf "$SQDIR"
}
trap cleanup EXIT

if ! command -v mosquitto >/dev/null 2>&1; then
  warn "mosquitto is not installed, so it cannot be tested. Run again with --install"
else
  info "$(mosquitto -h 2>&1 | head -1)"
  # Does this build do websockets? The dashboard in a browser needs it. Ask the broker to open one.
  cat > "$TMP/ws.conf" <<CONF
allow_anonymous true
listener 29883 127.0.0.1
protocol mqtt
listener 29012 127.0.0.1
protocol websockets
CONF
  mosquitto -c "$TMP/ws.conf" > "$TMP/ws.log" 2>&1 &
  MQPID=$!; sleep 2
  if kill -0 "$MQPID" 2>/dev/null; then
    pass "websockets listener starts (the browser dashboard needs one)"
    kill "$MQPID" 2>/dev/null; MQPID=""
  else
    fail "this mosquitto will not start with a websockets listener: $(tail -1 "$TMP/ws.log")"
  fi

  # The dynamic security plugin: where is it, and does it load?
  SO=""
  for cand in /usr/lib/mosquitto/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so \
              /usr/lib/*/mosquitto_dynamic_security.so /usr/lib/*/mosquitto/mosquitto_dynamic_security.so; do
    [ -f "$cand" ] && { SO=$cand; break; }
  done
  if [ -z "$SO" ]; then
    warn "no mosquitto_dynamic_security.so found. The server would run on the older shared-password scheme: every node and browser uses the organization's password. Works, but less secure"
  else
    cat > "$TMP/dyn.conf" <<CONF
allow_anonymous true
listener 29884 127.0.0.1
plugin ${SO}
plugin_opt_config_file ${TMP}/dynsec.json
CONF
    mosquitto -c "$TMP/dyn.conf" > "$TMP/dyn.log" 2>&1 &
    MQPID=$!; sleep 2
    if kill -0 "$MQPID" 2>/dev/null; then pass "dynamic security plugin loads (${SO})"
    else warn "dynamic security plugin found at ${SO} but did not load: $(tail -1 "$TMP/dyn.log")"; fi
    kill "$MQPID" 2>/dev/null; MQPID=""
  fi
  for t in mosquitto_ctrl mosquitto_passwd mosquitto_pub mosquitto_sub; do
    command -v "$t" >/dev/null 2>&1 && info "have ${t}" || {
      case "$t" in
        mosquitto_passwd) fail "no mosquitto_passwd: the installer needs it" ;;
        mosquitto_ctrl)   [ -n "$SO" ] && warn "no mosquitto_ctrl: the dynamic security plugin cannot be set up without it" ;;
        *) warn "no ${t}" ;;
      esac; }
  done
fi

# ---------------------------------------------------------------- sqlite3, the module that most often fails
head_ "sqlite3 (the server's database module)"
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  if [ "$DFREE" -lt 150 ]; then
    warn "not enough room under ${DIR} to try it (${DFREE} MB) - skipped"
  else
    SQDIR="${DIR}/.preflight-$$"
    mkdir -p "$SQDIR" && cd "$SQDIR" || SQDIR=""
    if [ -n "$SQDIR" ]; then
      info "node $(node -v), npm $(npm -v). Trying: npm install sqlite3 (needs the internet)"
      export npm_config_cache="${SQDIR}/.cache"
      if npm install --no-audit --no-fund --loglevel=error 'sqlite3@^6.0.1' > "$SQDIR/npm.log" 2>&1 \
         && node -e "
const s = require('sqlite3');
new s.Database(':memory:').get('select sqlite_version() v', (e, r) => {
  if (e) { console.error(e); process.exit(1); } console.log(r.v); })" > "$SQDIR/run.log" 2>&1; then
        pass "sqlite3 installs and runs here (SQLite $(cat "$SQDIR/run.log"))"
      else
        fail "sqlite3 would not install or load on this router. Last lines:"
        tail -8 "$SQDIR/npm.log" "$SQDIR/run.log" 2>/dev/null | sed 's/^/        /'
      fi
      cd /
    fi
  fi
else
  warn "node/npm are not installed, so sqlite3 cannot be tested. Run again with --install"
fi

# ---------------------------------------------------------------- ports
head_ "Ports"
for port in 1883 9012 8080; do
  if netstat -ln 2>/dev/null | grep -q "[:.]${port} "; then warn "port ${port} is already in use here - something else is listening on it"
  else info "port ${port} is free"; fi
done

# ---------------------------------------------------------------- verdict
head_ "Verdict"
echo "  ${N_PASS} passed, ${N_WARN} warnings, ${N_FAIL} failed"
if [ "$N_FAIL" -gt 0 ]; then
  echo "  NOT READY:${BLOCKERS}"
elif [ "$N_WARN" -gt 0 ]; then
  echo "  Probably workable - read the warnings above."
else
  echo "  Looks good."
fi
echo
echo "Please send everything above to whoever asked you to try this."
exit 0

#!/usr/bin/env zsh
#
# Report the state of a Frugal IoT installation, for working out why something in INSTALLATION.md
# did not do what it said it would. It only looks - it changes nothing.
#
# Run it from the directory the server is installed in (the one holding frugal-iot.db):
#   zsh diagnostic.zsh
# or, once installed from npm:
#   npx --no frugal-iot-diagnostic
#
# Paste the whole output into a bug report. Passwords are deliberately not printed: the password
# file is reported by account name only, and organization configs by name only.
#
# QUIET MODE says nothing at all unless something is wrong, which is what makes it usable as a
# periodic check rather than only as something to read when you already have a problem:
#   npx --no frugal-iot-diagnostic quiet        # positional, see below
#   zsh diagnostic.zsh -q
#
# The word "quiet" with no dash is not a typo. npm parses the whole command line itself and passes
# only the values through, so a flag never reaches a script run by npx - and "-q" is worse than
# most, because it is npm's OWN abbreviation for --quiet, so npm consumes it and goes quiet itself.
# "npx --no frugal-iot-diagnostic -- --quiet" also works, if you would rather remember that.
#
# Exit status, either mode:
#   0  nothing found
#   1  problems found - they are listed, and are the only thing a quiet run prints
#
# No "set -e": a failing check should report and carry on, not stop the script.
setopt no_unset 2>/dev/null

QUIET=0
for arg in "$@"; do
  case "$arg" in
    -q|--quiet|quiet) QUIET=1 ;;
    -h|--help|help)   sed -n '3,28p' "$0" | sed -e 's/^#$//' -e 's/^# //'; exit 0 ;;
    *) print -u2 "Unknown argument: $arg (try \"quiet\", or \"help\")"; exit 2 ;;
  esac
done

# Keep the real stdout on fd 3 for the summary, which prints in both modes. Under -q everything
# else - including whatever the commands being run write - goes nowhere, so a quiet run that
# prints anything is a quiet run that found something. stderr goes too: the noise it carries is
# things like sudo declining, which the checks below already turn into findings of their own.
exec 3>&1
(( QUIET )) && exec 1>/dev/null 2>/dev/null

section() { print -r -- ""; print -r -- "===== $* ====="; }
item()    { print -r -- "  $*"; }
have()    { command -v "$1" >/dev/null 2>&1; }
# Ownership and mode of a file, spelled for either Linux or BSD/macOS stat
fileinfo() {
  local f=$1
  if [[ ! -e "$f" ]]; then print -r -- "missing"; return; fi
  stat -c '%U:%G %a %s bytes' "$f" 2>/dev/null || stat -f '%Su:%Sg %Lp %z bytes' "$f" 2>/dev/null || print -r -- "(cannot stat)"
}

PROBLEMS=()
problem() { PROBLEMS+=("$1"); }

section "When and where"
item "date:        $(date 2>/dev/null)"
item "host:        $(hostname 2>/dev/null)"
item "user:        $(id -un 2>/dev/null) (groups: $(id -Gn 2>/dev/null))"
item "directory:   $PWD"

section "The machine"
have uname && item "kernel:      $(uname -srm)"
[[ -r /etc/os-release ]] && item "os:          $(grep PRETTY_NAME /etc/os-release | cut -d'"' -f2)"
[[ -r /proc/device-tree/model ]] && item "board:       $(tr -d '\0' < /proc/device-tree/model)"
have free && item "memory:      $(free -h | awk '/^Mem:/ {print $3 " used of " $2 ", " $7 " available"}')"
have df && item "disk (/):    $(df -h / | awk 'NR==2 {print $3 " used of " $2 ", " $4 " free"}')"
if have timedatectl; then
  item "clock:       $(timedatectl show -p NTPSynchronized --value 2>/dev/null | sed 's/^yes$/synchronized with a time server/; s/^no$/NOT synchronized - timestamps may be wrong/')"
fi

section "Software versions"
for c in node npm sqlite3 zsh mosquitto mosquitto_passwd mosquitto_sub; do
  if have $c; then
    case $c in
      node|npm)            item "$c: $($c -v 2>&1 | head -1)" ;;
      sqlite3)             item "$c: $(sqlite3 --version 2>&1 | awk '{print $1}')" ;;
      zsh)                 item "$c: $ZSH_VERSION" ;;
      mosquitto)           item "$c: $(mosquitto -h 2>&1 | head -1)" ;;
      *)                   item "$c: present" ;;
    esac
  else
    item "$c: NOT INSTALLED"
    [[ $c == (node|npm|sqlite3) ]] && problem "$c is not installed - see INSTALLATION.md step 3"
  fi
done

section "This installation"
for f in config.yaml config.d frugal-iot.db data ota node_modules; do
  if [[ -e $f ]]; then item "$f: present"; else item "$f: MISSING"; fi
done
[[ ! -e frugal-iot.db ]] && problem "No frugal-iot.db here - either the wrong directory, or 'npx --no frugal-iot-init' has not been run"
if [[ -d node_modules/frugal-iot-server ]]; then
  item "frugal-iot-server: $(node -e 'console.log(require("./node_modules/frugal-iot-server/package.json").version)' 2>/dev/null)"
  item "frugal-iot-client: $(node -e 'console.log(require("./node_modules/frugal-iot-client/package.json").version)' 2>/dev/null)"
  item "frugal-iot-logger: $(node -e 'console.log(require("./node_modules/frugal-iot-logger/package.json").version)' 2>/dev/null)"
  item "commands:    $(ls node_modules/.bin 2>/dev/null | grep frugal | tr '\n' ' ')"
else
  item "frugal-iot-server is not installed in this directory"
fi
# sqlite3 is the one dependency with compiled code in it. Where no ready-made binary exists for the
# platform (32-bit ARM, so any Pi Zero W or Pi 1) npm compiles it during install - and if that fails,
# npm can still report success, leaving a package directory with nothing usable inside it. Nothing
# else here looks wrong when that happens, and the server simply refuses to start.
if [[ -d node_modules/sqlite3 ]]; then
  if node -e "require('sqlite3')" >/dev/null 2>&1; then
    item "sqlite3 native module: builds and loads OK"
  else
    item "sqlite3 native module: PRESENT BUT NOT BUILT"
    problem "node_modules/sqlite3 has no compiled binding, so the server cannot start. Build it with:
      npm rebuild sqlite3 --foreground-scripts
    (about 40 minutes on a Pi Zero W; needs build-essential python3-dev python3-setuptools)"
  fi
fi
if [[ -f config.d/mqtt.yaml ]]; then item "broker configured as: $(grep -h '^broker:' config.d/mqtt.yaml 2>/dev/null)"; fi
if [[ -d config.d/organizations ]]; then
  # Names only - these files contain the broker password.
  # (N) makes a non-matching glob expand to nothing rather than erroring - and the list has to be
  # tested before use, because "ls" with no arguments would list the current directory instead.
  ORGS=(config.d/organizations/*.yaml(N:t:r))
  if (( ${#ORGS} )); then
    item "organizations: ${ORGS}"
  else
    item "organizations: none defined yet"
  fi
fi
if [[ -f frugal-iot.db ]] && have sqlite3; then
  item "accounts:    $(sqlite3 frugal-iot.db 'SELECT group_concat(username, ", ") FROM users;' 2>/dev/null)"
fi

section "Mosquitto configuration"
if [[ -f /etc/mosquitto/mosquitto.conf ]]; then
  item "/etc/mosquitto/mosquitto.conf: $(fileinfo /etc/mosquitto/mosquitto.conf)"
else
  item "/etc/mosquitto/mosquitto.conf: missing - is mosquitto installed?"
fi
item "files in /etc/mosquitto/conf.d:"
for f in /etc/mosquitto/conf.d/*(N); do
  item "  ${f}: $(fileinfo $f)"
  grep -nE '^[[:space:]]*(listener|protocol|password_file|allow_anonymous)' $f 2>/dev/null | sed 's/^/      /'
done
[[ -z "$(print -r -- /etc/mosquitto/conf.d/*(N))" ]] && problem "Nothing in /etc/mosquitto/conf.d - the Frugal IoT config was never copied there (step 5)"

# The files the broker actually reads. mosquitto's include_dir only loads names ending in .conf,
# so look at exactly those - and the last setting wins, hence "tail -1" everywhere below.
BROKER_CONF_FILES=(/etc/mosquitto/mosquitto.conf(N) /etc/mosquitto/conf.d/*.conf(N))

# Everything the broker reads, as one stream - with sudo if reading it plainly gives nothing. A
# file under /etc can be readable only by root, and an ordinary user then gets silence rather than
# an error, which is indistinguishable from "that setting is not configured". Left unguarded, the
# comparison below reported a broker as missing EVERY setting this release ships, which as a
# periodic check is worse than no check at all.
broker_conf_text() {
  local t
  (( ${#BROKER_CONF_FILES} )) || return 0
  t=$(cat "${BROKER_CONF_FILES[@]}" 2>/dev/null) || true
  if [[ -z "$t" ]] && have sudo; then
    t=$(sudo -n cat "${BROKER_CONF_FILES[@]}" 2>/dev/null) || true
  fi
  print -r -- "$t"
}

# Where the packaged copy of a shipped file is. What is in ./extras is NOT it: frugal-iot-init
# copies extras/ in and then never overwrites it, so once a release changes one of these files the
# local copy is a fossil. Checks below read the package.
PKG_EXTRAS="node_modules/frugal-iot-server/extras"
[[ -d "$PKG_EXTRAS" ]] || PKG_EXTRAS="${0:A:h:h}/extras"

# Which password file does the running configuration actually name?
CONFIGURED_PWFILE=$(broker_conf_text | grep -hE '^[[:space:]]*password_file[[:space:]]' | tail -1 | awk '{print $2}')
section "Mosquitto password file"
if [[ -n "$CONFIGURED_PWFILE" ]]; then
  item "configuration names: $CONFIGURED_PWFILE"
  item "  that file:         $(fileinfo $CONFIGURED_PWFILE)"
  if [[ ! -e "$CONFIGURED_PWFILE" ]]; then
    problem "Mosquitto is configured to use $CONFIGURED_PWFILE but that file does not exist - it will refuse to start"
  else
    # Account names only, never the hashes
    item "  accounts in it:    $(cut -d: -f1 "$CONFIGURED_PWFILE" 2>/dev/null | tr '\n' ' ')"
    [[ ! -s "$CONFIGURED_PWFILE" ]] && item "  (the file is empty - no accounts yet)"
  fi
else
  item "no password_file line found in any mosquitto configuration"
  problem "No password_file configured - the broker would allow anonymous access or reject everything"
fi
# What this release ships, against what the broker is actually running.
#
# This used to be "diff ./extras/mosquitto.conf /etc/mosquitto/conf.d/frugal-iot.conf", which
# reported a problem on every machine there has ever been, for three separate reasons: ./extras is
# a fossil frugal-iot-init will not overwrite, so it differs from the release for ever; the
# installed copy has the dynamic-security plugin's path substituted, so it differs from the shipped
# one by design; and "diff -q" against a frugal-iot.conf that does not exist fails too, which is
# the normal state of a broker whose configuration was assembled by hand as several small files in
# conf.d. A check that is always wrong is one you stop reading, so this asks the question that
# actually matters instead: is the broker missing a setting this release ships?
if [[ -f "${PKG_EXTRAS}/mosquitto.conf" ]]; then
  item "this release's mosquitto.conf names: $(grep -hE '^[[:space:]]*password_file' "${PKG_EXTRAS}/mosquitto.conf" 2>/dev/null | awk '{print $2}')"
  if (( ${#BROKER_CONF_FILES} )); then
    # The plugin line is normalised: the installer substitutes a path that varies by distribution.
    # Comparing settings rather than files means this works whether the configuration arrived as one
    # frugal-iot.conf or as several hand-written pieces.
    MISSING_CONF=$(comm -23 \
      <(sed -E 's#^plugin .*#plugin -#' "${PKG_EXTRAS}/mosquitto.conf" | grep -vE '^[[:space:]]*(#|$)' | sort -u) \
      <(broker_conf_text | sed -E 's#^plugin .*#plugin -#' | grep -vE '^[[:space:]]*(#|$)' | sort -u) 2>/dev/null)
    # password_file and the listeners are allowed to be sited differently on an older installation,
    # so a difference in those is reported without being called a fault.
    MISSING_REAL=$(print -r -- "$MISSING_CONF" | grep -vE '^[[:space:]]*(password_file|listener|protocol)[[:space:]]' || true)
    if [[ -n "$MISSING_CONF" ]]; then
      item "settings this release ships that the broker does not have:"
      print -r -- "$MISSING_CONF" | while IFS= read -r l; do [[ -n "$l" ]] && item "    $l"; done
    else
      item "the broker has every setting this release ships"
    fi
    [[ -n "$MISSING_REAL" ]] && problem "The broker is missing $(print -r -- "$MISSING_REAL" | grep -c .) setting(s) this release ships - see \"Mosquitto password file\" above. Re-run install-pi.sh, or add them by hand if this broker's config.d was written by hand."
  fi
fi
item "candidate locations, whether or not configured:"
for f in /var/lib/mosquitto/passwords /etc/mosquitto/mosquitto_passwords; do
  item "  ${f}: $(fileinfo $f)"
done
item "directories they live in:"
for d in /var/lib/mosquitto /etc/mosquitto; do
  item "  ${d}: $(fileinfo $d)"
done

section "Mosquitto service"
if have systemctl; then
  item "enabled:     $(systemctl is-enabled mosquitto 2>&1)"
  item "active:      $(systemctl is-active mosquitto 2>&1)"
  [[ "$(systemctl is-active mosquitto 2>/dev/null)" != "active" ]] && problem "Mosquitto is not running - see its own log, quoted above under 'Mosquitto service'"
  print -r -- "  --- last 12 journal lines (systemd's view: usually only an exit code) ---"
  journalctl -u mosquitto -n 12 --no-pager 2>&1 | sed 's/^/      /'
else
  item "systemctl not available on this machine"
fi
# Debian's mosquitto logs to a file rather than the journal, so this is where the real reason is.
MOSQUITTO_LOG=$(grep -hE '^[[:space:]]*log_dest[[:space:]]+file' /etc/mosquitto/mosquitto.conf /etc/mosquitto/conf.d/*(N) 2>/dev/null | tail -1 | awk '{print $3}')
[[ -z "$MOSQUITTO_LOG" ]] && MOSQUITTO_LOG=/var/log/mosquitto/mosquitto.log
item "its own log file: ${MOSQUITTO_LOG} ($(fileinfo $MOSQUITTO_LOG))"
if [[ -r "$MOSQUITTO_LOG" ]]; then
  print -r -- "  --- last 12 lines of that log (this is where startup errors appear) ---"
  tail -12 "$MOSQUITTO_LOG" 2>&1 | sed 's/^/      /'
elif [[ -e "$MOSQUITTO_LOG" ]]; then
  # The log belongs to the mosquitto user, so reading it needs privilege. Try without prompting -
  # on Raspberry Pi OS the first user has passwordless sudo, so this usually just works.
  if have sudo && MOSQUITTO_LOG_TAIL=$(sudo -n tail -12 "$MOSQUITTO_LOG" 2>/dev/null); then
    print -r -- "  --- last 12 lines of that log, read with sudo (startup errors appear here) ---"
    print -r -- "$MOSQUITTO_LOG_TAIL" | sed 's/^/      /'
  else
    item "  it belongs to $(fileinfo $MOSQUITTO_LOG | awk '{print $1}') so it cannot be read as $(id -un)."
    item "  Re-run this whole script with sudo to include it:  sudo zsh $0"
    problem "Could not read ${MOSQUITTO_LOG}, which is where Mosquitto explains itself - re-run with sudo"
  fi
fi

section "Listening ports"
PORTS=""
if have ss; then
  PORTS=$(ss -tln 2>/dev/null | grep -E ':(1883|9012|8080)\b')
elif have netstat; then
  PORTS=$(netstat -an 2>/dev/null | grep -E '[.:](1883|9012|8080) ')
else
  item "neither ss nor netstat available"
fi
if [[ -n "$PORTS" ]]; then
  print -r -- "$PORTS" | sed 's/^/  /'
else
  item "none of 1883 (mqtt), 9012 (websockets), 8080 (web) are listening"
fi

section "Frugal IoT server service"
if have systemctl; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^frugaliot.service'; then
    item "enabled:     $(systemctl is-enabled frugaliot 2>&1)"
    item "active:      $(systemctl is-active frugaliot 2>&1)"
    print -r -- "  --- last 20 journal lines ---"
    journalctl -u frugaliot -n 20 --no-pager 2>&1 | sed 's/^/      /'
  else
    item "no frugaliot service installed yet (step 8 not reached)"
  fi
else
  item "systemctl not available on this machine"
fi

section "Name resolution (steps 3, 4)"
# The broker URL in config.d/mqtt.yaml has to resolve from every machine that uses it - this one,
# and whatever browser or node talks to it.
BROKER_URL=$(grep -h '^broker:' config.d/mqtt.yaml 2>/dev/null | awk '{print $2}')
# Strip scheme, then any path (wss://host/wss), then any port - leaving just the hostname
BROKER_HOST=${${${BROKER_URL#*://}%%/*}%%:*}
if [[ -n "$BROKER_HOST" ]]; then
  item "broker host: $BROKER_HOST"
  # EVERY address, both families. A name that also offers an IPv6 address is the one way this has
  # actually bitten: a client may prefer the AAAA, and if that address is transient - a global
  # prefix from the router coming and going - connections stall while the name still resolves and
  # nothing is wrong at either end. Seen on the test Pi, where avahi registered and withdrew a
  # global IPv6 address every few minutes; `journalctl -u avahi-daemon` is where that shows.
  BROKER_ADDRS=""
  have getent && BROKER_ADDRS=$(getent ahosts "$BROKER_HOST" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
  if [[ -n "$BROKER_ADDRS" ]]; then
    item "  resolves to $BROKER_ADDRS from this machine"
    if print -r -- "$BROKER_ADDRS" | grep -q ':'; then
      item "  it offers an IPv6 address as well: a client that picks that one fails on its own if"
      item "  the address is transient. Check 'journalctl -u avahi-daemon' for it being withdrawn."
    fi
  elif have ping && ping -c1 -W2 "$BROKER_HOST" >/dev/null 2>&1; then
    item "  answers ping from this machine"
  else
    item "  DOES NOT RESOLVE from this machine"
    problem "The broker host '$BROKER_HOST' does not resolve here - the server's own logger cannot connect either"
  fi
  [[ "$BROKER_HOST" == *.local ]] && item "  note: .local names do not resolve on most Android phones - use an IP address there"
fi
MYADDRS=$( (have ip && ip -4 -o addr show scope global | awk '{print $2"="$4}') 2>/dev/null | tr '\n' ' ')
item "this machine's addresses: ${MYADDRS:-(could not determine)}"

section "Who is connected to the broker"
# The single most useful line when a node or a browser says it cannot connect: if the server's own
# logger is connected, the broker is up, listening and authenticating, and the problem is at the
# other end. That is what settled it on 7 Sep 2026, when a node reporting a failed TCP connect and a
# browser reporting a failed WebSocket handshake both turned out to have been asleep.
BROKER_CONNS=""
if have ss; then
  # Only the sockets whose LOCAL port is the broker's. A connection with both ends on this machine -
  # which is what the server's own logger is - otherwise appears twice, once from each side, and the
  # count comes out too high. With "state established" ss prints no State column, so the local
  # address is $3 and the peer $4.
  BROKER_CONNS=$(ss -tn state established 2>/dev/null |
    awk '$3 ~ /:(1883|9012)$/ {print $4 " -> " $3}' || true)
  CONN_COUNT=$(print -r -- "$BROKER_CONNS" | grep -c . || true)
  item "clients connected to 1883/9012: ${CONN_COUNT:-0}"
  if [[ -n "$BROKER_CONNS" ]]; then
    print -r -- "$BROKER_CONNS" | sed 's/^/      /'
  else
    item "  nothing is connected - not even this server's own logger"
    problem "No client is connected to the broker. If the frugaliot service is running, its logger should be - check its journal above for 'mqtt <org> connect'"
  fi
else
  item "ss not available - cannot list connections"
fi

section "Broker access control"
# An acl_file confines each account to its own organization's topics; without one, every account
# that can log in reaches every topic on the broker. Reported here because a broker installed before
# the ACL shipped will not have one, and nothing else says so.
BROKER_SETTING=""
broker_setting() {  # name -> value from the broker's own configuration, sudo only if needed
  # broker_conf_text carries the sudo fallback this used to spell out for itself
  BROKER_SETTING=$(broker_conf_text | grep -hE "^[[:space:]]*$1[[:space:]]" | tail -1 | awk '{print $2}') || true
}
broker_setting acl_file; ACLFILE="$BROKER_SETTING"
if [[ -z "$ACLFILE" ]]; then
  item "acl_file: NOT SET - every account that can log in can reach every topic, across all organizations"
  problem "The broker has no acl_file. Re-run the install script, or see INSTALLATION.md 'Turn on access control'"
else
  item "acl_file: $ACLFILE"
  if [[ -r "$ACLFILE" ]] || { have sudo && sudo -n test -r "$ACLFILE" 2>/dev/null; }; then
    ACLOWNER=$( (stat -c '%U:%G %a' "$ACLFILE" 2>/dev/null || sudo -n stat -c '%U:%G %a' "$ACLFILE" 2>/dev/null) || true)
    item "  owner/mode: ${ACLOWNER:-unknown} (mosquitto reads it after dropping privileges, so it wants mosquitto:mosquitto 600)"
  fi
fi

# The dynamic security plugin. install-pi.sh comments it out and carries on if the plugin is not
# installed, so a broker can be working correctly and still not support per-user accounts - which is
# worth saying plainly rather than leaving somebody to wonder why they cannot be created.
broker_setting plugin; DYNPLUGIN="$BROKER_SETTING"
broker_setting plugin_opt_config_file; DYNSTATE="$BROKER_SETTING"
if [[ -z "$DYNPLUGIN" ]]; then
  item "dynamic security: not configured - running on shared organization passwords (the fallback)"
  item "  per-user and per-node broker accounts are unavailable until the plugin is enabled"
  if [[ -n "$(print -rl -- /usr/lib/*/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so(N) 2>/dev/null)" ]]; then
    item "  the plugin IS installed on this machine, so re-running the install script would enable it"
    problem "mosquitto's dynamic security plugin is installed but not configured - re-run install-pi.sh"
  else
    item "  the plugin is not installed on this machine either (mosquitto package does not ship it here)"
  fi
else
  item "dynamic security: $DYNPLUGIN"
  if [[ -n "$DYNSTATE" ]]; then
    if [[ -e "$DYNSTATE" ]] || { have sudo && sudo -n test -e "$DYNSTATE" 2>/dev/null; }; then
      item "  state file: $DYNSTATE"
    else
      item "  state file: $DYNSTATE MISSING - the broker will not start"
      problem "The broker names a dynamic-security state file that does not exist: $DYNSTATE"
    fi
  fi
  # Can the server actually drive it? That needs the admin credential frugal-iot-init recorded.
  #
  # Read with a sudo fallback, and report the file's ownership, because the two ways this goes wrong
  # look identical from here: the setting really is absent, or the file belongs to somebody else and
  # an ordinary reader gets silence. The second is the one that matters, since the SERVER is an
  # ordinary reader too - it runs as the account in the unit file, and a secrets.yaml it cannot read
  # leaves it with no credential to hand a browser, whatever is written inside.
  item "  secrets file: config.d/secrets.yaml $(fileinfo config.d/secrets.yaml)"
  SERVICE_USER=$(sed -n 's/^User=//p' /etc/systemd/system/frugaliot.service 2>/dev/null | head -1)
  [[ -z "$SERVICE_USER" ]] && SERVICE_USER=$(sudo -n sed -n 's/^User=//p' /etc/systemd/system/frugaliot.service 2>/dev/null | head -1)
  secret_value() {   # name -> its value, with sudo if reading it plainly gives nothing
    local v
    v=$(sed -n "s/^$1:[[:space:]]*//p" config.d/secrets.yaml 2>/dev/null | tr -d "\"'" | head -1)
    if [[ -z "$v" ]] && have sudo; then
      v=$(sudo -n sed -n "s/^$1:[[:space:]]*//p" config.d/secrets.yaml 2>/dev/null | tr -d "\"'" | head -1)
    fi
    print -r -- "$v"
  }
  if [[ -f config.d/secrets.yaml && -n "$SERVICE_USER" ]] && have stat; then
    SECRETS_OWNER=$(stat -c '%U' config.d/secrets.yaml 2>/dev/null || true)
    if [[ -n "$SECRETS_OWNER" && "$SECRETS_OWNER" != "$SERVICE_USER" && "$SECRETS_OWNER" != root ]]; then
      problem "config.d/secrets.yaml belongs to ${SECRETS_OWNER} but the server runs as ${SERVICE_USER}, so the server cannot read it. Fix with: sudo chown ${SERVICE_USER} config.d/secrets.yaml"
    elif [[ "$SECRETS_OWNER" == root && "$SERVICE_USER" != root ]]; then
      problem "config.d/secrets.yaml belongs to root but the server runs as ${SERVICE_USER}, so the server reads nothing from it - every login is told live data is unavailable. Fix with: sudo chown ${SERVICE_USER} config.d/secrets.yaml && sudo systemctl restart frugaliot"
    fi
  fi
  # Without this a login gets no broker credential at all, whatever else is right - which shows up
  # in the dashboard as "No broker credential for this login".
  USERSECRET=$(secret_value user_secret)
  if [[ -z "$USERSECRET" ]]; then
    item "  user_secret: MISSING - no login can be given a broker credential"
    problem "config.d/secrets.yaml has no user_secret, so every login is told \"No broker credential for this login\". The server writes one at startup; if it cannot, it says so in its log."
  else
    item "  user_secret: present (each login's broker password is derived from it)"
  fi
  DYNUSER=$(secret_value dynsec_admin_user)
  DYNPW=$(secret_value dynsec_admin_password)
  if [[ -z "$DYNUSER" || -z "$DYNPW" ]]; then
    item "  admin credential: not readable in config.d/secrets.yaml - the server cannot create accounts"
    problem "dynamic security is enabled but config.d/secrets.yaml has no readable dynsec_admin_user/password, so no login gets a broker credential"
  elif have mosquitto_ctrl; then
    if DYNOUT=$(mosquitto_ctrl -h localhost -u "$DYNUSER" -P "$DYNPW" dynsec listClients 2>&1 | grep -viE 'without encryption|visible on the network'); then
      item "  admin credential works ($(print -r -- $DYNOUT | tr '\n' ' ' | cut -c1-60))"
    else
      item "  admin credential REJECTED by the broker"
      problem "The dynsec admin credential in config.d/secrets.yaml does not work - the server cannot create accounts"
    fi
  else
    item "  mosquitto_ctrl not installed - cannot test the admin credential"
  fi
  # Does the broker's state still match the database? Reporting drift is useful far more often than
  # repairing it, which is why this runs "check" and never applies anything.
  if [[ -f node_modules/frugal-iot-server/scripts/rebuild-dynsec.js ]]; then
    DYNCHECK=$(node node_modules/frugal-iot-server/scripts/rebuild-dynsec.js check 2>&1) || true
    if print -r -- "$DYNCHECK" | grep -q "matches the database"; then
      item "  broker state matches the database"
    else
      print -r -- "$DYNCHECK" | sed 's/^/    /'
      problem "The broker's accounts do not match the database - run: npx --no frugal-iot-rebuild-dynsec"
    fi
  fi
fi

section "Broker authentication (steps 5, 6)"
if have mosquitto_sub; then
  # A wrong password must be refused - that is the check in step 5
  WRONGOUT=$(mosquitto_sub -h localhost -u nobody -P wrong -t '#' -W 2 2>&1)
  if [[ "$WRONGOUT" == *"not authorised"* ]]; then
    item "wrong password: correctly refused"
  elif [[ "$WRONGOUT" == *"Connection refused"* || "$WRONGOUT" == *"Error"* ]]; then
    item "wrong password: broker did not answer - $WRONGOUT"
    problem "The broker is not answering on localhost:1883"
  else
    item "wrong password: ACCEPTED - the broker is not requiring credentials"
    problem "A wrong password was not refused - check password_file is set in the mosquitto config"
  fi
  # Then each configured organization should be able to connect with its own credentials.
  # The password is read from the config and used, never printed.
  #
  # This is the SHARED organization account, which every node and dashboard used to use. Each of
  # them now has its own (see SECURITY.md), and this account is removed by S8 - after which "no
  # mqtt_password" below is the right answer rather than a fault.
  for f in config.d/organizations/*.yaml(N); do
    ORG=${f:t:r}
    ORG_PW=$(sed -n 's/^mqtt_password:[[:space:]]*//p' "$f" 2>/dev/null | head -1 | tr -d '"'"'"'')
    if [[ -z "$ORG_PW" ]]; then
      item "organization $ORG: no mqtt_password in $f"
      continue
    fi
    ORGOUT=$(mosquitto_sub -h localhost -u "$ORG" -P "$ORG_PW" -t '#' -W 2 2>&1)
    if [[ "$ORGOUT" == *"not authorised"* ]]; then
      item "organization $ORG: REFUSED by the broker"
      problem "Organization '$ORG' cannot log in to the broker - its password in $f does not match the broker's password file (step 6)"
    elif [[ "$ORGOUT" == *"Connection refused"* ]]; then
      item "organization $ORG: broker not answering"
    else
      item "organization $ORG: authenticates, and saw $(print -r -- "$ORGOUT" | grep -c . ) message(s) in a 2 second sample"
    fi
  done
else
  item "mosquitto_sub not installed - cannot test broker logins (sudo apt install mosquitto-clients)"
fi

section "Bridge to a production server (optional)"
# A bridge relays this Pi's readings to a production server - see
# extras/mosquitto-bridge.conf.example. It is configured by a "connection" line in one of
# mosquitto's own config files, so most installations have none, which is not a problem.
BRIDGECONFS=(/etc/mosquitto/mosquitto.conf(N) /etc/mosquitto/conf.d/*.conf(N))
BRIDGENAMES=""
(( ${#BRIDGECONFS} )) && BRIDGENAMES=$(grep -hE '^[[:space:]]*connection[[:space:]]' $BRIDGECONFS 2>/dev/null | awk '{print $2}')
if [[ -z "$BRIDGENAMES" ]]; then
  item "no bridge configured - readings stay on this Pi"
else
  for b in ${(f)BRIDGENAMES}; do item "configured bridge: $b"; done
  # What it is set to relay and where. remote_password is deliberately not among these.
  item "its settings:"
  grep -hE '^[[:space:]]*(address|remote_username|remote_clientid|topic|cleansession|restart_timeout|notifications)[[:space:]]' $BRIDGECONFS 2>/dev/null | sed 's/^/      /'
  # Whether it is actually up, rather than what the configuration hoped for. With "notifications"
  # left on, the bridge publishes a retained 1 or 0 here each time it connects or drops.
  if have mosquitto_sub; then
    # Reading $SYS needs a broker login, so borrow the first organization that has one
    STATEORG=""; STATEPW=""
    for f in config.d/organizations/*.yaml(N); do
      STATEPW=$(sed -n 's/^mqtt_password:[[:space:]]*//p' "$f" 2>/dev/null | head -1 | tr -d '"'"'"'')
      if [[ -n "$STATEPW" ]]; then STATEORG=${f:t:r}; break; fi
    done
    if [[ -z "$STATEORG" ]]; then
      item "live state: no organization credentials here to read it with"
    else
      STATEOUT=$(mosquitto_sub -h localhost -u "$STATEORG" -P "$STATEPW" -v -t '$SYS/broker/connection/+/state' -W 2 2>&1 | grep -E '/state ')
      if [[ -z "$STATEOUT" ]]; then
        item "live state: the broker reported nothing - the bridge has never connected since it started"
        problem "A bridge is configured but has not reported its state - check 'address' is reachable and see the mosquitto log above"
      else
        for line in ${(f)STATEOUT}; do
          BNAME=${${(s:/:)${line%% *}}[4]}
          if [[ "${line##* }" == "1" ]]; then
            item "live state: ${BNAME} is CONNECTED to production"
          else
            item "live state: ${BNAME} is DOWN - this Pi is recording locally only"
            problem "Bridge '${BNAME}' is not connected to production - readings since it dropped will not appear there"
          fi
        done
      fi
    fi
  else
    item "mosquitto_sub not installed - cannot check whether the bridge is up"
  fi
fi

section "Web server (step 7)"
WEBPORT=$(grep -h '^port:' config.d/server.yaml 2>/dev/null | awk '{print $2}')
[[ -z "$WEBPORT" ]] && WEBPORT=8080
if have curl; then
  HOMECODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:${WEBPORT}/ 2>/dev/null)
  if [[ "$HOMECODE" == "000" ]]; then
    item "nothing is answering on port ${WEBPORT} - the server is not running"
    item "  (expected if you have not reached step 7 yet; otherwise start it, or see the frugaliot service below)"
  else
    item "GET /            -> ${HOMECODE} (expect 200)"
    item "GET /config.json -> $(curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:${WEBPORT}/config.json 2>/dev/null) (expect 401 when not logged in)"
    [[ "$HOMECODE" != "200" ]] && problem "The web server answered ${HOMECODE} rather than 200 on port ${WEBPORT}"
  fi
else
  item "curl not installed - cannot test the web server"
fi

section "Logged data (step 9)"
if [[ -d data ]]; then
  DATADIRS=(data/*(N/))
  if (( ${#DATADIRS} )); then
    for d in $DATADIRS; do
      item "${d}: $(find $d -type f 2>/dev/null | wc -l | tr -d ' ') files, newest $(ls -t $d/**/*(N.om[1]) 2>/dev/null | head -1)"
    done
  else
    item "data/ is empty - no readings logged yet, which is expected until a node reports (step 9)"
  fi
fi

section "Wear on the SD card"
# An SD card wears out from being written to, and a server logging sensor readings writes constantly
# unless told not to. This reports how much is actually being written and whether the settings that
# reduce it are in force. There is no threshold to compare against - run it twice a few days apart
# and look at the rate.
if [[ -r /proc/diskstats && -r /proc/uptime ]]; then
  # Field 10 of each line is sectors written, and a sector is 512 bytes. Take the whole card rather
  # than a partition (mmcblk0, not mmcblk0p2) so the boot partition and swap are included too.
  ROOTDEV=$( (have findmnt && findmnt -no SOURCE / 2>/dev/null) || print -r -- "" )
  ROOTDISK=${${ROOTDEV:t}%p[0-9]*}      # /dev/mmcblk0p2 -> mmcblk0
  [[ -z "$ROOTDISK" ]] && ROOTDISK=mmcblk0
  WRITTEN=$(awk -v d="$ROOTDISK" '$3 == d {print $10}' /proc/diskstats 2>/dev/null)
  UPSECS=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)
  if [[ -n "$WRITTEN" && -n "$UPSECS" && "$UPSECS" -gt 0 ]]; then
    item "device:      /dev/${ROOTDISK}"
    item "written:     $(awk -v s="$WRITTEN" 'BEGIN {printf "%.1f MB", s*512/1048576}') since boot, over $(awk -v u="$UPSECS" 'BEGIN {printf "%.1f", u/3600}') hours"
    item "  that is:   $(awk -v s="$WRITTEN" -v u="$UPSECS" 'BEGIN {printf "%.1f MB/hour", s*512/1048576/(u/3600)}')"
  else
    item "could not read write counters for /dev/${ROOTDISK} from /proc/diskstats"
  fi
else
  item "no /proc/diskstats on this machine - write counters are Linux only"
fi

# Swapping to an SD card wears it fast. On a Pi 4 there should be little or none; a Pi Zero W may
# need some. See INSTALLATION.md, "Wear and tear on the SD card".
if have free; then
  item "swap:        $(free -h | awk '/^Swap:/ {print $3 " used of " $2}')"
fi
if [[ -r /proc/sys/vm/swappiness ]]; then
  SWAPPINESS=$(< /proc/sys/vm/swappiness)
  item "swappiness:  ${SWAPPINESS} (1 means swap only when there is no alternative)"
fi
have swapon && item "swap areas:  $(swapon --show=NAME,TYPE,SIZE,USED --noheadings 2>/dev/null | tr '\n' ';' || print -r -- '(none)')"

# The journal is the other thing that writes on every event, if it is kept on disk at all
if [[ -d /var/log/journal ]]; then
  item "journal:     stored on disk in /var/log/journal - every logged line is a write"
  have journalctl && item "  using:     $(journalctl --disk-usage 2>/dev/null | sed 's/^Archived and active journals take up //')"
else
  item "journal:     kept in RAM only (no /var/log/journal), so it costs no writes"
fi

# The settings that decide how much gets logged in the first place
if [[ -f config.d/logger.yaml ]]; then
  VERBOSE=$(sed -n 's/^verbose:[[:space:]]*//p' config.d/logger.yaml 2>/dev/null | head -1)
  FLUSHSECS=$(sed -n 's/^flushseconds:[[:space:]]*//p' config.d/logger.yaml 2>/dev/null | head -1)
  item "logger verbose:      ${VERBOSE:-not set, so on - a line logged per message received}"
  item "logger flushseconds: ${FLUSHSECS:-not set, so readings are written as they arrive}"
fi
if [[ -f config.d/server.yaml ]]; then
  MORGANSET=$(sed -n 's/^morgan:[[:space:]]*//p' config.d/server.yaml 2>/dev/null | head -1)
  item "server morgan:       ${MORGANSET:-not set, so on - a line logged per HTTP request}"
fi
# Across every file the broker reads, not just frugal-iot.conf: a configuration assembled by hand
# puts this wherever it likes, and looking in one file meant a broker that logs every connect and
# disconnect was never reported as doing so.
if (( ${#BROKER_CONF_FILES} )); then
  if broker_conf_text | grep -qhE '^[[:space:]]*connection_messages[[:space:]]+false'; then
    item "mosquitto connections: not logged"
  else
    item "mosquitto connections: logged - every connect and disconnect is a write"
  fi
fi
if [[ -e "$MOSQUITTO_LOG" ]]; then
  item "mosquitto log size:  $(fileinfo $MOSQUITTO_LOG | awk '{print $3, $4}')"
else
  item "mosquitto log size:  no log file at ${MOSQUITTO_LOG}"
fi

# How much the readings themselves are taking up, and whether the old ones have been compressed
if [[ -d data ]]; then
  CSVCOUNT=$(find data -name '*.csv' 2>/dev/null | wc -l | tr -d ' ')
  GZCOUNT=$(find data -name '*.csv.gz' 2>/dev/null | wc -l | tr -d ' ')
  item "readings:    ${CSVCOUNT} csv files and ${GZCOUNT} compressed, $(du -sh data 2>/dev/null | awk '{print $1}') in total"
  # Filenames are the date, so the earliest name is the oldest day held. Both suffixes stripped
  # separately, because BSD sed (macOS) has no "\?" for an optional group.
  OLDEST=$(find data \( -name '*.csv' -o -name '*.csv.gz' \) 2>/dev/null | sed 's|.*/||; s|\.gz$||; s|\.csv$||' | sort | head -1)
  [[ -n "$OLDEST" ]] && item "  oldest day: ${OLDEST}"
fi

# The summary prints to fd 3, which is the real stdout whether or not the rest was silenced. A
# quiet run with nothing to report prints nothing at all, which is the point of it.
if (( ${#PROBLEMS} == 0 )); then
  if (( ! QUIET )); then
    print -r -- "" >&3
    print -r -- "===== Summary =====" >&3
    print -r -- "  No problems detected by these checks." >&3
    print -r -- "" >&3
  fi
  exit 0
fi
print -r -- "" >&3
print -r -- "===== Summary: ${#PROBLEMS} problem(s) =====" >&3
for p in $PROBLEMS; do print -r -- "  PROBLEM: $p" >&3; done
if (( QUIET )); then
  print -r -- "" >&3
  print -r -- "  Run it again without \"quiet\" for the whole report." >&3
fi
print -r -- "" >&3
exit 1

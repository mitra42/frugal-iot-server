# Where this machine's mosquitto keeps its configuration and files - asked of the broker's own
# configuration, never assumed. Sourced, not run:
#
#   source "${0:A:h}/broker-config.zsh"     # ${0:A} resolves the node_modules/.bin symlink
#   broker_conf_read
#   broker_setting password_file; PWFILE="$BROKER_SETTING"
#
# Machines are not laid out alike. A Pi from install-pi.sh has conf.d/frugal-iot.conf and its
# password file in /var/lib/mosquitto; production was assembled by hand as several files in conf.d
# with the password file in /etc/mosquitto; OpenWrt writes its own mosquitto.conf. Three scripts each
# had a copy of this, each slightly different, and the one thing they all got wrong is below.
#
# A conf.d file can be readable by root only - a Pi's bridge configuration holds a password, so it
# should be. Reading all the files in one grep or cat then gets the readable ones and silently skips
# that one, which is not empty and so never triggered the sudo retry - and a setting in the skipped
# file was reported as whatever an earlier file said. So each file is read on its own, with sudo when
# it cannot be read plainly, and a file that still cannot be read is listed in
# BROKER_CONF_UNREADABLE so the caller can say the answer is incomplete instead of being wrong.
#
# Set before broker_conf_read, if the defaults do not suit:
#   BROKER_CONF  the main configuration file. Default: the -c of the running service, else
#                /etc/mosquitto/mosquitto.conf. Also how the tests point this at a fixture.
#   BROKER_SUDO  how to retry an unreadable file. Default (sudo -n), which never prompts - right for
#                the diagnostic's quiet mode; a script that may prompt sets (sudo). Unused as root.
#
# Results, after broker_conf_read:
#   BROKER_CONF_FILES       every file the broker reads, in the order it reads them
#   BROKER_CONF_UNREADABLE  those of them that could not be read even with BROKER_SUDO
#   BROKER_CONF_TEXT        their contents, comments and blank lines removed, in order

: ${BROKER_CONF:=}
(( ${+BROKER_SUDO} )) || BROKER_SUDO=(sudo -n)
BROKER_CONF_FILES=()
BROKER_CONF_UNREADABLE=()
BROKER_CONF_TEXT=""
BROKER_SETTING=""

# The main configuration file. mosquitto has no default of its own - it reads nothing without -c -
# so the service's command line is the authority, and /etc/mosquitto/mosquitto.conf only the
# fallback when there is no systemd to ask (OpenWrt) or the service is not installed.
broker_conf_main() {
  local exec_start
  if [[ -n "$BROKER_CONF" ]]; then print -r -- "$BROKER_CONF"; return; fi
  if command -v systemctl >/dev/null 2>&1; then
    exec_start=$(systemctl show -p ExecStart mosquitto 2>/dev/null) || true
    if [[ "$exec_start" =~ ' -c ([^ ;]+)' ]]; then print -r -- "${match[1]}"; return; fi
  fi
  print -r -- /etc/mosquitto/mosquitto.conf
}

# One file's contents, with sudo if it cannot be read plainly. Fails if neither works.
broker_conf_cat() {
  local f=$1
  if [[ -r "$f" ]]; then
    cat -- "$f" 2>/dev/null
  elif (( EUID != 0 && ${#BROKER_SUDO} )) && command -v "${BROKER_SUDO[1]}" >/dev/null 2>&1; then
    "${BROKER_SUDO[@]}" cat -- "$f" 2>/dev/null
  else
    return 1
  fi
}

broker_conf_read() {
  local main dir f t
  local -a dirs
  BROKER_CONF_FILES=(); BROKER_CONF_UNREADABLE=(); BROKER_CONF_TEXT=""
  main=$(broker_conf_main)
  [[ -e "$main" ]] || return 0
  BROKER_CONF_FILES=("$main")
  # include_dir is only honoured in the main file, and mosquitto loads a directory's *.conf files in
  # case-sensitive alphabetical order - hence the C collation. Files not ending .conf are ignored by
  # the broker, so a stray frugal-iot.conf.bak is ignored here too.
  t=$(broker_conf_cat "$main") || { BROKER_CONF_UNREADABLE=("$main"); return 0; }
  BROKER_CONF_TEXT=$(print -r -- "$t" | grep -vE '^[[:space:]]*(#|$)') || true
  dirs=(${(f)"$(print -r -- "$BROKER_CONF_TEXT" | awk '$1 == "include_dir" {print $2}')"})
  for dir in $dirs; do
    BROKER_CONF_FILES+=(${(f)"$(LC_COLLATE=C; print -rl -- $dir/*.conf(N))"})
  done
  for f in ${BROKER_CONF_FILES[2,-1]}; do
    if t=$(broker_conf_cat "$f"); then
      # "|| true": a file of nothing but comments makes grep fail, which under the callers'
      # "set -e -o pipefail" would end them silently
      t=$(print -r -- "$t" | grep -vE '^[[:space:]]*(#|$)') || true
      BROKER_CONF_TEXT+=$'\n'"$t"
    else
      BROKER_CONF_UNREADABLE+=("$f")
    fi
  done
}

# Every configuration line whose first word matches a pattern, in the order the broker reads them:
#   broker_conf_lines 'connection|address'
broker_conf_lines() {
  print -r -- "$BROKER_CONF_TEXT" | grep -E "^[[:space:]]*($1)([[:space:]]|$)" || true
}

# The value of a setting into BROKER_SETTING - a variable rather than output, so that it can be
# called without a subshell. The last occurrence wins, as it does in mosquitto, for the settings
# where that is true (password_file, acl_file, plugin...); for per-listener ones it is only the last
# listener's, and broker_conf_lines is the thing to use.
broker_setting() {
  BROKER_SETTING=$(broker_conf_lines "$1" | tail -1 | awk '{print $2}') || true
}

# Files the configuration names, one "setting path role" per line, wherever this machine keeps them.
# The role is what a backup does with it - see BACKUP_PLAN.md:
#   backup       not recoverable any other way, so taken and put back on restore
#   tls          taken: a certificate can be re-issued, but production's were placed by hand, and
#                restoring them saves every bridge an outage. keyfile is a secret like the db.
#   rebuildable  frugal-iot-rebuild-dynsec recreates its accounts from the db - all but the admin
#                one it logs in as, whose password is in secrets.yaml, so it is taken all the same
#   package      part of the mosquitto install, not of this installation
#   live         the broker's running state or its log - stale the moment it is copied
broker_named_files() {
  broker_conf_lines 'password_file|acl_file' | awk '{print $1, $2, "backup"}'
  broker_conf_lines 'certfile|keyfile|cafile|capath|dhparamfile|crlfile' | awk '{print $1, $2, "tls"}'
  broker_conf_lines 'plugin_opt_config_file' | awk '{print $1, $2, "rebuildable"}'
  broker_conf_lines 'plugin' | awk '{print $1, $2, "package"}'
  broker_conf_lines 'persistence_location' | awk '{print $1, $2, "live"}'
  broker_conf_lines 'log_dest' | awk '$2 == "file" {print "log_dest", $3, "live"}'
}

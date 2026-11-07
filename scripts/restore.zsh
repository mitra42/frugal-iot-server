#!/usr/bin/env zsh
#
# Put back a snapshot taken by frugal-iot-backup. See BACKUP_PLAN.md.
#
# Usage, from the server's own directory, on a machine where the package is already installed:
#   npx --no frugal-iot-restore <snapshot|latest>          # say what it would do; changes nothing
#   npx --no frugal-iot-restore <snapshot|latest> state    # onto a machine laid out differently
#   npx --no frugal-iot-restore <snapshot|latest> all      # onto the layout it was taken from
# Add "force" as the last word to replace an installation that already has logins of its own.
#
# "latest" is the newest snapshot in /var/backups/frugal-iot, from whichever machine it was taken on.
#
# "state" is for a machine set up by its own installer - a rebuilt Pi, a new server, the restore
# drill. It brings back what this installation knows: the database, config.d (secrets included),
# the broker's password file, ACL file and dynamic-security state - each put wherever THIS broker's
# configuration says it keeps them. It leaves alone what describes the machine: the broker's own
# configuration, its TLS certificate, the systemd unit, and config.d/mqtt.yaml and server.yaml.
#
# "all" is for the same machine, or a copy of it: everything goes back exactly where it came from,
# and broker configuration files the snapshot does not have are moved aside, because mosquitto
# would read them too and a listener declared twice stops it starting.
#
# Either way, it first takes a snapshot of what is here now into /var/backups/frugal-iot/pre-restore,
# stops the server and the broker (every node disconnects for a few seconds), puts the files back,
# runs frugal-iot-init (so an older database gets this release's migrations) and
# frugal-iot-rebuild-dynsec, starts both again and runs the diagnostic.
#
# data/ is not in a snapshot. Copy it back from wherever it is mirrored.

set -euo pipefail
autoload -Uz is-at-least

SCRIPT="${0:A}"
# Where "latest" looks, and where the snapshot of what was here before goes (in pre-restore/)
BACKUP_DIR=${FRUGAL_IOT_BACKUPS:-/var/backups/frugal-iot}

usage() {
  sed -n '5,10p' "$SCRIPT" | sed 's/^# //' >&2
  exit 2
}

(( $# >= 1 )) || usage
SNAPARG=$1
MODE=check
FORCE=0
for a in "${@[2,-1]}"; do
  case $a in
    check|state|all) MODE=$a ;;
    force)           FORCE=1 ;;
    *)               echo "Unexpected argument: $a" >&2; usage ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
die()  { echo "Error: $*" >&2; exit 1; }
warn() { echo "Warning: $*" >&2; }
ownmode() { stat -c '%U:%G %a' "$1" 2>/dev/null || stat -f '%Su:%Sg %Lp' "$1" 2>/dev/null || echo "?:? ?"; }
as_root() {
  have sudo || die "this needs root, and there is no sudo here - run it as root"
  echo "Re-running as root..." >&2
  exec sudo -- zsh "$SCRIPT" "$@"
}

# ---- Which snapshot ----
if [[ $SNAPARG == latest ]]; then
  # Newest by the time in its name, not by mtime - a snapshot copied here from another machine has
  # the mtime of the copy. The directory is 700, so this may need root just to look.
  if [[ ! -r "$BACKUP_DIR" ]] && (( EUID != 0 )); then as_root "$@"; fi
  SNAPSHOT=""; NEWEST=""
  for f in "$BACKUP_DIR"/frugal-iot-state-*-<->-<->.tar.gz(N); do
    stamp=${${f:t}%.tar.gz}; stamp=${stamp[-15,-1]}
    [[ "$stamp" > "$NEWEST" ]] && { NEWEST=$stamp; SNAPSHOT=$f; }
  done
  [[ -n "$SNAPSHOT" ]] || die "no snapshots in $BACKUP_DIR"
else
  SNAPSHOT=${SNAPARG:A}
  [[ -e "$SNAPSHOT" ]] || die "$SNAPARG does not exist"
fi

# ---- Which installation ----
# As frugal-iot-backup: the current directory if it holds a database, else the frugaliot service's.
# The package has to be installed already - restoring is not installing.
if [[ -f ./frugal-iot.db ]]; then
  INSTALL_DIR=$PWD
else
  INSTALL_DIR=""
  have systemctl && { INSTALL_DIR=$(systemctl show -p WorkingDirectory --value frugaliot 2>/dev/null) || true; }
  [[ -n "$INSTALL_DIR" && -f "$INSTALL_DIR/frugal-iot.db" ]] ||
    die "no frugal-iot.db here - install the package and run 'npx --no frugal-iot-init' first, then run this from that directory"
fi
cd "$INSTALL_DIR"
have sqlite3 || die "sqlite3 command not found - install it with: sudo apt install sqlite3"

# ---- Root, before anything secret is unpacked ----
# Re-running under sudo replaces this process, and an EXIT trap does not fire on exec - so deciding
# after unpacking would leave a copy of every credential behind in /tmp.
if (( EUID != 0 )); then
  if [[ $MODE != check ]] && have systemctl; then as_root "$@"; fi
  [[ -r "$SNAPSHOT" ]] || as_root "$@"
fi

# Quoted: unquoted, the substitution is split into words and the %% applies to each
SERVICE_USER=${"$(ownmode frugal-iot.db)"%%:*}
SERVICE_GROUP=${${"$(ownmode frugal-iot.db)"#*:}%% *}

# ---- Unpack and check it ----
umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/frugal-iot-restore.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
tar -xpzf "$SNAPSHOT" -C "$WORK" 2>/dev/null || die "$SNAPSHOT cannot be read as a snapshot"
MANIFEST="$WORK/MANIFEST"
[[ -f "$MANIFEST" ]] || die "$SNAPSHOT has no MANIFEST - it was not made by frugal-iot-backup"
mf() { awk -F'\t' -v k="$1" '$1 == k {print $2; exit}' "$MANIFEST"; }
[[ "$(mf format)" == 2 ]] ||
  die "$SNAPSHOT was taken by a test version of frugal-iot-backup that did not record enough to restore it - take a new one"

SNAP_HOSTNAME=$(mf host)
SNAP_INSTALL=$(mf install_dir)
SNAP_CREATED=$(mf created)
SNAP_VERSION=$(mf frugal-iot-server)
HERE_VERSION=$(node -e "console.log(require('${SCRIPT:h:h}/package.json').version)" 2>/dev/null) || true

INTEGRITY=$(sqlite3 "$WORK/install/frugal-iot.db" 'PRAGMA integrity_check;' 2>/dev/null) || true
[[ "$INTEGRITY" == ok ]] || die "the database in the snapshot fails its integrity check: ${INTEGRITY:-unreadable}"
[[ -f "$WORK/install/config.d/secrets.yaml" ]] ||
  die "the snapshot has no config.d/secrets.yaml - without it no broker password can be derived"

# Every file the MANIFEST lists, as parallel arrays
M_ROLE=(); M_OWNMODE=(); M_FROM=(); M_IN=()
while IFS=$'\t' read -r kind role om from in; do
  [[ $kind == file ]] || continue
  [[ -e "$WORK/$in" ]] || die "the MANIFEST lists $in but it is not in the snapshot"
  M_ROLE+=("$role"); M_OWNMODE+=("$om"); M_FROM+=("$from"); M_IN+=("$in")
done < "$MANIFEST"

# ---- This machine's broker ----
source "${SCRIPT:h}/broker-config.zsh"
broker_conf_read
(( ${#BROKER_CONF_UNREADABLE} == 0 )) ||
  die "cannot read ${(j:, :)BROKER_CONF_UNREADABLE}, so cannot tell where this broker keeps its files - run with sudo"
here_setting() { broker_setting "$1"; print -r -- "$BROKER_SETTING"; }

# ---- The plan ----
# P_SRC (in the unpacked snapshot) -> P_DST, owned and moded as P_OWNMODE. SKIPS says why not.
P_SRC=(); P_DST=(); P_OWNMODE=(); SKIPS=(); ASIDE=()
plan() { P_SRC+=("$1"); P_DST+=("$2"); P_OWNMODE+=("$3"); }
# Where a broker file goes keeps the owner and mode the file there has now - this machine's broker
# already reads it - and only takes the snapshot's when there is nothing there yet.
broker_ownmode() { if [[ -e "$1" ]]; then ownmode "$1"; else print -r -- "$2"; fi; }

for i in {1..${#M_ROLE}}; do
  role=$M_ROLE[$i]; from=$M_FROM[$i]; src="$WORK/$M_IN[$i]"
  case $role in
    install)
      rel=${M_IN[$i]#install/}
      if [[ -d "$src" ]]; then
        for f in "$src"/**/*(.N); do
          frel="$rel/${f#$src/}"
          if [[ $MODE != all && ( $frel == config.d/mqtt.yaml || $frel == config.d/server.yaml ) && -e "$INSTALL_DIR/$frel" ]]; then
            SKIPS+=("$INSTALL_DIR/$frel - describes this machine (its broker address, port, paths); this one's is kept")
            continue
          fi
          plan "$f" "$INSTALL_DIR/$frel" "$SERVICE_USER:$SERVICE_GROUP ${${"$(ownmode "$f")"}##* }"
        done
      else
        plan "$src" "$INSTALL_DIR/$rel" "$SERVICE_USER:$SERVICE_GROUP ${M_OWNMODE[$i]##* }"
      fi
      ;;
    service|config|certfile|keyfile|cafile|capath|dhparamfile|crlfile)
      if [[ $MODE == all ]]; then
        plan "$src" "$from" "$M_OWNMODE[$i]"
      else
        case $role in
          service) SKIPS+=("$from - this machine's own systemd unit is kept: it names this machine's paths and account") ;;
          config)  SKIPS+=("$from - this machine's own broker configuration is kept") ;;
          *)       SKIPS+=("$from - a TLS file for ${SNAP_HOSTNAME}'s name; this machine keeps its own") ;;
        esac
      fi
      ;;
    password_file|acl_file|plugin_opt_config_file)
      if [[ $MODE == all ]]; then
        dst=$from
      else
        dst=$(here_setting "$role")
      fi
      if [[ -z "$dst" ]]; then
        SKIPS+=("$from - this machine's broker has no $role setting, so nothing would read it")
      else
        plan "$src" "$dst" "$(broker_ownmode "$dst" "$M_OWNMODE[$i]")"
      fi
      ;;
    *)
      SKIPS+=("$from - role '$role' is not one this version knows how to restore")
      ;;
  esac
done

# "all": a broker configuration file here that the snapshot does not have would still be read by
# mosquitto alongside the restored ones - so move it aside, out of the *.conf pattern it reads
if [[ $MODE == all ]]; then
  for f in ${BROKER_CONF_FILES[2,-1]}; do
    (( ${M_FROM[(Ie)$f]} )) || ASIDE+=("$f")
  done
fi

# An organization configured here that the snapshot does not have is left, and said so: its logger
# would keep starting, for an organization the restored database knows nothing about
EXTRA_ORGS=()
for f in "$INSTALL_DIR"/config.d/organizations/*.yaml(N); do
  [[ -e "$WORK/install/config.d/organizations/${f:t}" ]] || EXTRA_ORGS+=("${f:t:r}")
done

# ---- Refusals ----
BLOCKERS=()
LOGINS_HERE=$(sqlite3 frugal-iot.db "SELECT count(*) FROM users WHERE id > 1;" 2>/dev/null) || LOGINS_HERE=0
if (( LOGINS_HERE > 0 && ! FORCE )); then
  BLOCKERS+=("this installation already has ${LOGINS_HERE} login(s) of its own, which the restore would replace - add \"force\" if that is what you mean (a snapshot of them is taken first)")
fi
if [[ $MODE == all && "$SNAP_INSTALL" != "$INSTALL_DIR" ]]; then
  BLOCKERS+=("the snapshot was installed at $SNAP_INSTALL and this one is at $INSTALL_DIR - \"all\" puts everything back exactly where it was, so use \"state\" here")
fi
if [[ -n "$HERE_VERSION" && -n "$SNAP_VERSION" && "$SNAP_VERSION" != "not installed here" ]] && ! is-at-least "$SNAP_VERSION" "$HERE_VERSION"; then
  BLOCKERS+=("the snapshot is from frugal-iot-server $SNAP_VERSION and this is $HERE_VERSION - its database may have changes this version does not know. Upgrade here first")
fi

# ---- Say what it would do ----
echo "Snapshot:      $SNAPSHOT"
echo "  taken:       $SNAP_CREATED on $SNAP_HOSTNAME, frugal-iot-server $SNAP_VERSION, from $SNAP_INSTALL"
echo "Restoring to:  $INSTALL_DIR on $(hostname 2>/dev/null) (runs as $SERVICE_USER), frugal-iot-server ${HERE_VERSION:-unknown}"
echo "Mode:          $MODE"
echo
echo "Would put back:"
for i in {1..${#P_DST}}; do
  if [[ ! -e "$P_DST[$i]" ]]; then st="new"
  elif cmp -s "$P_SRC[$i]" "$P_DST[$i]" 2>/dev/null; then st="unchanged"
  elif [[ -r "$P_DST[$i]" ]]; then st="replaces what is there"
  # check runs as the service user, which cannot read the broker's files - ask sudo before
  # reporting an identical file as one that will be replaced
  elif (( EUID != 0 )) && have sudo && sudo -n cmp -s "$P_SRC[$i]" "$P_DST[$i]" 2>/dev/null; then st="unchanged"
  elif (( EUID != 0 )) && have sudo && sudo -n test -r "$P_DST[$i]" 2>/dev/null; then st="replaces what is there"
  else st="replaces (needs root to compare)"
  fi
  printf '  %-60s %-32s %s\n' "$P_DST[$i]" "$st" "$P_OWNMODE[$i]"
done
if (( ${#ASIDE} )); then
  echo
  echo "Would move aside, as <name>.pre-restore, because the snapshot's broker does not have them:"
  for f in $ASIDE; do echo "  $f"; done
fi
if (( ${#SKIPS} )); then
  echo
  echo "Would leave alone:"
  for s in $SKIPS; do echo "  $s"; done
fi
(( ${#EXTRA_ORGS} )) && { echo; echo "Organizations configured here and not in the snapshot, left as they are: ${EXTRA_ORGS}"; }
echo
echo "Not in a snapshot: data/ - copy it back from its mirror, e.g.  rsync -a <mirror>/data/ ${INSTALL_DIR}/data/"

if (( ${#BLOCKERS} )); then
  echo
  for b in $BLOCKERS; do echo "CANNOT: $b"; done
  [[ $MODE == check ]] && exit 1
  exit 1
fi
if [[ $MODE == check ]]; then
  echo
  echo "Nothing changed. To do it:  npx --no frugal-iot-restore $SNAPARG state   (or all - see the top of this script)"
  exit 0
fi

# ---- Do it ----
echo
# Run something as the account the server runs as, in its directory - init and rebuild-dynsec write
# files there, which must not end up owned by root
run_as() {
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    ( cd "$INSTALL_DIR" && "$@" )
  else
    sudo -u "$SERVICE_USER" -H -- zsh -c 'cd "$1" && shift && "$@"' _ "$INSTALL_DIR" "$@"
  fi
}
unit_exists() { have systemctl && systemctl cat "$1" >/dev/null 2>&1; }

echo "1. A snapshot of what is here now, in case this is the wrong thing to have done"
PRE_RESTORE="$BACKUP_DIR/pre-restore"
if zsh "${SCRIPT:h}/backup.zsh" "$PRE_RESTORE"; then
  # The one just written, so the way back can be named exactly rather than as "the newest"
  PRE_RESTORE=( $PRE_RESTORE/frugal-iot-state-*.tar.gz(Nom[1]) )
else
  (( FORCE )) || die "could not take it - add \"force\" to restore without a copy of what is here"
  warn "carrying on without it, because of \"force\""
  PRE_RESTORE=""
fi

echo "2. Stopping the server and the broker"
unit_exists frugaliot && systemctl stop frugaliot
# The plugin keeps its state in memory and rewrites its file on every change, so the broker must be
# down while that file is replaced - and it only reads it at startup anyway
unit_exists mosquitto && systemctl stop mosquitto

echo "3. Putting the files back"
for f in $ASIDE; do
  mv -- "$f" "$f.pre-restore"
  echo "  moved aside $f"
done
for i in {1..${#P_DST}}; do
  dst=$P_DST[$i]; own=${P_OWNMODE[$i]% *}; mode=${P_OWNMODE[$i]##* }
  mkdir -p "${dst:h}"
  if [[ -d "$P_SRC[$i]" ]]; then           # capath
    rm -rf -- "$dst"; cp -Rp -- "$P_SRC[$i]" "$dst"
  else
    cp -p -- "$P_SRC[$i]" "$dst.restoring"
    mv -f -- "$dst.restoring" "$dst"
  fi
  chmod "$mode" "$dst" 2>/dev/null || warn "could not set mode $mode on $dst"
  # The snapshot's owner may not exist here (production's "mitra" on a Pi) - then whoever owns the
  # installation, which is the account that has to read it
  if [[ "${"$(ownmode "$dst")"% *}" != "$own" ]]; then
    chown "$own" "$dst" 2>/dev/null || chown "$SERVICE_USER:$SERVICE_GROUP" "$dst" 2>/dev/null ||
      warn "could not set the owner of $dst to $own"
  fi
  echo "  $dst"
done
[[ $MODE == all ]] && have systemctl && systemctl daemon-reload

echo "4. Starting the broker"
if unit_exists mosquitto; then
  systemctl start mosquitto || true
  for n in {1..10}; do
    [[ "$(systemctl is-active mosquitto 2>/dev/null)" == active ]] && break
    sleep 1
  done
  if [[ "$(systemctl is-active mosquitto 2>/dev/null)" != active ]]; then
    echo "The broker did not start. The server has been left stopped." >&2
    echo "See why:      journalctl -u mosquitto -n 30 --no-pager   (and its own log, named in its configuration)" >&2
    [[ -n "$PRE_RESTORE" ]] && echo "Put it back:  npx --no frugal-iot-restore $PRE_RESTORE all force" >&2
    exit 1
  fi
fi

echo "5. Bringing the database up to this release (frugal-iot-init)"
run_as zsh "${SCRIPT:h}/init.zsh" >/dev/null || warn "frugal-iot-init reported a problem - run it by hand to see it"

broker_conf_read
broker_setting plugin
if [[ -n "$BROKER_SETTING" ]]; then
  echo "6. Making the broker's accounts match the database (frugal-iot-rebuild-dynsec)"
  run_as node "${SCRIPT:h}/rebuild-dynsec.js" || warn "frugal-iot-rebuild-dynsec failed - run it by hand to see why"
else
  echo "6. (no dynamic-security plugin on this broker - accounts come from its password file)"
fi

echo "7. Starting the server"
unit_exists frugaliot && systemctl start frugaliot

echo "8. Checking"
if [[ -n "$BROKER_SETTING" ]]; then
  run_as node "${SCRIPT:h}/rebuild-dynsec.js" check || warn "the broker's accounts do not match the database - see above"
fi
if run_as zsh "${SCRIPT:h}/diagnostic.zsh" quiet; then
  echo "  the diagnostic finds nothing wrong"
else
  warn "the diagnostic found something - run 'npx --no frugal-iot-diagnostic' for the whole report"
fi

echo
echo "Restored $SNAPSHOT."
if [[ -n "$PRE_RESTORE" ]]; then
  echo "What was here before is in $PRE_RESTORE - to go back: npx --no frugal-iot-restore $PRE_RESTORE all force"
else
  echo "Nothing was kept of what was here before."
fi
echo "data/ is not in a snapshot - copy it back from its mirror if this machine lost it."
(( ${#EXTRA_ORGS} )) && echo "Still configured here and not in the snapshot: ${EXTRA_ORGS} - remove config.d/organizations/<org>.yaml if it should not be."
exit 0

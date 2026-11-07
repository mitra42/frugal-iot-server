#!/usr/bin/env zsh
#
# Take a snapshot of this installation's STATE - everything that cannot be rebuilt from the
# package, a release or the database - as one archive. See BACKUP_PLAN.md for what is in it and why.
#
# Usage, from the server's own directory (or anywhere, once the frugaliot service is installed):
#   npx --no frugal-iot-backup check       # say what would be taken, from where; writes nothing
#   npx --no frugal-iot-backup             # take one, into /var/backups/frugal-iot
#   npx --no frugal-iot-backup <dir>       # take one into <dir> (an absolute path), pruning nothing there
#   npx --no frugal-iot-backup install     # run it nightly, from a systemd timer
#
# Positional, never --flags: npm swallows those (see "Shell scripts" in CLAUDE.md).
#
# Not in the snapshot:
#   data/   large and append-only - mirrored by rsync instead (BACKUP_PLAN.md, "Two streams")
#   ota/    rebuilt at every release
#   anything mosquitto can rebuild or is running on: its plugin, retained messages, its log
#
# A snapshot holds every credential this server has - the db, secrets.yaml, the broker's password
# file, a TLS key - so it is mode 600, owned by the account the server runs as, in a directory
# nobody else can enter. Taking one needs root, because several of those are root- or
# mosquitto-only; run as anyone else it re-runs itself with sudo. "check" does not need root.
#
# The broker's files are found by asking its own configuration (scripts/broker-config.zsh), never
# assumed: production is laid out nothing like a Pi.

set -euo pipefail
zmodload zsh/datetime

SCRIPT="${0:A}"

usage() {
  sed -n '6,11p' "$SCRIPT" | sed 's/^# //' >&2
  exit 2
}

MODE=backup
DEST=/var/backups/frugal-iot
PRUNE=1     # only the timer's own directory - see "prune" below
case "${1:-}" in
  "")              ;;
  check)           MODE=check ;;
  install)         MODE=install ;;
  help|-h|--help)  usage ;;
  /*)              DEST=$1; PRUNE=0 ;;
  *)               echo "Unexpected argument: $1" >&2; usage ;;
esac
(( $# <= 1 )) || usage

# How many to keep. Each tier keeps the newest snapshot in each of its most recent N periods that
# have one - so with the nightly timer: a week of dailies, a month of weeklies, three months of
# monthlies, a year of quarterlies, and one a year for ever. A snapshot may count in several tiers.
# Counting periods that HAVE a snapshot, rather than calendar periods, means a timer that stopped
# for a while does not get its last good snapshots pruned away when it starts again.
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=3
KEEP_QUARTERLY=4
KEEP_YEARLY=0       # 0 = no limit

have() { command -v "$1" >/dev/null 2>&1; }
die()  { echo "Error: $*" >&2; exit 1; }
# Owner and mode of a file, spelled for Linux or BSD/macOS stat
ownmode() { stat -c '%U:%G %a' "$1" 2>/dev/null || stat -f '%Su:%Sg %Lp' "$1" 2>/dev/null || echo "?:? ?"; }

# ---- Where is the installation? ----
# The current directory if it holds the database, as for every other script here; otherwise wherever
# the frugaliot service runs - which is what lets the timer run this from anywhere.
SERVICE_UNIT=""
if have systemctl; then
  SERVICE_UNIT=$(systemctl show -p FragmentPath --value frugaliot 2>/dev/null) || true
fi
if [[ -f ./frugal-iot.db ]]; then
  INSTALL_DIR=$PWD
else
  INSTALL_DIR=""
  if have systemctl; then
    INSTALL_DIR=$(systemctl show -p WorkingDirectory --value frugaliot 2>/dev/null) || true
  fi
  [[ -n "$INSTALL_DIR" && -f "$INSTALL_DIR/frugal-iot.db" ]] ||
    die "no frugal-iot.db here, and no frugaliot service saying where one is - run this from the server's own directory"
fi
cd "$INSTALL_DIR"
have sqlite3 || die "sqlite3 command not found - install it with: sudo apt install sqlite3"

# The account the server runs as owns the database, and will own the snapshots - so the offsite pull
# can log in as that account and needs nothing more. Not $USER: under sudo or the timer that is root.
# Quoted: unquoted, the substitution is split into words and the %% applies to each - "mitra 644"
SERVICE_USER=${"$(ownmode frugal-iot.db)"%%:*}
# The machine's own name, for telling snapshots apart once they are all on one laptop. Not $HOST,
# which zsh ties to the real hostname and is not ours to assign (see CLAUDE.md).
SNAP_HOST=$(hostname -s 2>/dev/null || hostname)

# ---- What would be taken ----
# Parallel arrays, one entry per file or directory:
#   ITEM_SRC   absolute path it comes from
#   ITEM_DST   path inside the archive: install/... for this installation, fs/<absolute path> otherwise
#   ITEM_ROLE  what it is: install, service, config (a broker configuration file), or for a file the
#              broker's configuration names, the setting that names it - password_file, keyfile... -
#              because that is what lets a restore put it wherever ANOTHER machine's broker keeps it
ITEM_SRC=(); ITEM_DST=(); ITEM_ROLE=()
typeset -A TAKEN
add_item() {  # role src dst
  [[ -n "${TAKEN[$2]:-}" ]] && return 0
  TAKEN[$2]=1
  ITEM_ROLE+=("$1"); ITEM_SRC+=("$2"); ITEM_DST+=("$3")
}
add_item install "$INSTALL_DIR/frugal-iot.db" install/frugal-iot.db
add_item install "$INSTALL_DIR/config.yaml"   install/config.yaml
add_item install "$INSTALL_DIR/config.d"      install/config.d
[[ -n "$SERVICE_UNIT" && -e "$SERVICE_UNIT" ]] && add_item service "$SERVICE_UNIT" "fs$SERVICE_UNIT"

source "${SCRIPT:h}/broker-config.zsh"
broker_conf_read
for f in $BROKER_CONF_FILES; do add_item config "$f" "fs$f"; done
SKIPPED=()
while read -r setting named role; do
  [[ -n "${named:-}" ]] || continue
  case $role in
    backup|tls)  add_item "$setting" "$named" "fs$named" ;;
    # Every account in it is rebuilt from the db - except the admin one the rebuild logs in AS,
    # whose password is in secrets.yaml. So a restore puts this back alongside secrets.yaml, and
    # the two agree; restoring secrets.yaml alone onto another broker locks the server out of it.
    rebuildable) add_item "$setting" "$named" "fs$named" ;;
    *)           SKIPPED+=("$setting $named ($role)") ;;
  esac
done < <(broker_named_files)

# ---- Root, when it is needed ----
# Installing the timer always needs it. Taking a snapshot needs it whenever anything to be taken is
# not readable as we are - on any machine with a broker, that is its password file at least.
as_root() {
  have sudo || die "this needs root, and there is no sudo here - run it as root"
  echo "Re-running as root, which can read the broker's files..." >&2
  exec sudo -- zsh "$SCRIPT" "$@"
}
if (( EUID != 0 )); then
  if [[ $MODE == install ]]; then
    as_root "$@"
  elif [[ $MODE == backup ]]; then
    (( ${#BROKER_CONF_UNREADABLE} )) && as_root "$@"
    for f in $ITEM_SRC; do
      [[ ! -e "$f" || -r "$f" ]] || as_root "$@"
    done
  fi
fi

# Can each be read, and does it exist at all? A root-only file is only a problem if we are root and
# still cannot see it; in "check" as an ordinary user it is exactly what the timer, as root, will take.
PROBLEMS=()
item_state() {  # src -> "ok", "needs root" or "MISSING"
  if [[ -r "$1" ]]; then echo ok
  elif [[ -e "$1" ]] || { (( EUID != 0 )) && have sudo && sudo -n test -e "$1" 2>/dev/null; }; then echo "needs root"
  elif (( EUID != 0 )) && have sudo && ! sudo -n true 2>/dev/null; then echo "cannot tell without sudo"
  else echo MISSING
  fi
}

# ---- check ----
if [[ $MODE == check ]]; then
  echo "Installation:  $INSTALL_DIR (runs as $SERVICE_USER)"
  echo "Snapshots go:  $DEST"
  echo
  echo "Would take:"
  for i in {1..${#ITEM_SRC}}; do
    st=$(item_state "$ITEM_SRC[$i]")
    if [[ $st == ok ]]; then
      size=$(du -sh "$ITEM_SRC[$i]" 2>/dev/null | awk '{print $1}') || true
      st="ok, ${size:-?}, $(ownmode "$ITEM_SRC[$i]")"
    fi
    printf '  %-22s %s: %s\n' "$ITEM_ROLE[$i]" "$ITEM_SRC[$i]" "$st"
    [[ $st == MISSING ]] && PROBLEMS+=("$ITEM_SRC[$i] is named by the configuration but does not exist")
  done
  (( ${#BROKER_CONF_FILES} )) || echo "  (no mosquitto configuration at $(broker_conf_main) - nothing of the broker's to take)"
  if (( ${#BROKER_CONF_UNREADABLE} )); then
    echo "  NOT READABLE without sudo: ${(j:, :)BROKER_CONF_UNREADABLE} - files it names are missing above"
  fi
  if (( ${#SKIPPED} )); then
    echo
    echo "Named by the broker's configuration, deliberately not taken:"
    for s in $SKIPPED; do echo "  $s"; done
  fi
  echo
  echo "Not taken: data/ (mirrored separately) and ota/ (rebuilt each release)."
  echo
  if [[ -d "$DEST" ]] || { have sudo && sudo -n test -d "$DEST" 2>/dev/null; }; then
    SNAPS=$( (ls -1 "$DEST" 2>/dev/null || sudo -n ls -1 "$DEST" 2>/dev/null) | grep -c '^frugal-iot-state-.*\.tar\.gz$') || true
    echo "Existing snapshots in $DEST: ${SNAPS:-0} ($(ownmode "$DEST"))"
  else
    echo "$DEST does not exist yet - the first snapshot creates it"
  fi
  df -Pk "${DEST:h}" 2>/dev/null | awk 'NR==2 {printf "Free space there: %d MB\n", $4/1024}' || true
  if have systemctl; then
    # is-enabled prints "not-found" AND fails for a unit that does not exist, so test its answer,
    # not its exit status - or both get printed
    TIMER_STATE=$(systemctl is-enabled frugal-iot-backup.timer 2>/dev/null) || true
    [[ -z "$TIMER_STATE" || "$TIMER_STATE" == not-found ]] && TIMER_STATE="not installed - npx --no frugal-iot-backup install"
    echo "Timer: $TIMER_STATE"
  fi
  if (( ${#PROBLEMS} )); then
    echo
    for p in $PROBLEMS; do echo "PROBLEM: $p"; done
    exit 1
  fi
  exit 0
fi

# ---- install: a nightly systemd timer ----
# Written here rather than shipped in extras/, because the paths in it are this machine's: where the
# installation is, where zsh is. A changed extras/ file never reaches /etc on its own anyway (see
# CLAUDE.md), so generating it is also what keeps a re-run current.
if [[ $MODE == install ]]; then
  have systemctl || die "no systemd here - run '$SCRIPT' nightly from cron instead"
  TMPDIR_UNITS=$(mktemp -d)
  trap 'rm -rf "$TMPDIR_UNITS"' EXIT
  cat > "$TMPDIR_UNITS/frugal-iot-backup.service" <<EOF
# Written by frugal-iot-backup install - re-run that rather than editing this.
[Unit]
Description=Frugal IoT state snapshot (frugal-iot-backup)
After=frugaliot.service

[Service]
Type=oneshot
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v zsh) ${SCRIPT}
# Root, which is the point: it reads the broker's root- and mosquitto-only files
Nice=10
IOSchedulingClass=idle
EOF
  cat > "$TMPDIR_UNITS/frugal-iot-backup.timer" <<EOF
# Written by frugal-iot-backup install - re-run that rather than editing this.
[Unit]
Description=Nightly Frugal IoT state snapshot

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=20min
# A Pi switched off at 03:17 takes the missed one when it next boots
Persistent=true

[Install]
WantedBy=timers.target
EOF
  CHANGED=0
  for u in frugal-iot-backup.service frugal-iot-backup.timer; do
    if cmp -s "$TMPDIR_UNITS/$u" "/etc/systemd/system/$u" 2>/dev/null; then
      echo "  kept    /etc/systemd/system/$u (already current)"
    else
      install -o root -g root -m 644 "$TMPDIR_UNITS/$u" "/etc/systemd/system/$u"
      echo "  wrote   /etc/systemd/system/$u"
      CHANGED=1
    fi
  done
  (( CHANGED )) && systemctl daemon-reload
  systemctl enable --now frugal-iot-backup.timer
  systemctl list-timers frugal-iot-backup.timer --no-pager || true
  echo
  echo "Take the first one now, rather than waiting for tonight:"
  echo "  sudo systemctl start frugal-iot-backup && journalctl -u frugal-iot-backup -n 20 --no-pager"
  exit 0
fi

# ---- backup ----
umask 077
for i in {1..${#ITEM_SRC}}; do
  [[ -e "$ITEM_SRC[$i]" ]] || die "$ITEM_SRC[$i] ($ITEM_ROLE[$i]) does not exist - run 'frugal-iot-backup check'"
done
(( ${#BROKER_CONF_UNREADABLE} == 0 )) || die "could not read ${(j:, :)BROKER_CONF_UNREADABLE}, even as root"

mkdir -p "$DEST"
chown "$SERVICE_USER" "$DEST"
chmod 700 "$DEST"

STAMP=$(strftime '%Y%m%d-%H%M%S' $EPOCHSECONDS)
NAME="frugal-iot-state-${SNAP_HOST}-${STAMP}.tar.gz"
# Built beside the destination and renamed into place, so a snapshot that exists is a whole one -
# a run killed part-way leaves only the hidden staging directory, removed on exit
STAGE=$(mktemp -d "$DEST/.staging.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
SNAP="$STAGE/snap"
mkdir -p "$SNAP/install"

for i in {1..${#ITEM_SRC}}; do
  src=$ITEM_SRC[$i]; dst="$SNAP/$ITEM_DST[$i]"
  mkdir -p "${dst:h}"
  if [[ $ITEM_DST[$i] == install/frugal-iot.db ]]; then
    # Never cp a database the server is writing to: .backup takes a consistent copy while it runs
    sqlite3 "$src" ".backup '${dst}'"
    INTEGRITY=$(sqlite3 "$dst" 'PRAGMA integrity_check;') || true
    [[ "$INTEGRITY" == ok ]] || die "the copied database fails its integrity check: ${INTEGRITY:-no answer}"
  else
    cp -Rp -- "$src" "$dst"
  fi
done

# What a restore needs to know that the archive does not say by itself: where each thing came from
# and who owned it - a laptop extracting this as an ordinary user loses the owners.
{
  echo "# Frugal IoT state snapshot - see BACKUP_PLAN.md"
  # 2: the role of a broker file is the setting that named it. frugal-iot-restore refuses others.
  echo "format	2"
  echo "created	$(strftime '%Y-%m-%dT%H:%M:%S%z' $EPOCHSECONDS)"
  echo "host	$(hostname 2>/dev/null)"
  echo "install_dir	$INSTALL_DIR"
  echo "service_user	$SERVICE_USER"
  for p in frugal-iot-server frugal-iot-client frugal-iot-logger; do
    v=$(node -e "console.log(require('./node_modules/$p/package.json').version)" 2>/dev/null) || true
    echo "$p	${v:-not installed here}"
  done
  v=""
  have mosquitto && { v=$( (set +o pipefail; mosquitto -h 2>&1 | head -1) ) || true; }
  echo "mosquitto	${v:-not installed here}"
  echo "broker_conf	$(broker_conf_main)"
  echo "tables	$(sqlite3 "$SNAP/install/frugal-iot.db" "SELECT group_concat(name, ' ') FROM sqlite_master WHERE type='table';")"
  echo "# file	role	owner:group mode	from	in archive"
  for i in {1..${#ITEM_SRC}}; do
    echo "file	$ITEM_ROLE[$i]	$(ownmode "$ITEM_SRC[$i]")	$ITEM_SRC[$i]	$ITEM_DST[$i]"
  done
  for s in $SKIPPED; do echo "skipped	$s"; done
} > "$SNAP/MANIFEST"

tar -czf "$STAGE/$NAME" -C "$SNAP" .
# Read it back before trusting it: a truncated archive on a full disk otherwise looks like a backup
tar -tzf "$STAGE/$NAME" >/dev/null || die "the archive just written cannot be read back"
chown "$SERVICE_USER" "$STAGE/$NAME"
chmod 600 "$STAGE/$NAME"
mv "$STAGE/$NAME" "$DEST/$NAME"
echo "wrote $DEST/$NAME ($(du -h "$DEST/$NAME" | awk '{print $1}'), ${#ITEM_SRC} items)"

# ---- prune ----
# Only in the default directory: one named on the command line is the caller's. frugal-iot-restore
# keeps its undo points in pre-restore/, and pruning there to one a day deleted the previous undo
# point - the snapshot a second restore that day was being asked to put back.
(( PRUNE )) || exit 0
# Only this machine's snapshots, by name - so a directory that also holds copies pulled from
# elsewhere, or anything else at all, is left alone. Newest first; names sort by time.
typeset -A SEEN COUNT
# tier <name> <period> <limit>: keep this snapshot if it is the first (so newest) seen in its period,
# and that tier has not yet filled its limit of periods
tier() {
  [[ -z "${SEEN[$1:$2]:-}" ]] || return 0
  (( $3 == 0 || ${COUNT[$1]:-0} < $3 )) || return 0
  SEEN[$1:$2]=1
  COUNT[$1]=$(( ${COUNT[$1]:-0} + 1 ))
  keep=1
}
for f in "$DEST"/frugal-iot-state-${SNAP_HOST}-<->-<->.tar.gz(N.On); do
  stamp=${${f:t}#frugal-iot-state-${SNAP_HOST}-}
  day=${stamp[1,8]}
  strftime -r -s secs '%Y%m%d' "$day" 2>/dev/null || continue
  keep=0
  tier daily     "$day"                                          $KEEP_DAILY
  tier weekly    $(( secs / 604800 ))                            $KEEP_WEEKLY
  tier monthly   "${day[1,6]}"                                   $KEEP_MONTHLY
  tier quarterly "${day[1,4]}q$(( (${day[5,6]} - 1) / 3 + 1 ))"  $KEEP_QUARTERLY
  tier yearly    "${day[1,4]}"                                   $KEEP_YEARLY
  if (( ! keep )); then
    rm -f -- "$f"
    echo "pruned ${f:t}"
  fi
done

# Backup and restore - plan

Status: plan, nothing built yet. Moving an organization between servers (export/import) is a
**separate project** - see the end.

## Why

Today's backups are hand copies (`frugal-iot.db.20260730` and friends in the working directory) and
the `.bak-` that `frugal-iot-init` makes before a migration. Nothing runs on a schedule, nothing goes
offsite, and nothing has ever been restored - and a backup that has never been restored is a hope,
not a backup.

## What state there is

Sorted by the two questions that decide what to do with it: can it be rebuilt, and is it secret.

| State | Rebuildable? | Secret? | In the backup |
| --- | --- | --- | --- |
| `frugal-iot.db` | **No** | **Yes** - see below | State snapshot |
| `config.d/secrets.yaml` | **No** - a new `user_secret` changes every derived broker password | **Yes** | State snapshot |
| `data/` | **No** | No (today) | Data mirror |
| `config.d/organizations/` | From the repo | No (`mqtt_password` is being retired) | State snapshot, because it is tiny - and production has `litefarm` and `myfarm`, which the repo does not |
| Broker: `aclfile`, `conf.d/*`, Pi bridge conf, systemd unit | Partly, by re-running the installer and `addbridge-*` - but production was assembled by hand | Pi bridge conf: yes | State snapshot |
| Broker: password file | Shrinking as nodes move to dynsec; until then, no | **Yes** | State snapshot |
| Broker: `dynamic-security.json` | **Yes** - `frugal-iot-rebuild-dynsec` from db + secrets | | Not needed; included as a cross-check only |
| `ota/` | Yes - rebuilt every release anyway | No | No |
| Broker TLS `certfile`/`keyfile` | Yes, re-issued - but production's were placed by hand, and restoring them spares every bridge an outage | `keyfile`: yes | State snapshot |
| Broker plugin `.so`, `persistence_location` (retained messages), log | Part of mosquitto / running state; nodes republish | | No |

What the db holds that is secret: user password hashes, **`nodes.password` in plaintext**, `bridges`
tokens, `grafana_tokens`, `api_platforms.auth_token`, and possibly credentials inside
`forwarders.config`.

So **the database plus `secrets.yaml` is everything**: with those two, rebuild-dynsec recreates every
broker account, every enrolled node's included. Without them the fleet is stranded. It also means a
full backup is equivalent to owning the server, which decides who may make one and how it travels.

## Flagged: `nodes.password` is plaintext

It is stored as the password itself because dynsec's `createClient` / `setClientPassword` take a
plaintext password, and rebuild-dynsec needs to be able to send it again. But it means anyone with a
copy of the db - including any backup - can impersonate every enrolled node, and the backups multiply
the number of copies. Options, cheapest first:

1. **Encrypt the column with a key derived from `user_secret`** (as the derived passwords already
   are). A db leaked on its own is then harmless; db + secrets is still everything, which is no worse
   than today. Rebuild keeps working. Needs a migration of existing rows.
2. **Store dynsec's own salted hash instead**, and on rebuild write the client into
   `dynamic-security.json` directly rather than through the plugin's commands. The server would never
   hold the password at all after enrolment - but a rebuild then needs the broker stopped, and it
   ties us to the plugin's file format.
3. **Leave it, and rely on backups being encrypted** (below). Covers backups, not the live db.

Option 1 looks right. A separate change, but worth doing before backups start being copied around.

## Two streams, not one archive

**State snapshot** - small (KB to a few MB), versioned, frequent:

* the db, by `sqlite3 .backup` (or `VACUUM INTO`) - never `cp` while the server is writing to it
* `config.d/`, including `secrets.yaml`
* the broker files listed above, wherever this machine keeps them (next section)
* the systemd unit, and a `MANIFEST` - hostname, date, package versions, db schema, and **the path
  each file was taken from**

Nightly, keeping locally the newest of each of the last 7 days, 4 weeks, 3 months and 4 quarters,
and of every year.

**Data mirror** - large, incremental, unversioned:

* `rsync -a` of `data/`. Once housekeeping has gzipped a day it never changes again, so each run
  copies only the last day or two.
* Not copied on the machine itself: a second copy on the same disk protects against nothing that
  matters for data. Local snapshots are for *mistakes* (a bad migration, an `rm`); offsite is for
  losing the machine.
* Offsite **without `--delete`**, so the offsite copy keeps what `deleteafterdays` or the free-space
  rule remove - the server can hold weeks while the archive holds years.
* Wrinkle: a day goes `X.csv` → `X.csv.gz`, so the mirror ends up with both. The restore should
  prefer the `.gz`; a sweep can tidy the mirror occasionally.

## It has to work on production, which is not laid out like a Pi

The current scripts assume the Pi's layout and complain on production (`frugal-iot.conf` absent,
password file at `/etc/mosquitto/mosquitto_passwords`, broker config split across
`mosquitto.conf`, `zx-…dynsec.conf`, `zy-…acl.conf`, `zz-…bridge.conf`, no `mosquitto_ctrl`). A backup
that assumes paths will either fail there or - worse - succeed while quietly missing a file. So:

* **Ask the broker, never assume.** `broker_setting` in `scripts/diagnostic.zsh` already reads the
  broker's own configuration (`mosquitto.conf` plus `conf.d/*.conf`, last wins, sudo when needed) for
  `acl_file`, `plugin_opt_config_file`. Extend it to `password_file` and the bridge files, move it to
  a shared helper, and have the diagnostic, `addorganization` and the backup all use it - that is
  three copies of the same discovery today.
* **Take the whole of `/etc/mosquitto/conf.d/`**, not the file names we expect - production's are
  named differently, and a hand-assembled broker is a normal thing to have.
* **Install directory from the systemd unit** (`WorkingDirectory`), or the current directory when run
  by hand - production is `/var/www/frugal-iot`, not where a Pi puts it.
* **Record where each file came from** in the `MANIFEST`, so a restore puts it back there, or says
  plainly that the target machine is laid out differently.
* **Nothing needs `mosquitto_ctrl`**: rebuild-dynsec is node, and works on production already.
* **An empty read is a failure, not an empty file.** Per the shell rules in CLAUDE.md: retry with
  sudo, and if still empty, stop and say so.
* **A `check` mode** that lists what would be captured and from where, without writing anything. Run
  that on production first.

## Commands

All zsh, positional arguments, runnable via `npx --no`.

**`frugal-iot-backup [check|destdir]`**
Writes `frugal-iot-state-<host>-<timestamp>.tar.gz`, mode 600, into `/var/backups/frugal-iot/` by
default, then prunes that directory (never one named on the command line - restore keeps its undo
points in one). Run as **root from a systemd timer**, not from inside the server like
housekeeping: it has to read root- and mosquitto-only files, and it should work when the server is
down. The directory is owned by the service user so the offsite pull can read it.

**`frugal-iot-restore <snapshot|latest> [check|state|all] [force]`** - built.
`check` (the default) says what it would do. `state` restores onto a machine its own installer set
up: db, `config.d/`, and the broker's password, ACL and dynsec files, each to wherever THAT broker's
configuration keeps them - which is why the manifest records the setting that named each file. It
keeps the machine's own broker configuration, TLS, systemd unit, `mqtt.yaml` and `server.yaml`. `all`
puts everything back where it came from, and moves aside broker configuration the snapshot lacks.
Both take a pre-restore snapshot first, stop server and broker, run `frugal-iot-init` (migrations
for an older db) and `rebuild-dynsec`, restart, then `rebuild-dynsec check` and the diagnostic.
Refuses without `force` if the machine already has logins, and refuses a snapshot from a newer
release than is installed. Organizations here but not in the snapshot are moved to `organizations.pre-restore/` -
outside `config.d/`, because the config reader loads every file in it whatever its extension.
From the first change on it runs as the transient unit `frugal-iot-restore` (`systemd-run --wait`),
so a dropped ssh session cannot stop it with the services down; `restore-in-progress` in the backup
directory marks a run in progress, a trap restarts broker and server if it stops early, and the
diagnostic reports a leftover marker with the command that finishes the job.

The dynsec JSON goes back with `secrets.yaml` because it holds the admin account whose password is
in `secrets.yaml`: restoring the secrets alone onto another broker locks the server out of it.

**`frugal-iot-backup verify <snapshot>`**
Unpacks into a scratch directory, opens the db, checks the schema, parses `secrets.yaml`. Run after
each backup.

**Restore drill**: restore production's latest snapshot onto the test Pi at least once per release.
That is the only real test - and it is also the case where the layouts differ.

## Offsite: pulled from the laptop

* **Pull, don't push.** The server holds no credential to anywhere else, so a compromised server
  cannot reach or delete the offsite copies.
* `rsync -e ssh`, not plain sftp - incremental and resumable on a poor link.
* The laptop's key on the server gets a forced command `rrsync -ro /var/backups/frugal-iot` (plus
  `data/`): read those, nothing else, no shell.
* **In the clear for now**, snapshots and data alike: it makes testing a restore easier, the data is
  not sensitive today, and the laptop is secure enough to hold it. But a snapshot holds every
  credential (see above), so TODO-BACKUP-ENCRYPT: encrypt snapshots with `age` to a public key whose
  private half is on the laptop - so the server writes backups it cannot read back - when any of
  these changes: a second offsite copy, readings becoming sensitive (TODO-S16), or the backup
  directory being synced anywhere.
* Run by launchd on the laptop, and **complain loudly if the newest snapshot is more than two days
  old** - a broken timer otherwise looks exactly like a working one.

## Who can do what

* **Backup and restore: CLI only, root or the service user, never over the web.** It hands over every
  credential the server has.
* Nothing here gives an org admin anything they do not have now. Per-org export, and what an admin
  may take out, belongs to the export/import project.

## Order

1. Shared broker-config discovery helper; switch the diagnostic to it; confirm on production that it
   finds everything (this alone should fix the false alarms there).
2. `frugal-iot-backup` with `check`, then the timer and pruning, on production.
3. `frugal-iot-restore` and the drill on the test Pi. Until this has worked once, step 2 is unproven.
4. Offsite pull: `rrsync` key, data mirror without `--delete`, staleness alarm.
5. Encrypt `nodes.password` (option 1 above) - independent, can go anywhere after 2.

## Pis and OpenWRT - to come back to

Probably need **both** streams, and arguably more than production does: an SD card is a far likelier
thing to lose than a VM's disk. The intent is the same shape - state snapshot plus data mirror, both
pulled by rsync to the laptop. Bridging to production is not a substitute: readings are bridged at
QoS 0, so every outage is a gap there, and a Pi may hold organizations or nodes production never sees.

Still to work out:

* **Reachability**: a Pi behind a farm's NAT may not be reachable from the laptop at all, so "pull"
  may have to become a push, or go via production.
* **OpenWRT** may have no room for local snapshots, and has no systemd - a different timer, and
  possibly snapshots that only exist in transit.
* Replicated users (`id >= REPLICA_ID_OFFSET`) come from production on the next poll; including them
  is harmless, but a restore does not depend on them.

## Later: a second offsite copy

Wanted, but not yet. Either a second machine pulling from the server the same way (its own `rrsync`
key), or this laptop syncing on to another machine. Both machines in view are secured, so neither
needs TODO-BACKUP-ENCRYPT; a copy anywhere less trusted - a cloud folder, a shared disk - would.

## Separate project: moving an organization

A raw snapshot is right for disaster recovery and wrong for moving one organization, which has to
filter and then *merge into another server's database*: user ids collide (both start AUTOINCREMENT at
2, the problem `REPLICA_ID_OFFSET` solves for replicas), a user may hold permissions in several
organizations, and node credentials either travel (operator only, encrypted) or the nodes re-enrol and
are approved through `node_grants`. Nodes also still point at the old broker's hostname, which no
export fixes. Logical YAML/JSON export, its own plan.

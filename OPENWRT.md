# Running a Frugal IoT server on an OpenWrt router

**Status: untested.** Nobody has run this on a router yet. The Raspberry Pi installation
([INSTALLATION.md](INSTALLATION.md)) is proven; this is the same thing re-done for OpenWrt from
knowledge of how OpenWrt works, and the first real run will find things we got wrong. That is what
this document is for: it says what a router needs, gives two scripts, and says what to send back.

## What you are installing

A Frugal IoT server is three programs on one machine:

* **mosquitto**, an MQTT broker. Small sensor boards (ESP32s) publish readings to it, and the
  dashboard in your browser listens to it.
* **the Frugal IoT server**, a Node.js program. It serves the dashboard on port 8080, keeps the
  user logins and settings in an SQLite database, and writes every reading to disk.
* nothing else. No cloud, no internet needed once it is installed.

The router is simply where they run. It does not stop being a router.

## What the router needs

Run the preflight script (below) and it checks every line of this table for you.

| | Needed | Why |
| --- | --- | --- |
| **CPU** | **aarch64 or x86_64.** 32-bit ARM might work. MIPS will not. | OpenWrt's `node` package is only built for some CPUs, and the database module (`sqlite3`) is a compiled binary that has to exist for that CPU and for OpenWrt's C library (musl). Both are most likely on 64-bit. |
| **Memory** | 512 MB or more (256 MB at the very least) | The server uses about 250 MB once running. |
| **Storage** | **About 400 MB free** on ext4, f2fs or btrfs | The software is ~100 MB; npm needs room to work; readings accumulate. **Most routers' own flash is far too small**, so this means a USB stick or SSD, set up as extroot or just mounted, and `--dir` pointing at it. Not FAT, exFAT or NTFS: the install needs symlinks and Unix permissions. |
| **OpenWrt** | A release whose feed has **node 20.17 or later** | The server needs it. The preflight reads the feed and says. |
| **mosquitto** | A build with **websockets** | The browser dashboard connects over websockets. If the router's mosquitto has none, the dashboard cannot work. |
| | Ideally the **dynamic security plugin** | It gives every node and every user its own broker password. Without it the server falls back to one shared password per organization: it works, but it is the older and weaker scheme. |
| **Network** | Internet access while installing | opkg and npm download from their own servers. |
| **Free ports** | 1883 (nodes), 9012 (dashboard websocket), 8080 (dashboard) | Nothing on OpenWrt uses these by default; LuCI is on 80/443. |

Better to have, not required: a fixed LAN address (a router has one already), and a drive that
tolerates constant small writes - the server logs readings all day, which is hard on a cheap USB stick.

## Doing it

You need `ssh` access to the router as root. On the router, fetch the two scripts from the `openwrt`
branch:

```sh
B=https://raw.githubusercontent.com/mitra42/frugal-iot-server/openwrt/scripts
wget -O openwrt-preflight.sh $B/openwrt-preflight.sh
wget -O install-openwrt.sh   $B/install-openwrt.sh
```

If `wget` complains about https, the router has no TLS support for it yet
(`opkg update && opkg install ca-bundle libustream-mbedtls`), or download the files on your computer
and copy them across with `scp`.

### 1. Preflight - on each candidate router

```sh
sh openwrt-preflight.sh --dir /mnt/sda1/frugal-iot --install 2>&1 | tee preflight.txt
```

* `--dir` is where you intend to put the server: a path on the drive. The default is `/opt/frugal-iot`.
* Without `--install` it only reads things, and refreshes the package list. **With `--install` it
  installs node, mosquitto and the other packages**, after asking, so that it can try mosquitto and
  sqlite3 for real rather than guess. That is the same set the installer would put there anyway, but it
  does use the router's own flash: it prints how much is free first. If the flash is nearly full, run
  it without `--install` first.
* It ends with `PASS`/`WARN`/`FAIL` counts and a verdict. **Please send the whole of `preflight.txt`
  for every router you try**, including the ones that fail - which ones fail, and why, is the most
  useful thing this stage can tell us.

Which router to choose is then mostly: one with no `FAIL`, a USB port with a decent drive in it, and
512 MB or more.

### 2. Install - on the one you pick

```sh
sh install-openwrt.sh --org myfarm --name "My Farm" --email you@example.com \
     --phone +61123456789 --dir /mnt/sda1/frugal-iot
```

* `--org` is 1-10 lower-case letters or digits. It becomes the first part of every MQTT topic, and
  the sensor boards must be flashed with the same one. Pick something you will keep.
* Passwords you do not give are generated and printed at the end. The whole run is also logged to
  `/root/frugal-iot-install-<date>.log` (readable only by root; the generated passwords are in it).
* `--dry-run` checks the arguments and the router and says what it would do, changing nothing.
* It is safe to run again after a failure: steps already done are skipped.
* It runs the server as root, as most OpenWrt services do. `--user frugal` creates and uses a
  separate account instead, which is tidier but is another thing that has not been tried.

When it finishes it prints the dashboard address and the settings the sensor boards need.

### 3. If something goes wrong

Send back:

1. `preflight.txt`
2. the install log (`/root/frugal-iot-install-*.log`) - or just the end of the terminal output
3. `logread -e frugaliot | tail -50` and `logread -e mosquitto | tail -50`
4. the output of `opkg list-installed | grep -E 'mosquitto|node|sqlite|zsh'`

## What is different from a Raspberry Pi, and why it might fail

The installer is the Pi one, redone, so these are the places it can be wrong:

* **No systemd.** The service is a procd init script, `/etc/init.d/frugaliot`. Control it with
  `service frugaliot restart`. Logs go to the system log: `logread -e frugaliot`.
* **`/var` is RAM.** On OpenWrt `/var` is `/tmp`, emptied at every reboot. The broker's password file
  and account database would normally live in `/var/lib/mosquitto`, which would lose every account on
  restart, so the installer keeps them in `/etc/mosquitto/state` and points the configuration there.
  It also moves mosquitto's own persistence (the retained values) there if it was set to a
  RAM path; the original configuration is kept as `/etc/mosquitto/mosquitto.conf.pre-frugal`.
* **No bash, no zsh, no sudo, no apt.** The installer is plain `sh` and installs zsh itself (the
  server's own commands are zsh scripts). BusyBox's versions of `install`, `stat`, `sed`, `grep` and
  `su` are what it relies on, and none of that has been run on BusyBox.
* **The sqlite3 module.** The most likely single failure. If a binary does not exist for your CPU
  and musl, `npm install` will try to compile it, and there is no compiler. The installer stops there
  with the error. A fix exists (compile it on another machine, or use a build environment) but it
  is a different project.
* **The mosquitto package.** Which parts OpenWrt builds in - websockets, the dynamic security plugin,
  `mosquitto_ctrl`, `mosquitto_passwd` - is the main thing nobody here knows. The preflight tries each
  one, and the installer lists every mosquitto package the feed offers into the log.
* **No WiFi fallback network.** On the Pi, a setup network is raised if its WiFi is lost. A router is
  the access point, so this is skipped.
* **Time.** Routers without a battery clock start at an old date until NTP runs. The server stamps
  readings when they arrive, so check the router has the right time.

## After it is running

* **Do not open the ports to the internet.** OpenWrt accepts LAN connections and refuses WAN ones by
  default; leave 1883, 9012 and 8080 that way. HTTPS (needed for over-the-air firmware updates to the
  boards) is not covered here.
* **Upgrading:**
  ```sh
  cd /mnt/sda1/frugal-iot && npm update frugal-iot-server && service frugaliot restart
  ```
  (and re-run `install-openwrt.sh` with the same arguments afterwards, which brings the broker
  configuration up to date.)
* **`npx --no frugal-iot-diagnostic`** was written for systemd and will report some things that do
  not apply here. Treat it as a hint, not a verdict.
* **Removing it:**
  ```sh
  service frugaliot stop; /etc/init.d/frugaliot disable; rm /etc/init.d/frugaliot
  rm -rf /mnt/sda1/frugal-iot                     # your install directory: this deletes the readings too
  rm /etc/mosquitto/conf.d/frugal-iot.conf /etc/mosquitto/aclfile; rm -rf /etc/mosquitto/state
  cp /etc/mosquitto/mosquitto.conf.pre-frugal /etc/mosquitto/mosquitto.conf   # if it exists
  /etc/init.d/mosquitto restart
  ```

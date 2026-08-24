# Installing a Frugal IoT server on a Raspberry Pi

This guide installs a **complete, self-contained Frugal IoT server** on a Raspberry Pi:
an MQTT broker (Mosquitto), the Frugal IoT server, the logger that writes sensor data to disk,
and the web UI. Once installed, the Pi works **offline** — your sensor nodes talk to the Pi,
and you view the data from a phone or laptop on the same Wi-Fi. No internet needed after setup.

If you already have a working Linux server (not a Pi), you do not need this document —
see [README.md](https://github.com/mitra42/frugal-iot-server/blob/main/README.md) instead.

**Read the steps in order.** Anything specific to one board is marked in the step it belongs to,
like this:

> **Pi Zero W:** extra detail that only applies to a Zero W. Skip these on a Pi 4.

> **Status:** followed on hardware — a Raspberry Pi 4 through step 9, and a Pi Zero W through step 8
> (see [Tested on](#tested-on)) — and corrected from what those runs found. HTTPS/OTA in step 10 is
> not written yet. Remaining uncertainties are under [Open questions](#open-questions) — please add
> your findings there as you go.

**Already have a Frugal IoT server running and just want a newer version?** Skip everything below
and go to [Upgrading](#upgrading).

**If a step does not do what it says here**, once you reach step 4 you can run
`npx --no frugal-iot-diagnostic` from your install directory — it inspects the whole installation and
reports what looks wrong. See [When something does not work](#when-something-does-not-work).

---

## Which Raspberry Pi

Any of these work. What differs is only how long the install takes, and how much of a fight it is:

| Board | Install | Notes |
| --- | --- | --- |
| **Pi 4** (or Pi 5, Pi 3) | About half an hour | The straightforward path. 64-bit, everything installs as ready-made binaries. |
| **Pi Zero 2 W** | Expect longer | 64-bit, so it should avoid the long compile below, but shares the Zero's 512 MB. Not yet tested. |
| **Pi Zero W** (the original) | Allow an afternoon | 32-bit ARMv6. One dependency has to be compiled — about 40 minutes — and 512 MB of RAM is not enough without adding swap. Tested and works. |

A Zero W runs the server perfectly well once installed. It is *installing* that is slow, because a
single 1 GHz core has to unpack several hundred packages and compile one of them.

## The short way: one script

Steps 3 to 8 below can be done for you. Once you can ssh into the Pi (steps 1 and 2, which need a
person with an SD card):

```
curl -fsSLO https://raw.githubusercontent.com/mitra42/frugal-iot-server/main/scripts/install-pi.sh
bash install-pi.sh --org myfarm --name "My Farm" --email you@example.com --phone +61123456789
```

It asks for anything it needs that you did not pass, says what it is doing as it goes, and stops at
the first thing that fails - leaving a log, and telling you to run `frugal-iot-diagnostic`. Running
it again after a failure carries on rather than starting over, which matters on a Pi Zero W where one
step takes about 40 minutes. `--dry-run` checks the arguments and shows the plan without touching the
machine.

**Passwords** are asked for, not invented, unless you say otherwise: it prompts for each (twice, not
echoed) and generates one if you just press Enter. Pass them as `--superuser-password`,
`--login-password` and `--broker-password` to skip the prompts, `--random-passwords` to have all
three generated, or `--yes` to ask nothing at all — which is what to use over ssh with no terminal.
A password you chose is not written to the log; a generated one has to be, since otherwise you would
have no way of knowing it.

**It tells you whether a reboot is needed**, rather than leaving you to wonder — it notices a kernel
or boot-firmware package in the upgrade, the images in `/boot` changing underneath it, and
`/var/run/reboot-required`. If none of those happened it says so, and there is nothing more to do.

Fetch it with `curl -O` and then run it, rather than piping curl into bash - piped, it has no
terminal to ask questions at.

It finishes with a live server and a tested broker. It cannot do step 9, pointing your nodes at it,
because a node learns its broker by being flashed with it - so it prints the settings to give them.
Nor step 10, HTTPS.

The steps below are what it does, in the same order, if you would rather do it by hand or need to
understand what went wrong.

---
### 0. What you need before you start

**Hardware**

* A Raspberry Pi, per the table above. Any RAM size — a running server uses around 250 MB.
  (Measured on a 4 GB Pi 4: 231 MB in use with the server running.)
* A microSD card. 8 GB is enough for the system and software — a working install occupies about
  5 GB — but sensor data accumulates on this card for as long as the server runs, so 16 GB or larger
  is the safer choice. Class 10 / A1 or better.
* The official Raspberry Pi power supply for your board — USB-C on a Pi 4, micro-USB on a Zero.
  Phone chargers frequently cause random reboots and corrupted SD cards — this is the single most
  common cause of "it doesn't work".
* A way to write the SD card from your laptop: a built-in SD slot or a USB card reader.
* Note that you will often need an adapter from the SD format the Pi uses to the SD format of most laptop readers.

> **Pi Zero W:** its Wi-Fi is 2.4 GHz only, so it cannot see a 5 GHz-only network. It has no
> Ethernet socket either, so the cable trick in step 2 is unavailable — have the micro-HDMI cable
> and a keyboard to hand instead. Note micro-USB for power and a micro-USB OTG adapter for the
> keyboard: different cables from a Pi 4.

**Software and information**

* A laptop or desktop (Mac, Windows or Linux) with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) installed.
* The name (SSID) and password of the Wi-Fi network the Pi will join.
* Your two-letter Wi-Fi country code (`GB`, `US`, `IN`, `AU`, …). The Pi's Wi-Fi radio stays
  switched off until a country is set, so this is not optional.

**Assumptions**

* The Pi is **headless** — no monitor, no keyboard. You will drive it entirely over SSH from your laptop.
* The Pi joins your Wi-Fi network, and your laptop is on the same network.
* You are comfortable typing commands into a terminal, but you are not assumed to know Linux administration.
* Anything shown as `<something>` is for you to substitute.

**Have these to hand in case the headless setup does not come up**

* An Ethernet cable from the Pi to your router — the simplest way in if the Pi does not appear on
  the Wi-Fi, and you can then sort the Wi-Fi out over SSH (step 2).
* A micro-HDMI to HDMI cable plus a monitor, and a USB keyboard — for when the Pi is nowhere near the
  router, or you want to see boot messages.

### 1. Write the operating system to the SD card

We use **Raspberry Pi OS Lite** — the version with no desktop. The Pi is a server;
a desktop would only consume memory and SD card space.

1. Insert the SD card into your laptop and start Raspberry Pi Imager.
2. **Choose Device** → your board.
3. **Choose OS** → *Raspberry Pi OS (other)* → *Raspberry Pi OS Lite (64-bit)*.
   * **On a Pi Zero W choose *Raspberry Pi OS Lite (32-bit)*** — the 64-bit images will not boot on
     its ARMv6 processor. (A Pi Zero **2** W is 64-bit, so it takes the 64-bit image like a Pi 4.)
4. **Choose Storage** → your SD card. Check the size shown matches your card — this erases it.
5. Click **Next**. When asked *"Would you like to apply OS customisation settings?"*, choose
   **Edit Settings** — everything below depends on it.
6. Set hostname to `frugaliot` (this guide assumes that name throughout). Click "Next", do **NOT** "Skip Customization"
7. Set your Capital; TimeZone; and Keyboard
8. Set username and password. This guide assumes username `pi`. Choose a real password — the Pi will accept SSH logins.
9. Enter your Wi-Fi SSID, password 
   * And country code if requested - some versions do not request it any more.
   * Type the SSID exactly as the network broadcasts it, including capitals. Imager does not store
     your Wi-Fi password; it converts it into a 64-character key using the SSID, so a mistyped SSID
     produces a key that fails even though the password was right.
   * If the Pi does not join the network, a mistyped SSID or password is much the likeliest cause -
     neither is echoed back to you here, and Imager combines the two into a key, so a slip in either
     looks the same later. Step 2 fixes it in a couple of minutes with `nmtui`.
   * A WPA3 network cannot use the key Imager derives at all, so on one of those expect to finish the
     Wi-Fi setup with `nmtui` regardless.
10. Enable SSH, either choose *Use password authentication* or paste your public key if you already use SSH keys.
11. Leave Raspberry Pi Connect off for now - feel free to experiment with this, as we haven't yet. 
12. Confirm that you want to save settings and write to the card, and click through operating system prompts wanting to stop you ! 

Writing and verifying takes several minutes.

Eject the card, put it in the Pi, connect power.

The first boot resizes the filesystem and reboots itself. Give it **two to three minutes** before
expecting it to answer.

### 2. Log in over the network

From your laptop's terminal:

```
ssh pi@frugaliot.local
```

Say `yes` to the fingerprint question, then give the password you set in Imager.

**If that logged you in, go straight to step 3.** The rest of this step is for when it did not.

**If `frugaliot.local` is not found**, the `.local` (mDNS) name is not reaching you. In order of ease:

* Wait another minute and try again — the Pi may still be on its first boot.
* Log in to your Wi-Fi router's admin page and look for a device called `frugaliot` in its
  list of connected clients; note its IP address and use that instead: `ssh pi@192.168.1.42`.
* **Plug an Ethernet cable from the Pi into your router.** Nothing needs configuring — the Pi picks
  up an address, and `ssh pi@frugaliot.local` then works over the cable. This is the least effort
  way in if the Pi is within reach of the router, and once you are logged in you can sort the Wi-Fi
  out over SSH with `nmtui` as below, no monitor or keyboard needed. Unplug the cable afterwards and
  check that Wi-Fi alone still gets you in. (Not an option on a Pi Zero — no Ethernet socket.)
* Plug in the HDMI and keyboard, log in at the console, and run `ip addr` to read the IP address,
  and `sudo journalctl -b | grep -i wpa` to see why Wi-Fi failed. Use this when the Pi is nowhere
  near the router, or when you want to see boot messages.

**If Wi-Fi did not connect at all** — `ip addr` shows no address on `wlan0`, and the journal has
`WPA: 4-Way Handshake failed - pre-shared key may be incorrect` — then the Pi found your network
but was refused. At the console, fix it interactively:

```
sudo nmtui
```

Choose *Activate a connection*, pick your network, and type the Wi-Fi password. (*Edit a
connection* changes the stored one instead.) This works where Imager did not, because you are
giving NetworkManager the passphrase itself rather than the key Imager derived from it.

To see what Imager actually stored, before or after fixing it:

```
sudo grep -H -e ssid -e psk /etc/NetworkManager/system-connections/*.nmconnection
```

A 64-character hexadecimal `psk` is normal — that is your password combined with the SSID, not a
corrupted value. You can check whether it is the *right* key by deriving it yourself and comparing:

```
wpa_passphrase '<SSID exactly as broadcast>' '<the password you typed into Imager>'
```

A key that does not match means the SSID or the password did not reach Imager as intended. A key
that does match, yet still does not connect, is a fault in the profile Imager wrote rather than in
the password — either way `nmtui` is the fix, and it is not worth more time than that.
(`sudo nmcli device wifi list` shows each nearby network's SSID and whether it is WPA2 or WPA3;
WPA3 cannot use a derived key at all.)

### 3. Update the operating system and install the prerequisites

Logged in, bring the system up to date and reboot:

```
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Wait a minute, then `ssh pi@frugaliot.local` again.

**Find the Pi's IP address**, because later steps can need it — for the broker URL if you will view
the dashboard on a phone, and for your sensor nodes. From your laptop:

```
ping -c1 frugaliot.local
```

The address it prints is the Pi's. That is easier than hunting through your router's admin pages,
which you may not have the password for.

**Recommended:** if you can get into your router, give the Pi a fixed (reserved) IP address, so that
address does not change. Sensor nodes and phones then have something stable to talk to even where
`.local` names do not work.

Now the packages the server needs.

**On a Pi 4** (or any 64-bit board):

```
sudo apt install -y nodejs npm sqlite3 zsh
node -v
```

**On a Pi Zero W**, three more packages, because a 32-bit machine has to compile part of the server
in step 4 and a Lite image has no compiler:

```
sudo apt install -y nodejs npm sqlite3 zsh build-essential python3-dev python3-setuptools
node -v
```

What each is for:

* `nodejs` — the server needs **Node 18 or later**. Current Raspberry Pi OS (Debian 13, trixie)
  provides 20.19.2, which is fine, on 32-bit as well as 64-bit. Older images shipped Node 18, also
  fine. If `node -v` reports anything below 18, install a current version from
  [NodeSource](https://github.com/nodesource/distributions) instead.
* `npm` — installs the server; it is a separate package from `nodejs` on Debian.
* `sqlite3` — the database the server keeps its accounts in.
* `zsh` — the setup commands in step 6 are zsh scripts.
* `build-essential`, `python3-dev`, `python3-setuptools` — only needed where something has to be
  compiled. `python3-setuptools` is the non-obvious one: the build uses node-gyp 8, which imports
  Python's `distutils`, removed in Python 3.12, and setuptools puts an importable `distutils` back.
  Without it step 4 ends in `ModuleNotFoundError: No module named 'distutils'`.

Now two settings that make the SD card last longer. A card wears out from being written to, and
these are the two places the system writes constantly without being asked to:

```
# Cap the systemd journal, which by default is allowed to grow to a tenth of the card
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=16M\nSystemMaxFileSize=4M\n' | sudo tee /etc/systemd/journald.conf.d/frugal-iot.conf
sudo systemctl restart systemd-journald

# Swap out to the card only when there is genuinely no alternative
echo 'vm.swappiness=1' | sudo tee /etc/sysctl.d/99-frugal-iot-swappiness.conf
sudo sysctl --system | grep swappiness
```

The `grep` should print `vm.swappiness = 1`. Both survive a reboot. There is more about what wears a
card out, and how to see whether yours is being written to hard, under
[Wear and tear on the SD card](#wear-and-tear-on-the-sd-card) — but nothing else there needs doing
during the install.

> **Pi Zero W: add swap before going on.** 512 MB is not enough to unpack what step 4 downloads, and
> running out does not fail cleanly — the board stops answering SSH and ping, and has to have its
> power pulled. Raspberry Pi OS enables zram, which is **not** sufficient here, because compressed
> RAM does not help when the working set is genuinely large. Add a real swap file (`dphys-swapfile`
> is not on the Trixie Lite image, so make it directly):
>
> ```
> sudo fallocate -l 2G /swapfile
> sudo chmod 600 /swapfile
> sudo mkswap /swapfile
> sudo swapon /swapfile
> free -h                                              # should show 2.0Gi of swap
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> ```
>
> **No reboot needed** — `swapon` takes effect at once, which the `free -h` line confirms. The
> `/etc/fstab` entry only matters later, so that the swap comes back after a reboot rather than
> having to be turned on by hand. Go straight on to step 4.
>
> Swapping to an SD card is slow, and wears it. That is the trade: the install takes longer, but it
> finishes instead of hanging. The `vm.swappiness=1` set above keeps the swap file available for
> emergencies like this one without it being used routinely afterwards.

### 4. Install the Frugal IoT server

The server is an npm package. Make a directory for this server to live in and install it there —
that directory will hold your configuration, your data, and your database, while npm looks after
the software itself underneath it in `node_modules`.

**On a Pi 4** (or any 64-bit board) — a few minutes, everything arrives as ready-made binaries and
nothing is compiled:

```
mkdir ~/frugal-iot
cd ~/frugal-iot
npm install frugal-iot-server
```

**On a Pi Zero W** — the extra flags make npm do one thing at a time, which lowers the peak memory
as well as being kinder to the SD card. This is the slow part; leave it running:

```
mkdir ~/frugal-iot
cd ~/frugal-iot
npm install --maxsockets 1 --no-audit --no-fund frugal-iot-server
```

That pulls in the web UI (`frugal-iot-client`) and the logger (`frugal-iot-logger`) as well.

> **Pi Zero W: check that the compiled part actually built.** npm can report success while leaving
> it out, and nothing else looks wrong when that happens — the server just refuses to start later.
>
> ```
> node -e "require('sqlite3'); console.log('sqlite3 native module loads OK')"
> ```
>
> If that throws `Could not locate the bindings file`, build just that package:
>
> ```
> time npm rebuild sqlite3 --foreground-scripts
> ```
>
> **This takes around 40 minutes on a Zero W** — it is compiling SQLite itself on one slow core. As
> long as it is producing output it is working; `--foreground-scripts` is what lets you see that. If
> the board locks up, pull the power, boot it, and run the same command again: work already done is
> kept, so each attempt gets further.
>
> Most of what is being installed is not Frugal IoT. The logger depends on `firebase-admin`, which
> brings in the Google Cloud SDK — around 40 packages and 30 MB — and that is what the board
> struggles with. It is only used by organizations that configure a `firebase:` section.
> TODO make that dependency optional in frugal-iot-logger, so small boards can skip it.

Then set the directory up:

```
npx --no frugal-iot-init
```

This copies in the configuration files, creates the `data`, `ota` and `config.d/organizations`
directories, and creates the database. It never overwrites anything already there, so it is also
what you run after an upgrade to pick up newly added configuration.

Everything from here on is run from `~/frugal-iot`, and `npx` is how you run the server's commands
without having to know where npm put them.

**Point the server at your own broker.** Out of the box the server talks to the shared broker at
naturalinnovation.org. Edit the MQTT config:

```
nano config.d/mqtt.yaml
```

Replace its contents with:

```
broker: ws://frugaliot.local:9012
```

This one URL is used both by the server's own logger and by the browser UI, so it has to be a
WebSocket (`ws://`) address that **your phone or laptop browser** can reach, not just one that
works on the Pi.

> `frugaliot.local` is known to work from a laptop and from an iPhone. Android phones generally
> cannot resolve `.local` names, so if you will view the dashboard on Android, put the Pi's IP
> address here instead — `broker: ws://192.168.1.42:9012`, using the address `ping -c1
> frugaliot.local` reported in step 3 — and reserve that address in your router if you can, so it
> does not change under you.

### 5. Install and configure the MQTT broker (Mosquitto)

Sensor nodes publish their readings to an MQTT broker; the Frugal IoT logger subscribes to it and
writes the readings to disk; the web UI subscribes to it to show live values. On an offline Pi,
the broker runs on the Pi itself.

```
sudo apt install -y mosquitto mosquitto-clients
```

Mosquitto out of the box only listens on the Pi itself, and speaks only plain MQTT. Frugal IoT
needs two listeners: plain MQTT on port 1883 for the sensor nodes, and MQTT-over-WebSockets on
port 9012 for the browser. The repo ships that configuration, so from the `frugal-iot-server`
directory you cloned in the previous step, just copy it in:

```
sudo cp extras/mosquitto.conf /etc/mosquitto/conf.d/frugal-iot.conf
```

(Everything in `/etc/mosquitto/conf.d/` is read in addition to the packaged
`/etc/mosquitto/mosquitto.conf`, which keeps its own settings for logging and persistence.)

That file also turns off the broker's per-connection logging, because a node on a weak signal
reconnects constantly and each of those lines is a write to the SD card. Nothing is lost — the
readings themselves are recorded by the server, and everything else the broker says, including why
it refused to start, still goes to `/var/log/mosquitto/mosquitto.log`. If you are chasing a node
that keeps dropping off the network, comment out `connection_messages false` and restart the broker.

That configuration names a password file, and Mosquitto will not start if the file is missing, so
create an empty one. The accounts inside it get created for you in the next step:

```
sudo install -o mosquitto -g mosquitto -m 600 /dev/null /var/lib/mosquitto/passwords
```

That makes an empty file belonging to the `mosquitto` user, readable by nobody else — one command
instead of a `touch`, a `chown` and a `chmod`.

> The ownership matters, and is easy to get wrong. Mosquitto warns unless the password file belongs
> to whoever opened it, and the broker runs as the `mosquitto` user — so the file belongs to
> `mosquitto`, and it lives under `/var/lib/mosquitto` (which that user owns) rather than
> `/etc/mosquitto` (which root owns). `mosquitto_passwd` also writes a temporary backup file
> alongside it, so it needs to write to that directory too, not just to the file. Step 6 runs it as
> the right user for you.

Start the broker and have it start at every boot:

```
sudo systemctl enable mosquitto
sudo systemctl restart mosquitto
systemctl status mosquitto
```

`systemctl status` should say `active (running)`, and returns you to the prompt. (If the output is
long enough that it opens a pager instead, `q` gets you out.) If it is not running,
`sudo journalctl -u mosquitto -n 50` will show what it objected to.

**Check both listeners are open:**

```
ss -tln | grep -E '1883|9012'
```

Both ports should be listed, on `0.0.0.0` (or `*`) rather than `127.0.0.1` — if they are missing,
Mosquitto did not read the config file. Then check that it is asking for credentials, by
deliberately connecting with a wrong password:

```
mosquitto_sub -h localhost -u nobody -P wrong -t '#'
```

`Connection Refused: not authorised` is the **success** case here — the broker answered and
requires an account. There are no accounts yet; step 6 creates the first one, and there is a
fuller test at the end of it.

> If Mosquitto did not start, `npx --no frugal-iot-diagnostic` will tell you why in one step — most often
> that the password file its configuration names does not exist. Note that `systemctl status` and
> the journal only show an exit code; the actual reason is in Mosquitto's own log, which the
> diagnostic reads for you. See [When something does not work](#when-something-does-not-work).

### 6. Create your accounts and your organization

The database was created by `npx --no frugal-iot-init` in step 4, holding two accounts. One is
`everyone`, which nobody logs in as — it exists so that permissions granted to all logged-in users
have somewhere to live. The other is `superuser`, this server's administrator, which is given admin
rights over every organization you create. It starts with no password and cannot be logged into
until you give it one:

```
npx --no frugal-iot-setpassword superuser "<a-good-password>"
```

Use the same command later if you ever need to reset a password — for `superuser` or for any
other account.

Frugal IoT groups devices as **organization → project → device**. Create yours:

```
npx --no frugal-iot-addorganization myfarm "My Farm" you@example.com +61123456789 "<broker-password>"
```

The arguments are: organization id, display name, your email, your phone (`+` and digits only),
and a password. That one command writes `config.d/organizations/myfarm.yaml`, creates a login account
named after the organization (`myfarm`), grants it admin rights, creates its OTA directory, **and adds
the organization's account to the broker's password file** — which is why the broker had to be
installed first.

* **Organization id `myfarm`** — must be 1–10 lower-case letters or digits. It becomes the first part
  of every MQTT topic, so it must match what your sensor nodes are configured to publish to.
* **The password** goes into `config.d/organizations/myfarm.yaml` as `mqtt_password` and into the
  broker's password file, so it is a *machine* credential: the server's logger, your sensor nodes,
  and any browser showing this organization's dashboard all authenticate to the broker with it.
  Treat it as shared, not personal.

Tell Mosquitto to re-read the password file, so the new account works:

```
sudo systemctl restart mosquitto
```

**Give your login its own password.** That command set the `myfarm` *web login* password to the same
string as the broker password. They serve completely different purposes, so change the login one
now to something only you know — the broker credential is unaffected, and nothing needs to be kept
in step:

```
npx --no frugal-iot-setpassword myfarm "<your-own-login-password>"
```

**Now the full broker test.** In your SSH session subscribe as the organization, using the broker
password you chose above:

```
mosquitto_sub -h localhost -u myfarm -P '<broker-password>' -t '#' -v
```

It should sit there silently — no error, no exit. Open a **second** SSH session to the Pi and
publish something:

```
mosquitto_pub -h localhost -u myfarm -P '<broker-password>' -t 'myfarm/test/hello' -m '42'
```

`myfarm/test/hello 42` appearing in the first window proves the account, the password file and the
port 1883 listener your sensor nodes use are all working. The WebSocket listener on 9012 gets
exercised by the browser in step 7. Leave the subscriber running if you like — it is a useful
window onto what your nodes are doing. (`Ctrl-C` stops it.)

If you get `Connection Refused: not authorised`, the password does not match the one in
`config.d/organizations/myfarm.yaml`, or Mosquitto has not re-read the file since it changed.
`npx --no frugal-iot-diagnostic` checks this for every organization you have, and reports which ones the
broker actually accepts.

### 7. Start the server by hand and check it

From your install directory — `npx` looks for the server in the current directory's `node_modules`,
so this only works there:

```
cd ~/frugal-iot
npx --no frugal-iot-server
```

> If npx answers with `Need to install the following packages: frugal-iot-server` and asks to
> continue, you are in the wrong directory. Say no, `cd ~/frugal-iot`, and try again — otherwise
> npx fetches a throwaway copy that has none of your configuration.

It lists each configuration file as it reads it, then:

```
readYamlConfigFile ./config.yaml
readYamlConfigDir ./config.d
    ... one line per configuration file ...
Broker ws://frugaliot.local:9012 - organizations: myfarm
Doing OTA updates at /ota_update from /home/pi/frugal-iot/ota
Serving /node_modules from ./node_modules
User Database exists
Opened user database
Exec-ed starting SQL
Created logger client for API integration
Created push manager for Farm-Platform data push
Mounted API routes at /api
Added API error handler
Serving /data from ./data
Server starting on port 8080
mqtt myfarm connecting
mqtt myfarm connect
Subscribing topic myfarm/# 0
```

Check the `Broker` line names your own broker and your organization. The lines that matter most are
the last three: `mqtt myfarm connect` means the server reached the broker and authenticated, and
`Subscribing topic myfarm/#` means it is listening for your nodes. If instead you see repeated
`mqtt myfarm close`, `offline`, or `Not authorized`, the broker URL or the password is wrong — recheck
`config.d/mqtt.yaml` and that the password in `config.d/organizations/myfarm.yaml` matches the `myfarm`
broker account.

Once nodes are reporting, each reading is logged as it arrives, so this output keeps scrolling.

Now open a browser on your laptop or phone at:

```
http://frugaliot.local:8080
```

(or `http://<the Pi's IP>:8080`).

> On a Mac, the browser will ask something like *"Allow Google Chrome Helper to find devices on
> local networks"* the first time. **Allow it** — without that permission the browser cannot look up
> `frugaliot.local`, nor reach the broker at that name, so the page and the live data both fail.

You land on the Frugal IoT home page. Click **Dashboard**, and log in as username `myfarm` with the
login password you set with `frugal-iot-setpassword` — not the broker password. (`superuser` and its
password work too.)

Once you are through to the dashboard and have selected your organization, its MQTT status should
show **connected**. That is the browser authenticating to the broker as your organization, over the
WebSocket listener on port 9012, from a different machine — the last untested piece of the chain.
If it does not connect, check that the `broker:` URL in `config.d/mqtt.yaml` is one this browser can
actually resolve: a phone that cannot look up `.local` names needs the Pi's IP address there instead.

Until a sensor node reports in there will be no data to look at, but the dashboard should load.

> Anything wrong here — the server not starting, `mqtt myfarm close` instead of `connect`, the page not
> loading, the MQTT status not reaching *connected* — is worth a `npx --no frugal-iot-diagnostic` in
> another terminal before digging in by hand. It tests the same chain from the Pi's side: broker
> logins, the three ports, and the web server.

Stop the server with `Ctrl-C` before continuing.

### 8. Run the server as a service

So that it starts automatically at boot and restarts if it crashes. The file that
`npx --no frugal-iot-init` put in `extras/` already describes this installation — user `pi`, installed
into `/home/pi/frugal-iot` — so it needs no editing:

```
sudo cp extras/frugaliot.service /etc/systemd/system/frugaliot.service
sudo systemctl daemon-reload
sudo systemctl enable --now frugaliot
systemctl status frugaliot
```

`enable --now` both starts it and sets it to start at boot. `status` should report
`active (running)`.

> Only if you departed from this guide — a different username, or a directory other than
> `~/frugal-iot` — edit `User`, `WorkingDirectory` and `ExecStart` in
> `/etc/systemd/system/frugaliot.service` to match, then `sudo systemctl daemon-reload` and
> `sudo systemctl restart frugaliot`. `WorkingDirectory` is the important one: it is where the
> server looks for its configuration and database.

To watch its log output, which is where the `mqtt myfarm connect` and incoming-reading messages now go:

```
journalctl -u frugaliot -f
```

Reboot the Pi (`sudo reboot`), wait a couple of minutes, and check `http://frugaliot.local:8080`
still answers. Your server is now installed.

### 9. Point your sensor nodes at the Pi

Your ESP8266/ESP32 nodes are told which broker to use in their sketch — `main.cpp`, or the `.ino`
file if you build in the Arduino IDE. Look for a line like:

```cpp
frugal_iot.configure_mqtt("frugaliot.naturalinnovation.org", "dev", "public");
```

and point it at your Pi instead:

```cpp
frugal_iot.configure_mqtt("frugaliot.local", "myfarm", "<broker-password>");
```

The three arguments are the broker's host, the organization, and that organization's broker
password. The organization must be the one you created in step 6, because it is the first part of
every topic the node publishes to, and the password is the *broker* password from that step — not
the login password. Then rebuild and flash the node as usual.

> If the node does not connect, try the Pi's IP address in place of `frugaliot.local`. Resolving
> `.local` names needs mDNS support in the firmware, which is not something this guide has
> confirmed; an IP address avoids the question entirely, which is why step 3 suggests reserving one
> for the Pi in your router.

You can confirm nodes are reporting without involving the UI, using the subscriber from step 6:

```
mosquitto_sub -h localhost -u myfarm -P '<broker-password>' -t '#' -v
```

Every reading from every node should scroll past. Seeing anything here also proves the broker's
port 1883 is reachable from off the Pi, which is what the nodes need.

### 10. HTTPS and over-the-air firmware updates

**To be written.** Everything above gives you a plain HTTP server on your local network, which is
all an offline installation needs. HTTPS matters for two things:

* **OTA updates** — ESP32 nodes require HTTPS to download new firmware, so OTA does not work on a
  plain-HTTP LAN install.
* **Reaching the Pi from the internet**, rather than only from the local Wi-Fi.

That section will cover: a DNS name for the Pi, port forwarding on the router, nginx as a reverse
proxy in front of port 8080, and certificates from Let's Encrypt via certbot. Both require the Pi
to have internet access, which is the opposite of the offline case this guide is aimed at.

### 11. Optional: bridge this Pi to a production server

Everything above gives a self-contained Pi. This step also relays its readings to a production
Frugal IoT server, so the same nodes appear on a dashboard elsewhere and can be controlled from
it, while the Pi carries on working on its own whenever the link is down. Skip it if you do not
want that — nothing else depends on it.

The relaying is done by the broker, not by the server: Mosquitto has a "bridge" feature for
connecting to another broker, and the server, the logger and the nodes need no configuration
change at all. This installation ships an example bridge configuration in
`extras/mosquitto-bridge.conf.example`, which explains each setting in place; this section is the
surrounding work.

**What you get, and what you do not.** While the link is up, readings appear on production within
a second or so. While it is down, the Pi records everything as usual and production simply has a
gap — the readings taken during an outage never reach it. That is a deliberate choice: the
alternative is for the broker to hold them and deliver the backlog on reconnect, but production
timestamps each reading as it arrives, so a day's backlog would arrive claiming to have happened
in the instant the link returned. A gap is honest; that would not be. Controls are treated the
other way round, and *are* queued, so turning something on from production while the Pi is offline
takes effect when it reconnects.

#### On the production server

**Add a listener for bridges.** A Mosquitto bridge speaks MQTT or MQTT-over-TLS and cannot use
WebSockets, so the existing `wss://` path that browsers and servers use cannot carry this. Add to
production's Mosquitto configuration:

```
listener 8883
protocol mqtt
certfile /etc/letsencrypt/live/<prod-host>/fullchain.pem
keyfile  /etc/letsencrypt/live/<prod-host>/privkey.pem
```

and open 8883 on the firewall.

> **The certificate permissions are what usually goes wrong here.** Mosquitto runs as the
> `mosquitto` user and Let's Encrypt keys are readable only by root, so the broker fails to start
> with a permission error on `privkey.pem`. Either add `mosquitto` to a group granted read access
> to `/etc/letsencrypt/live` and `/etc/letsencrypt/archive`, or have a certbot deploy hook copy the
> two files somewhere owned by `mosquitto`. Whichever you choose, check it again after the next
> certificate renewal, which is when a copy-based approach goes stale.

**Create an account for each Pi**, rather than sharing the organization's account. The organization
password is handed to every browser that logs in, so it is not a secret; a per-Pi account can be
restricted to one site's topics and revoked on its own.

```
sudo mosquitto_passwd -b /var/lib/mosquitto/passwords bridge-<site> '<password>'
sudo systemctl restart mosquitto
```

**Restrict what that account can do.** This is the part to plan for, because Mosquitto's ACL file
is deny-by-default: the moment production names an `acl_file`, every existing account that has no
entry in it stops working. So the file has to grant the existing organizations what they already
have, in the same change that restricts the new bridge accounts:

```
# Existing organization accounts: unchanged - each already works only within its own org topic
pattern readwrite %u/#

# Each Pi reaches only its own site
user bridge-<site>
topic readwrite <org>/<project>/#
```

Add `acl_file /etc/mosquitto/aclfile` to production's configuration and restart. Then check an
existing organization can still log in, *before* connecting any Pi — a broken ACL file locks out
every node and dashboard at once, and the reason appears only in Mosquitto's own log.

#### On the Pi

```
sudo cp extras/mosquitto-bridge.conf.example /etc/mosquitto/conf.d/frugal-iot-bridge.conf
sudo nano /etc/mosquitto/conf.d/frugal-iot-bridge.conf
```

Replace every `<...>` placeholder: the production hostname, the account and password you just
created, and the organization id in each of the four `topic` lines. Then:

```
sudo systemctl restart mosquitto
```

It has to be a restart. Mosquitto does not pick up bridges on a reload signal, so `reload` appears
to succeed and changes nothing. The restart briefly disconnects every node, which they recover from
on their own.

> The file goes into `/etc/mosquitto/conf.d/` and not into this installation's `config.d/`, because
> it holds a password for production. Everything under `config.d/` is served to any logged-in
> browser by `/config.json`, so a credential put there would not stay private.

#### Check it

```
npx --no frugal-iot-diagnostic
```

The **Bridge to a production server** section names the bridge, lists what it relays, and reports
whether it is connected. `CONNECTED` means the link is up. `DOWN`, or a report that it has never
connected, means the address, the credentials or the certificate is wrong — and Mosquitto's own log,
quoted earlier in the same output, says which.

Then confirm at the far end: log in to production's dashboard and look for this Pi's nodes. They
should appear within a couple of minutes, which is however long it takes each node to next report.

**One oddity worth expecting.** Each time the bridge reconnects, the most recent value of every
reading is re-sent to production and recorded there with the reconnect time rather than the time
it was measured. That is one row per topic per outage, and it happens because nodes publish
readings retained. The `duplicates:` rules in `config.d/schema/topics.yaml` absorb it when the
value has not moved and the outage was short; after a long outage the row is written.

**The clock matters more once a Pi is bridged**, because its readings now sit alongside
production's. A bridged Pi has internet access whenever the link is up, so it sets its time from
the network and the problem below mostly goes away — but it still comes up after a power cut
believing whatever it last saved, and anything recorded before it reaches a time server carries
that wrong time.

### Known limitation: the clock on an offline Pi

A Raspberry Pi has no battery-backed clock. While it has internet access it sets its time from the
network and everything is correct — which is what you will see during this install. Fully offline it
cannot: Raspberry Pi OS saves the time periodically and restores that value at boot, so after a
power cut the Pi comes up believing it is whenever it last saved, and the gap never gets made up.

To see whether the Pi's clock is actually right at any moment:

```
timedatectl
```

`System clock synchronized: yes` means it has reached a time server and the clock is trustworthy.
`no`, with `NTP service: active`, means it is trying but has not succeeded — normal on a Pi with no
route to the internet, and the point at which the timestamps below become a concern.

What that affects:

* **Logged data is stamped with the wrong time**, so graphs and history drift after each power cut.
* **Relaying MQTT and watching devices live are unaffected** — the dashboard shows current values
  whatever the Pi believes the date to be.

If timestamps matter to you on an installation with no internet, the fix today is a hardware RTC
module on the Pi's GPIO header. A possible future fix within Frugal IoT itself: the dashboard knows
the time of the phone or laptop viewing it, so it could hand that to the server, which could adopt
it whenever its own clock looks implausible (a date far in the past). Not accurate to the second,
but close enough for sensor data.

---
### Wear and tear on the SD card

SD cards wear out from being written to, and a server recording sensor readings writes all the time.
We have not yet seen a card fail, but plan for one eventually: keep a copy of `config.d/` and
`frugal-iot.db` somewhere else, and treat the readings in `data/` as valuable but not irreplaceable.

A new installation is set up to write as little as it reasonably can, and the settings are worth
knowing about, because turning one of them back on for debugging and forgetting is easy to do:

| What | Where | Shipped as |
| ---- | ----- | ---------- |
| A line logged for every MQTT message received | `verbose:` in `config.d/logger.yaml` | `false` |
| Readings held in memory and written out periodically instead of one at a time | `flushseconds:` in `config.d/logger.yaml` | `300` (5 minutes) |
| A line logged for every web request | `morgan:` in `config.d/server.yaml` | `false` |
| Old readings compressed, and deleted if the disk fills | `housekeeping:` in `config.d/server.yaml` | compress after 2 days, never delete, keep 10% free |
| A line logged for every device connect and disconnect | `connection_messages` in `extras/mosquitto.conf` | `false` |
| A capped systemd journal, and swapping only as a last resort | `/etc/systemd/journald.conf.d/` and `/etc/sysctl.d/`, both set in step 3 | 16 MB journal, `vm.swappiness=1` |

Nothing in that table needs doing — step 3 and step 5 set all of it up. It is here because turning
one of them back on for debugging and then forgetting is easy to do.

`flushseconds` is the one with a cost attached: readings that have not been written out yet are only
in memory, so pulling the power loses up to five minutes of them. Stopping the server properly
(`sudo service frugaliot stop`, or a restart) writes them out first, and so does looking at a graph.

On a Pi 4 there should be very little swapping in any case — the server and Mosquitto together are a
small load for 1 GB or more. The Pi Zero W is the one to watch, since step 3 adds a 2 GB swap file to
get through the install. To see what is actually happening on your board:

```
cd ~/frugal-iot
npx --no frugal-iot-diagnostic
```

and read the **Wear on the SD card** section, which reports how much has been written since boot,
whether the machine is swapping, and whether each of the settings above is in force. Run it twice a
few days apart — the interesting number is the rate, not the total.

## When something does not work

From your install directory:

```
cd ~/frugal-iot
npx --no frugal-iot-diagnostic
```

It only looks — it changes nothing — and it ends with a **Summary** of anything it recognises as
broken. It covers most of the checks scattered through this guide, in one pass:

* the machine, the OS, free memory and disk, and whether the clock is synchronized
* the versions of node, npm, sqlite3, mosquitto, and of the three Frugal IoT packages
* what this directory holds: configuration, database, accounts, organizations
* Mosquitto's configuration, **which password file it names and whether that file exists**, who owns
  it, and the accounts in it
* whether Mosquitto and the `frugaliot` service are running, with the last lines of the journal
  **and of Mosquitto's own log**, which is where its startup errors actually appear
* whether the broker refuses a wrong password, and accepts each organization's real one
* whether ports 1883, 9012 and 8080 are listening, and whether the web server answers
* whether the broker host in `config.d/mqtt.yaml` resolves from this machine
* how much data the logger has written

Two things to know:

* Mosquitto's log belongs to the `mosquitto` user. The script reads it with `sudo` where it can; if
  it says it could not, run the whole thing as `sudo npx --no frugal-iot-diagnostic`.
* The output is safe to paste into a bug report. Passwords are deliberately not printed — the
  password file is listed by account name only, and organizations by name.

If you have not reached step 4 yet, the command does not exist. Copy
[scripts/diagnostic.zsh](https://github.com/mitra42/frugal-iot-server/blob/main/scripts/diagnostic.zsh)
to the Pi and run `zsh diagnostic.zsh` instead.

---

## Upgrading

To move an existing server to a newer release, from the directory you installed into:

```
cd ~/frugal-iot
npm update frugal-iot-server
npx --no frugal-iot-init
sudo systemctl restart frugaliot
```

Taking those in turn:

* `npm update` fetches the new version of the server, and of the client and logger it depends on.
* `frugal-iot-init` adds any configuration file or directory the new version expects and you do not
  have yet. It never changes files you already have, so your settings, database and data are safe.
* `systemctl restart frugaliot` is what actually puts the new version into service — without it the
  old one keeps running from memory, and nothing appears to have changed. (Skip this if you are
  running the server by hand rather than as a service; stop it with `Ctrl-C` and start it again.)

Check it came back up, and is running the version you expect:

```
systemctl status frugaliot
journalctl -u frugaliot -n 30
npm ls frugal-iot-server
```

`frugal-iot-init` leaves your files alone, so watch its output for a section headed **"These files
were left as you have them, but this release ships a different version"**. It gives you the `diff`
command for each. That matters most for the files you copy somewhere else — a changed
`extras/mosquitto.conf` or `extras/frugaliot.service` does nothing until you install it again:

```
sudo cp extras/mosquitto.conf /etc/mosquitto/conf.d/frugal-iot.conf && sudo systemctl restart mosquitto
sudo cp extras/frugaliot.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart frugaliot
```

> It does not compare `config.yaml`, `config.d/mqtt.yaml`, `config.d/logger.yaml` or
> `config.d/server.yaml`, because those hold your own settings and would differ every time. If a
> release note mentions a new setting in one of them, compare it yourself:
> `diff config.d/server.yaml node_modules/frugal-iot-server/config.d/server.yaml`

Because your own configuration is left alone, an upgraded server goes on behaving exactly as it did,
which for the settings under [Wear and tear on the SD card](#wear-and-tear-on-the-sd-card) means it
goes on writing as often as it did. A server that has been running since before those settings
existed keeps logging every message and every web request, and writing every reading as it arrives —
deliberately, since quietening somebody's server without being asked is not a thing an upgrade should
do. On a Pi, compare the two files above and copy across the settings you want.

Your organizations, accounts, database and logged data are untouched by an upgrade — they live in
this directory, not in `node_modules`.

---

## Open questions

Things this guide currently states with less confidence than the rest, to be resolved by
following it on real hardware. Please correct them in place, and delete them from this list, as
they get settled.

**To check while installing**

1. **`.local` from an Android phone** (steps 3, 4) - confirmed working from a laptop (with the
   local-network permission granted on a Mac) and from an iPhone. Android is expected to fail, which
   is what the note in step 4 assumes; worth confirming on a real Android phone.

**Needs information I do not have**

2. **Pi Zero 2 W** - the Zero W notes come from a real install; the Zero 2 W is untested. Being
    64-bit it should take the 64-bit image and avoid the `sqlite3` compile entirely, which is the slow
    part, but it has the same 512 MB and so probably still needs the swap file in step 3.
3. **Bridging to the shared server** — the local broker could optionally bridge to
    naturalinnovation.org so data also reaches the shared server. Not covered here; a later task.
4. **Organization naming** — this guide sets up exactly one organization named `myfarm`, because that
    is the node firmware's default. Is that the right default for a farm installation, or should the
    guide encourage a meaningful organization id (which then has to be set in the node firmware too)?

## Tested on

What the guide has actually been proven against — add a row for each run:

| Date | Board | OS image | Node | Server | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-08-17 | Pi Zero W (original), 512 MB | Raspberry Pi OS Lite **32-bit**, Debian 13 (trixie), kernel 6.18.39+rpt-rpi-v6 | 20.19.2 and npm 9.2.0, both from `apt` — they run on ARMv6 | frugal-iot-server 0.3.5 from npm | Steps 1-8 completed. `sqlite3` had to be compiled: about 40 minutes, after `build-essential python3-dev python3-setuptools` (without setuptools it fails on `distutils`). A 2 GB swap file was required — zram alone was not enough and the board locked up hard without it — and `npm install` was run with `--maxsockets 1`. Step 9 (sensor nodes) not exercised on this board, but the broker publish/subscribe tests in step 6 passed. |
| 2026-08-16 | Pi 4 Model B, 4GB | Raspberryy Pi OS Lite 64-bit, Debian 13.6 (trixie) | 20.19.2 and npm 9.2.0, both from `apt` | frugal-iot-server 0.3.5 from npm | Steps 1-9 completed, plus upgrade over top.  Dashboard reached over `frugaliot.local` from a Mac (Chrome, after allowing local network access) and from an iPhone, MQTT status *connected*. 10 (HTTPS/OTA) not exercised.

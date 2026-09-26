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
> **Pi Zero W:** This can take a long time to connect, try `ping frugaliot.local` first to check it is alive

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

## 3-8. The short way: one script

Steps 3 to 8 below can be done for you. Once you can ssh into the Pi (steps 1 and 2, which need a
person with an SD card):

```
curl -fSLO https://raw.githubusercontent.com/mitra42/frugal-iot-server/main/scripts/install-pi.sh
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
understand what went wrong, otherwise skip to Step 9.


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
named after the organization (`myfarm`), grants it admin, read and write rights, creates its OTA
directory, **and adds the organization's account to the broker's password file** — which is why the
broker had to be installed first.

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

### 9a. Optional: outgoing mail, so people can reset a forgotten password

Without this, a forgotten password can only be fixed by you, on the Pi, with
`npx --no frugal-iot-setpassword <username> <new-password>`. The login page's "Forgot password?"
link says "Password reset is not available on this server" rather than pretending to send anything.

An offline Pi cannot send mail at all, so skip this unless it has internet access.

Mail sent straight from a home broadband connection is almost always treated as spam, so this
relays through somebody else's SMTP server rather than sending directly. Gmail is the usual choice
and is written out in full below; any other provider works the same way.

#### With Gmail

Use a Google account you are willing to have the Pi send as. A separate account for the purpose is
better than your own mailbox — the password ends up in a file on an SD card in a shed.

**1. Turn on 2-Step Verification** on that account, at
<https://myaccount.google.com/signinoptions/twosv>.

This is not optional and it is where most people get stuck: **app passwords do not exist until
2-Step Verification is on**. Until then the page in step 2 simply says the setting is not available,
without explaining why.

**2. Create an app password** at <https://myaccount.google.com/apppasswords>.

Type a name for it — anything you will recognise later, such as `Frugal IoT Pi` — and create it.
Google shows you **16 lowercase letters, in four groups of four**, once. Copy them now; you cannot
come back and read it again, only delete it and make another.

The groups are only there to make it readable. **Type it into the config with the spaces removed**,
as one 16-character word.

**3. Fill in `config.d/email.yaml`:**

```yaml
host: smtp.gmail.com
port: 587
user: yourname@gmail.com
pass: "abcdefghijklmnop"          # the 16 characters from step 2, spaces removed
from: Frugal IoT <yourname@gmail.com>
```

Things that catch people out with Gmail specifically:

* **`from:` must be the same address as `user:`.** Gmail rewrites the sender to the account you
  authenticated as, so a different address here does not fail — it quietly arrives as something
  else, which is harder to diagnose than an error. (An address you have set up under Gmail's
  "Send mail as" is the one exception.)
* **`user:` is the full address**, including `@gmail.com`, not just the part before it.
* **`Username and Password not accepted`** in the server's log means the login password was used
  instead of an app password. Gmail has not accepted account passwords over SMTP for years.
* **Port 465 also works** if 587 is blocked where the Pi is; the software works out the encryption
  from the port number, so change nothing else.
* **A free Gmail account can send around 500 messages a day.** Password resets will not come close.
* **Google Workspace administrators can switch app passwords off** for a whole domain. If step 2
  offers you nothing on a work account, that is why, and you will need a real SMTP relay instead.

#### With any other provider

The same four settings, with that provider's SMTP host:

```yaml
host: smtp.example.org
port: 587           # 465 is implicit TLS, 587 and 25 are STARTTLS
user: frugaliot@example.org
pass: an-app-password-not-your-login-password
from: Frugal IoT <frugaliot@example.org>
```

Fastmail, Zoho, Proton (via its bridge) and the rest all issue app passwords in much the same way,
and for the same reason: one leaking off a Pi then costs you one mailbox rather than the account.

#### Checking it, either way

Restart the server and look at its output:

* `Sending mail via smtp.gmail.com:587 as ...` — configured.
* `Not sending mail (no host/from in config.d/email.yaml) ...` — it did not find a `host` and a
  `from`, so the reset link will say it is unavailable.

Then use "Forgot password?" on the login page with your own account. If the mail never arrives, the
reason is in the server's log — the page deliberately gives the same answer whether or not the
address is known to it, so it cannot be used to find out who has an account here.

Two more things worth knowing:

* `pass` sits in a file on the SD card in plain text. Give that mailbox nothing else to lose.
* If the Pi is behind a proxy that does not set `X-Forwarded-Host`, the link in the mail will point
  at the wrong address. Set `baseurl: https://your.address` in the same file.

The reset code itself is stored nowhere — it is a hash of the account, its current password and the
time, valid between five and ten minutes and dead the moment it is used. There is no table to
maintain and nothing to clean up. Restarting the server invalidates any code already sent.

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

It comes in three parts, and only the first is a one-off:

* **11a — preparing a production server to accept bridges.** A TLS listener, a certificate, and an
  access-control file. Done once for a given production server, and not again until there is
  another one.
* **11b — authorizing this Pi on that server.** One command, run there, once per Pi.
* **11c — pointing this Pi at it.** One command, run here, once per Pi.

**What you get, and what you do not.** While the link is up, readings appear on production within
a second or so. While it is down, the Pi records everything as usual and production simply has a
gap — the readings taken during an outage never reach it. That is a deliberate choice: the
alternative is for the broker to hold them and deliver the backlog on reconnect, but production
timestamps each reading as it arrives, so a day's backlog would arrive claiming to have happened
in the instant the link returned. A gap is honest; that would not be. Controls are treated the
other way round, and *are* queued, so turning something on from production while the Pi is offline
takes effect when it reconnects.

**People, as well as readings.** A bridge relays topics, not accounts, so on its own it does not let
someone registered on production log in here. Step 11b also prints a *replica token*, and step 11c
asks for it; with it, this Pi pulls that organization's logins and permissions from production every
fifteen minutes, so the same people can use this Pi's dashboard — including while production is
unreachable, which is the point of the Pi. It is optional: leave the token blank and the bridge
relays readings as before. Nothing derived from a password travels either way, and each server
issues its own broker credentials, so the same person has different ones here and there. Revoking a
permission on production removes it here on the next pull. See SECURITY.md.

#### 11a. Preparing a production server to accept bridges

Once per production server, not per Pi — and if bridging to `frugaliot.naturalinnovation.org`
this has already been done. If so, skip to 11b.

**Add a listener for bridges.** A Mosquitto bridge speaks MQTT or MQTT-over-TLS and cannot use
WebSockets, so the existing `wss://` path that browsers and servers use cannot carry this. It needs
a TLS listener of its own on 8883, and the sensible certificate to give it is the one the web
server already uses for the same hostname — one certificate and one renewal, rather than two.

Find where that certificate actually is, rather than assuming: certbot's own layout under
`/etc/letsencrypt/live/` is only one of several, and a wildcard certificate covering more than one
domain is often installed by hand somewhere else entirely.

```
sudo grep -rn 'SSLCertificateFile\|SSLCertificateKeyFile' /etc/apache2/   # Apache
sudo nginx -T 2>/dev/null | grep ssl_certificate                          # nginx
```

Take the paths for the vhost serving this server's hostname — `sudo apache2ctl -S` says which
vhost that is — and add to production's Mosquitto configuration:

```
listener 8883
protocol mqtt
certfile <the SSLCertificateFile path>
keyfile  <the SSLCertificateKeyFile path>
```

then open 8883 on the firewall.

> **`certfile` must contain the intermediate certificate as well as the server's own**, or bridges
> will refuse to connect even though browsers are happy — a browser can often fill in a missing
> intermediate from cache and a bridge never can. `sudo grep -c 'BEGIN CERTIFICATE' <certfile>`
> should report 2 or more. If it reports 1, concatenate the issuer's chain onto a copy and point
> `certfile` at that.

> **The key's permissions are what usually goes wrong.** Unlike a web server, which reads its key
> as root at startup, Mosquitto drops to the `mosquitto` user *first* and reads the key afterwards,
> so a key left `root:root 0600` stops the broker starting:
>
> ```
> Error: Unable to load server key file "...". Check keyfile.
> OpenSSL Error[0]: error:8000000D:system library::Permission denied
> ```
>
> On Debian the tidy fix is the `ssl-cert` group, which exists for exactly this and which
> `/etc/ssl/private` is already set up to admit:
>
> ```
> sudo adduser mosquitto ssl-cert
> sudo chgrp ssl-cert <keyfile>
> sudo chmod 640 <keyfile>
> ```
>
> The web server is unaffected — root still reads the key as before. If you would rather not widen
> access to a directory holding keys for other domains, copy the certificate and key into
> `/etc/mosquitto/certs` owned `mosquitto:mosquitto` instead, and refresh that copy on renewal.

**Add one line to however this certificate gets renewed:**

```
systemctl reload mosquitto
```

Mosquitto keeps the certificate it loaded at startup, so without this the broker goes on serving
the old one until it happens to be restarted, and bridges start failing once it expires. A reload
is enough — it picks up a replaced certificate without dropping a single connection. Where that
line goes depends on how the certificate is renewed: a certbot deploy hook in
`/etc/letsencrypt/renewal-hooks/deploy/`, `acme.sh`'s `--reloadcmd`, or, if the certificate is
installed by hand, the written procedure for doing that.

> Note the asymmetry with the Pi end below: a *certificate* change needs only `reload`, but adding
> or changing a *bridge* needs a full `restart`, because Mosquitto does not reload bridges.

**Turn on access control** — if this broker predates the release that ships it. Since
`extras/aclfile` became part of the base install, a Pi set up with `install-pi.sh` already has this
and there is nothing to do here; the steps below are for a broker built before that, or one whose
configuration was written by hand.

Without it, any account that can log in to the broker can publish and subscribe anywhere on it, so
a per-Pi account would be no more confined than the organization's own. This is the part to plan
carefully, because Mosquitto's ACL file is **deny-by-default**: the moment the broker names an
`acl_file`, every existing account with no entry in it stops working. So the file that restricts new
bridge accounts has to grant the existing organizations what they already have, in the same change.

```
sudo tee /etc/mosquitto/aclfile >/dev/null <<'EOF'
# Deny-by-default: an account with no rule here can connect but reach no topic at all.

# Each organization reaches only its own topic tree. "%u" is the connecting account name, and the
# first element of every Frugal IoT topic is the organization id - so this is what the nodes,
# dashboards and the server's own logger already do. It just stops being optional.
pattern readwrite %u/#

# Whether a bridge is up, for frugal-iot-diagnostic. "pattern readwrite %u/#" does not match $SYS,
# so without this the diagnostic reports every bridge as never having connected. Mosquitto logs a
# warning that this pattern contains no %u - harmless, and a "topic" line would apply to anonymous
# clients only, which is not what is wanted.
pattern read $SYS/broker/connection/+/state
EOF
sudo chown mosquitto:mosquitto /etc/mosquitto/aclfile
sudo chmod 600 /etc/mosquitto/aclfile
```

The ownership matters: like the password file and the TLS key, the broker reads this *after*
dropping to the `mosquitto` user, so a root-only file stops it starting. Mode 600 owned by
`mosquitto` rather than 644 owned by root — 2.0.21 accepts the latter but warns on every start that
a file it does not own, or one that is world readable, "will be refused by a future version". Then name it in the configuration
and restart:

```
echo 'acl_file /etc/mosquitto/aclfile' | sudo tee /etc/mosquitto/conf.d/zy-frugal-iot-acl.conf
sudo systemctl restart mosquitto
```

Check every existing organization can still log in **before** connecting any Pi — a wrong ACL file
locks out every node and dashboard at once, and the reason appears only in Mosquitto's own log. On a
Frugal IoT server the quickest check is its journal, which logs one line per organization:

```
sudo journalctl -u frugaliot -n 40 --no-pager | grep -iE "mqtt |not authoris"
```

Every organization should show `connect` and none should show `not authorized`. To back the change
out, delete `/etc/mosquitto/conf.d/zy-frugal-iot-acl.conf` and restart.

Nothing needs adding here per Pi: `frugal-iot-addbridge-prod` in 11b appends each bridge's own rule.

> `pattern readwrite %u/#` on its own denies `$SYS`, which would stop `frugal-iot-diagnostic`
> reporting whether a bridge is connected — it reads `$SYS/broker/connection/+/state` as the
> organization. The second rule above restores exactly that one topic and nothing else. Reading all
> of `$SYS` would also work and would hand every account the broker's client counts, subscription
> counts and traffic totals, which on a multi-organization broker tells each organization about the
> others.

#### 11b. Authorizing this Pi (run on the production server)

Once per Pi. On the production server, from its own directory:

```
npx --no frugal-iot-addbridge-prod <org-id> <site-name>
```

The site name only distinguishes one Pi from another within an organization — `northfield`,
`shed`, `village2` — and becomes part of the account name. The script creates the broker account,
adds its access-control rule, reloads the broker, and prints both the password and the exact
command to run in 11c.

Three things it checks, because each of them is a way this quietly fails:

* **The organization must already exist on the production server**, or the readings will arrive at
  its broker and nothing will record them — that server's logger subscribes per organization,
  driven by the files in its `config.d/organizations/`. If it is missing, add it there first with
  `frugal-iot-addorganization`, using the *same* organization id as this Pi.
* **Each Pi gets its own account**, rather than sharing the organization's. The organization's
  broker password is handed to every browser that logs in, so it is not a secret; a per-Pi account
  can be confined to one site and revoked on its own.
* **An existing account is left alone.** Re-running it for a site that already has one is refused
  rather than quietly issuing a new password, which would stop that Pi relaying without anyone
  touching it.

The password is shown once and is not stored anywhere you can read back — copy it before you lose
the output.

#### 11c. Bridging this Pi (run on the Pi)

Once per Pi. Run the command 11b printed, from this installation's directory:

```
cd ~/frugal-iot
npx --no frugal-iot-addbridge-pi <org-id> <prod-host> bridge-<site-name>
```

It asks for the password rather than taking it on the command line, so it stays out of your shell
history. Then it checks the far end is reachable and that its certificate is valid for that name,
writes `/etc/mosquitto/conf.d/frugal-iot-bridge.conf`, restarts the broker, and reports whether the
bridge actually connected.

The restart is unavoidable: Mosquitto does not pick up bridges on a reload signal, so `reload`
appears to succeed and changes nothing. It briefly disconnects every node, which they recover from
on their own.

> The configuration goes into `/etc/mosquitto/conf.d/` and not into this installation's
> `config.d/`, because it holds a password for the production server. Everything under `config.d/`
> is served to any logged-in browser by `/config.json`, so a credential put there would not stay
> private. The file is written mode 600 for the same reason.

To undo it: `sudo rm /etc/mosquitto/conf.d/frugal-iot-bridge.conf && sudo systemctl restart
mosquitto`. The Pi goes back to being self-contained and keeps everything it has recorded.

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
* whether a bridge to a production server is configured, what it relays, and whether it is
  connected right now (step 11) — the bridge password is not printed
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

### A topic that will not go away

Nodes publish almost everything **retained**, meaning the broker keeps the last value and gives it
to every new subscriber — which is how a dashboard shows a reading immediately instead of waiting
for the next one. The catch is that a topic published by mistake outlives the mistake. Misspell a
field, rename a module, flash a node with the wrong id, and that topic sits on the broker for ever,
appearing on every dashboard. Fixing the node does not remove it, and neither does restarting the
broker: the only way is to publish an empty message to that exact topic.

```
cd ~/frugal-iot
npx --no frugal-iot-clearretained 'myfarm/lotus/+/sht/temperture/#'
```

Quote the pattern or the shell will expand it. That lists what is retained and changes nothing;
add the word `delete` at the end of the same command to remove it.

> `delete` is a bare word rather than a `--delete` flag on purpose. npm parses the command line of
> an `npx` invocation itself and swallows any `--flag` it does not recognise, so `--delete` would
> never reach the script and it would quietly list instead of deleting.

> Look before deleting. A node's `min`, `max`, `color` and `wired` settings are retained messages
> too, and they are how the dashboard knows how to draw it — delete those and the node has to be
> restarted before it looks right again. A pattern of just `#` is refused outright.

On a Pi that is bridged to a production server (step 11), deleting here deletes there too: the
bridge forwards the empty message like any other.

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

`frugal-iot-init` leaves your own files alone. Two sections of its output are worth reading.

**"These files were left as you have them, but this release ships a different version"** covers the
sensor schema under `config.d/schema/`, and gives you a `diff` command for each. If you added a
sensor type of your own, that is exactly what it should say; if you did not, this release changed
the schema and the difference is worth reading.

**"Installed elsewhere from extras/, and older than this release"** covers the files that live
somewhere else — the broker configuration, its ACL, the systemd unit. It compares what is actually
in `/etc`, not the copy in `extras/`, because that copy is never overwritten and so differs for ever
once a release changes it. To bring anything it names up to date, re-run the installer:

```
bash node_modules/frugal-iot-server/scripts/install-pi.sh
```

It is safe to re-run: it changes only what is out of date, and it is the *only* correct way to
install these three, because none of them can simply be copied into place:

| file | why a plain `cp` is wrong |
|------|---------------------------|
| `extras/mosquitto.conf` | carries `plugin PLUGIN_PATH_SET_BY_INSTALLER`. The path differs by distribution, so the installer substitutes it. Copied as-is, **the broker will not start.** |
| `extras/aclfile` | `frugal-iot-addbridge-prod` appends a rule per Pi. Copying over it deletes them, and a mosquitto `acl_file` is deny-by-default — so every bridge goes on logging in and reaches nothing at all. |
| `extras/frugaliot.service` | written for user `pi` in `/home/pi/frugal-iot`; the installer rewrites `User`, `WorkingDirectory` and `ExecStart` for wherever this actually went. |

The installer will not overwrite an ACL file that has per-bridge rules in it. If this release adds a
rule to a broker that has them, it says which lines are missing and leaves the file alone for you to
add them by hand, then `sudo systemctl reload mosquitto`.

> **If your broker's configuration was assembled by hand** — several small files in
> `/etc/mosquitto/conf.d/` rather than the single `frugal-iot.conf` the installer writes — then
> `frugal-iot-init` reports those files under "Nothing at the usual place, so these were not
> compared", and re-running the installer is *not* what you want: it would add `frugal-iot.conf`
> alongside what you already have, declaring the same listeners and the same plugin twice. Compare
> by hand instead, and add only what is missing:
>
> ```
> sudo grep -hvE '^\s*(#|$)' /etc/mosquitto/conf.d/*.conf | sort -u > /tmp/running.txt
> grep -hvE '^\s*(#|$)' node_modules/frugal-iot-server/extras/mosquitto.conf | sort -u > /tmp/shipped.txt
> diff /tmp/running.txt /tmp/shipped.txt
> ```
>
> Lines only in the running config are usually this machine's own — TLS `certfile`/`keyfile`, a
> bridge `listener`, a `password_file` in a different place. Lines only in the shipped one are what
> this release added.

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

### One thing to do by hand after upgrading: grant WRITE

Commanding a device through the API (`/devices/action`, `/devices/property`) now requires a **WRITE**
permission, which is separate from READ and is *not* implied by ADMIN. New organizations get it
automatically, but an upgrade does not touch your database, so on an existing server nobody has it
yet and switching a relay on answers 401.

Grant it from the dashboard — **Admin → People**, pick the person, choose `WRITE` — or in one
statement, to everyone who already administers an organization:

```
sqlite3 frugal-iot.db "INSERT OR IGNORE INTO permissions (id, capability, org)
  SELECT id, 'WRITE', org FROM permissions WHERE capability = 'ADMIN';"
sudo systemctl restart frugaliot
```

Check who has it:

```
sqlite3 frugal-iot.db "SELECT id, org FROM permissions WHERE capability = 'WRITE';"
```

Do **not** grant WRITE to id `0`. That row means "every logged-in account", including anyone who has
just registered themselves, and handing them write access is exactly what the WRITE check exists to
prevent. (Read is a different matter — see the `(0, 'READ', ...)` rows, which are there on purpose.)

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

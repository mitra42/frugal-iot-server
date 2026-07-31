# Installing a Frugal IoT server on a Raspberry Pi

This guide installs a **complete, self-contained Frugal IoT server** on a Raspberry Pi:
an MQTT broker (Mosquitto), the Frugal IoT server, the logger that writes sensor data to disk,
and the web UI. Once installed, the Pi works **offline** — your sensor nodes talk to the Pi,
and you view the data from a phone or laptop on the same Wi-Fi. No internet needed after setup.

Two hardware paths are covered:

* [Raspberry Pi 4](#part-a--raspberry-pi-4) — the recommended, tested path.
* [Raspberry Pi Zero W](#part-b--raspberry-pi-zero-w) — smaller and cheaper, **not yet tested**, see the open questions in that section.

If you already have a working Linux server (not a Pi), you do not need this document —
see [README.md](https://github.com/mitra42/frugal-iot-server/blob/main/README.md) instead.

> **Status:** first draft, written 2026-07. The Pi 4 path has been written against the current
> code but not yet walked through end to end on hardware. Items still to confirm are collected
> under [Open questions](#open-questions) — please add your findings there as you go.

---

## Part A — Raspberry Pi 4

### A0. What you need before you start

**Hardware**

* Raspberry Pi 4 Model B. 2 GB RAM or more is comfortable; 1 GB should work.
* A microSD card, 16 GB or larger, Class 10 / A1 or better. (8 GB works but leaves little room for data.)
* The official Raspberry Pi USB-C power supply (5 V / 3 A). Phone chargers frequently cause
  random reboots and corrupted SD cards — this is the single most common cause of "it doesn't work".
* A way to write the SD card from your laptop: a built-in SD slot or a USB card reader.
* Note that you will often need an adapter from the SD format the Pi uses to the SD format of most laptop readers.

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

* A micro-HDMI to HDMI cable plus a monitor, and a USB keyboard — lets you log in directly, see boot
  errors, and finish Wi-Fi setup by hand. Wi-Fi configured through Imager does not always connect on
  the first boot (see step A2), so do not count on not needing these.
* An Ethernet cable from the Pi to your router — bypasses all Wi-Fi problems.

### A1. Write the operating system to the SD card

We use **Raspberry Pi OS Lite (64-bit)** — the version with no desktop. The Pi is a server;
a desktop would only consume memory and SD card space.

1. Insert the SD card into your laptop and start Raspberry Pi Imager.
2. **Choose Device** → *Raspberry Pi 4*.
3. **Choose OS** → *Raspberry Pi OS (other)* → *Raspberry Pi OS Lite (64-bit)*.
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
   * Do not be surprised if the Pi still does not join the network - this has been seen on a plain
     WPA2 network with correct details, and is quick to fix at the console with `nmtui` (step A2).
     A WPA3 network cannot use Imager's derived key at all, so there expect to use `nmtui`.
10. Enable SSH, either choose *Use password authentication* or paste your public key if you already use SSH keys.
11. Leave Raspberry Pi Connect off for now - feel free to experiment with this, as we haven't yet. 
12. Confirm that you want to save settings and write to the card, and click through operating system prompts wanting to stop you ! 

Writing and verifying takes several minutes.

Eject the card, put it in the Pi, connect power.

The first boot resizes the filesystem and reboots itself. Give it **two to three minutes** before
expecting it to answer.

### A2. Log in over the network

From your laptop's terminal:

```
ssh pi@frugaliot.local
```

Say `yes` to the fingerprint question, then give the password you set in Imager.

**If `frugaliot.local` is not found**, the `.local` (mDNS) name is not reaching you. In order of ease:

* Wait another minute and try again — the Pi may still be on its first boot.
* Log in to your Wi-Fi router's admin page and look for a device called `frugaliot` in its
  list of connected clients; note its IP address and use that instead: `ssh pi@192.168.1.42`.
* Plug in the HDMI and keyboard, log in at the console, and run `ip addr` to read the IP address,
  and `sudo journalctl -b | grep -i wpa` to see why Wi-Fi failed.

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

Once logged in, bring the system up to date and reboot:

```
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Wait a minute, then `ssh pi@frugaliot.local` again.

**Recommended:** in your router, give the Pi a fixed (reserved) IP address. Sensor nodes and
phones then have a stable address to talk to even where `.local` names do not work.

### A3. Install the prerequisites

```
sudo apt install -y nodejs npm sqlite3 zsh
node -v
npm -v
```

* `nodejs` — the server needs **Node 18 or later**. Raspberry Pi OS currently provides 20.19.2,
  which is fine. If `node -v` ever reports something older on your image, install a current
  version from [NodeSource](https://github.com/nodesource/distributions) instead.
* `npm` — installs the server; it is a separate package from `nodejs` on Debian.
* `sqlite3` — the database the server keeps its accounts in.
* `zsh` — the setup commands in step A6 are zsh scripts.

### A4. Install the Frugal IoT server

The server is an npm package. Make a directory for this server to live in and install it there —
that directory will hold your configuration, your data, and your database, while npm looks after
the software itself underneath it in `node_modules`.

```
mkdir ~/frugal-iot
cd ~/frugal-iot
npm install frugal-iot-server
```

That pulls in the web UI (`frugal-iot-client`) and the logger (`frugal-iot-logger`) as well.
Expect a few minutes on a Pi. Then set the directory up:

```
npx frugal-iot-init
```

This copies in the configuration files, creates the `data`, `ota` and `config.d/organizations`
directories, and creates the database. It never overwrites anything already there, so it is also
what you run after an upgrade to pick up newly added configuration.

> If `npm install` fails while building `sqlite3`, it could not find a ready-made binary for this
> platform and needs to compile one. Install the compiler toolchain and try again:
> `sudo apt install -y build-essential python3` then `npm install frugal-iot-server`.

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

> Many Android phones cannot resolve `.local` names. If you will view the dashboard from a phone,
> use the Pi's IP address instead — for example `broker: ws://192.168.1.42:9012` — and give the Pi
> a reserved address in your router so it does not change.

### A5. Install and configure the MQTT broker (Mosquitto)

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

That configuration names a password file, and Mosquitto will not start if the file is missing, so
create an empty one. The accounts inside it get created for you in the next step, by
`addorganization.zsh` — which runs as you rather than as root, hence the ownership:

```
sudo touch /etc/mosquitto/mosquitto_passwords
sudo chown ${USER}:mosquitto /etc/mosquitto/mosquitto_passwords
sudo chmod 640 /etc/mosquitto/mosquitto_passwords
```

Start the broker and have it start at every boot:

```
sudo systemctl enable mosquitto
sudo systemctl restart mosquitto
systemctl status mosquitto
```

`systemctl status` should say `active (running)`. Press `q` to exit. If it is not running,
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
requires an account. There are no accounts yet; step A6 creates the first one, and there is a
fuller test at the end of it.

### A6. Create your accounts and your organization

The database was created by `npx frugal-iot-init` in step A4, holding two accounts. One is
`everyone`, which nobody logs in as — it exists so that permissions granted to all logged-in users
have somewhere to live. The other is `superuser`, this server's administrator, which is given admin
rights over every organization you create. It starts with no password and cannot be logged into
until you give it one:

```
npx frugal-iot-setpassword superuser "<a-good-password>"
```

Use the same command later if you ever need to reset a password — for `superuser` or for any
other account.

Frugal IoT groups devices as **organization → project → device**. Create yours:

```
npx frugal-iot-addorganization dev "My Farm" you@example.com +61123456789 "<broker-password>"
```

The arguments are: organization id, display name, your email, your phone (`+` and digits only),
and a password. That one command writes `config.d/organizations/dev.yaml`, creates a login account
named after the organization (`dev`), grants it admin rights, creates its OTA directory, **and adds
the organization's account to the broker's password file** — which is why the broker had to be
installed first.

* **Organization id `dev`** — must be 1–10 lower-case letters or digits. It becomes the first part
  of every MQTT topic, so it must match what your sensor nodes are configured to publish to.
  `dev` is the default in the Frugal IoT node firmware, so it is the safe choice for a first install.
* **The password** goes into `config.d/organizations/dev.yaml` as `mqtt_password` and into the
  broker's password file, so it is a *machine* credential: the server's logger, your sensor nodes,
  and any browser showing this organization's dashboard all authenticate to the broker with it.
  Treat it as shared, not personal.

Tell Mosquitto to re-read the password file, so the new account works:

```
sudo systemctl restart mosquitto
```

**Give your login its own password.** That command set the `dev` *web login* password to the same
string as the broker password. They serve completely different purposes, so change the login one
now to something only you know — the broker credential is unaffected, and nothing needs to be kept
in step:

```
npx frugal-iot-setpassword dev "<your-own-login-password>"
```

**Now the full broker test.** In your SSH session subscribe as the organization, using the broker
password you chose above:

```
mosquitto_sub -h localhost -u dev -P '<broker-password>' -t '#' -v
```

It should sit there silently — no error, no exit. Open a **second** SSH session to the Pi and
publish something:

```
mosquitto_pub -h localhost -u dev -P '<broker-password>' -t 'dev/test/hello' -m '42'
```

`dev/test/hello 42` appearing in the first window proves the account, the password file and the
port 1883 listener your sensor nodes use are all working. The WebSocket listener on 9012 gets
exercised by the browser in step A7. Leave the subscriber running if you like — it is a useful
window onto what your nodes are doing. (`Ctrl-C` stops it.)

If you get `Connection Refused: not authorised`, the password does not match the one in
`config.d/organizations/dev.yaml`, or Mosquitto has not re-read the file since it changed.

### A7. Start the server by hand and check it

```
npx frugal-iot-server
```

You should see the configuration echoed back, then something like:

```
Doing OTA updates at /ota_update from /home/pi/frugal-iot/ota
Serving /node_modules from ./node_modules
User Database exists
Opened user database
Serving /data from ./data
Server starting on port 8080
Serving from ./node_modules/frugal-iot-client
mqtt dev connecting
mqtt dev connect
```

The two lines that matter most are `Server starting on port 8080` and `mqtt dev connect`.
`mqtt dev connect` means the server reached your broker and authenticated. If instead you see
repeated `mqtt dev close` or `offline`, the broker URL or the password is wrong — recheck
`config.d/mqtt.yaml` and that the password in `config.d/organizations/dev.yaml` matches the `dev`
broker account.

Now open a browser on your laptop or phone at:

```
http://frugaliot.local:8080
```

(or `http://<the Pi's IP>:8080`). You should get the Frugal IoT UI, and be able to log in as
username `dev` with the login password you set with `frugal-iot-setpassword` — not the broker
password. (`superuser` and its password work too.)

Once logged in and with your organization selected, the UI's MQTT status should show *connected*:
that is the browser using the organization's broker credentials over the WebSocket listener on
port 9012, which is the last untested piece of the chain. If it does not connect, check that the
`broker:` URL in `config.d/mqtt.yaml` is one this browser can actually resolve — a phone that
cannot look up `.local` names needs the Pi's IP address there instead.

Until a sensor node reports in there will be no data to look at, but the dashboard should load.

Stop the server with `Ctrl-C` before continuing.

### A8. Run the server as a service

So that it starts automatically at boot and restarts if it crashes:

```
sudo cp extras/frugaliot.service /etc/systemd/system/frugaliot.service
sudo nano /etc/systemd/system/frugaliot.service
```

Three lines need to match your Pi:

```
User=pi
WorkingDirectory=/home/pi/frugal-iot
ExecStart=/home/pi/frugal-iot/node_modules/.bin/frugal-iot-server
```

`WorkingDirectory` must be the directory you installed into, because that is where the server
finds its configuration and database. `ExecStart` is the command npm created for you there — check
it exists with `ls node_modules/.bin/frugal-iot-server`. Then:

```
sudo systemctl daemon-reload
sudo systemctl enable frugaliot
sudo systemctl start frugaliot
systemctl status frugaliot
```

To watch its log output, which is where the `mqtt dev connect` and incoming-reading messages now go:

```
journalctl -u frugaliot -f
```

Reboot the Pi (`sudo reboot`), wait a couple of minutes, and check `http://frugaliot.local:8080`
still answers. Your server is now installed.

### A9. Point your sensor nodes at the Pi

Your ESP8266/ESP32 nodes need to be told to use the Pi's broker — hostname or IP of the Pi,
port `1883`, username and password of the organization (`dev` / the broker password from step A6),
and the organization and project names to publish under.

> **To be written.** The node firmware lives in a separate repo
> ([mitra42/frugal-iot](https://github.com/mitra42/frugal-iot)) and its exact configuration
> settings are not documented here yet. See [Open questions](#open-questions).

You can confirm nodes are reporting without the UI at all, using the subscriber from step A6:

```
mosquitto_sub -h localhost -u dev -P '<broker-password>' -t '#' -v
```

Every reading from every node should scroll past.

### A10. HTTPS and over-the-air firmware updates

**To be written.** Everything above gives you a plain HTTP server on your local network, which is
all an offline installation needs. HTTPS matters for two things:

* **OTA updates** — ESP32 nodes require HTTPS to download new firmware, so OTA does not work on a
  plain-HTTP LAN install.
* **Reaching the Pi from the internet**, rather than only from the local Wi-Fi.

That section will cover: a DNS name for the Pi, port forwarding on the router, nginx as a reverse
proxy in front of port 8080, and certificates from Let's Encrypt via certbot. Both require the Pi
to have internet access, which is the opposite of the offline case this guide is aimed at.

---

## Part B — Raspberry Pi Zero W

**Not yet tested — do not follow this section expecting it to work.** It records what is known
and what has to be checked.

First, work out which board you have, because they are very different:

* **Raspberry Pi Zero 2 W** — 64-bit ARM (Cortex-A53), 512 MB RAM. Should follow **Part A**
  almost unchanged: choose *Raspberry Pi Zero 2 W* in Imager, and everything else applies.
  The concern is memory, not architecture.
* **Raspberry Pi Zero W** (the original) — 32-bit ARMv6 (BCM2835), 512 MB RAM. This is the
  awkward one: it needs the 32-bit Raspberry Pi OS, and **the official Node.js builds no longer
  support ARMv6**. Unofficial ARMv6 builds exist at
  [unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/download/release/), but
  which versions are available, and whether one recent enough for this server exists, needs checking.

Differences to expect on either Zero:

* Wi-Fi is 2.4 GHz only on the original Zero W — it cannot see a 5 GHz-only network.
* 512 MB of RAM is tight for `npm install`. Increasing the swap file is likely to be necessary.
* Micro-USB power and micro-USB OTG, not USB-C and USB-A — different cables from the Pi 4.
* No Ethernet socket, so the Ethernet fallback in Part A is unavailable. (The original Zero W can
  be reached as a USB gadget over the data port, which is an alternative worth documenting.)
* Everything will be slow. `npm install` may take a long time, especially if `sqlite3` has to be
  compiled from source — which is likely on ARMv6, since no ready-made binaries are published.

**Before this section can be written, I need to know:** which Zero you intend to support (original
W, 2 W, or both), and the results of trying a Node install on it.

---

## Open questions

Things this guide currently states with less confidence than the rest, to be resolved by
following it on real hardware. Please correct them in place, and delete them from this list, as
they get settled.

**Part A, to check while installing**

1. **`sqlite3` native build** (step A4) — does `npm install frugal-iot-server` find a prebuilt
   ARM64 binary, or does it need `build-essential`? If it always needs compiling, that should move
   up into step A3 as a normal prerequisite rather than a troubleshooting note.
2. **Mosquitto listeners** (step A5) — confirm that copying `extras/mosquitto.conf` into `conf.d`
   does not collide with the packaged default configuration, and that both 1883 and 9012 are
   reachable from another machine (`mosquitto_sub -h frugaliot.local ...` from your laptop).
3. **Empty password file** (step A5) - Mosquitto is started with a `password_file` that exists but
   is empty, because the first account is not created until step A6. Confirm
   it starts happily like that. If it refuses, the fix is to create a throwaway account with
   `sudo mosquitto_passwd -c -b /etc/mosquitto/mosquitto_passwords unused unused` before starting it.
4. **`frugal-iot-addorganization` writing the broker password** (step A6) — step A5 chowns
   `/etc/mosquitto/mosquitto_passwords` to your user so the script can add the account without
   sudo. Confirm it does, and that it reports "Set mosquitto password" rather than a warning.
5. **`.local` name resolution** (step A2) — does `frugaliot.local` work from your laptop, and from
   an Android phone? If Android fails as expected, the guide should recommend IP addresses more strongly.
6. **First-run output** (step A7) — the expected startup output above is adapted from README.md and
   a run on a development machine; replace it with the actual output from the Pi.
7. **Time and dates while offline** — an offline Pi has no internet clock to sync with, and no
   battery-backed clock, so after a power cut it starts with a wrong date until something corrects
   it. For a data logger writing timestamped files, that matters. Does the logger cope? Should this
   guide recommend a hardware RTC module, or a way for a phone or laptop on the LAN to set the time?

**Needs information I do not have**

8. **Sensor node configuration** (step A9) — what exactly does one set in the node firmware to
   point it at a local broker (broker host/port, credentials, organization, project)? Once you tell
   me, or point me at the right file in the `frugal-iot` repo, I can write that section properly.
9. **Which Pi Zero** (Part B) — original Zero W, Zero 2 W, or both.
10. **Bridging to the shared server** — the local broker could optionally bridge to
    naturalinnovation.org so data also reaches the shared server. Not covered here; a later task.
11. **Organization naming** — this guide sets up exactly one organization named `dev`, because that
    is the node firmware's default. Is that the right default for a farm installation, or should the
    guide encourage a meaningful organization id (which then has to be set in the node firmware too)?
12. **Upgrading an existing installation** — `npm update frugal-iot-server` followed by
    `npx frugal-iot-init` should be all it takes, since init adds missing configuration without
    touching what is there. Not yet tried on a server that has been running for a while.

**Tested on**

Fill this in as you go, so we know what the guide has actually been proven against:

| Date | Board | OS image | Node version | Result |
| --- | --- | --- | --- | --- |
|  | Pi 4 Model B |  |  |  |

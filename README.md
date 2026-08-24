# Frugal IoT server

## Installation

For a self-contained server on a Raspberry Pi - including the MQTT broker, and starting from a
blank SD card - see [INSTALLATION.md](INSTALLATION.md), which also has a script that does the whole
thing in one go once you can ssh in.

On a unix box that is already running ...

Check you have node & npm installed `node -v` - version 18 or later.
If not then you'll need nodejs from [nodejs.org](https://nodejs.org) or your package manager.
You also need `sqlite3` and `zsh` for the setup commands below.

Make a directory for this server, and install into it. That directory holds your configuration,
data and database; npm keeps the software itself under it in `node_modules`.
```
mkdir ~/frugal-iot
cd ~/frugal-iot
npm install frugal-iot-server
npx --no frugal-iot-init
```
`frugal-iot-init` copies in the configuration files, creates the `data`, `ota` and
`config.d/organizations` directories, points `config.d/server.yaml` at the web client npm just
installed, and creates the database. It never overwrites anything already there, so run it again
after an upgrade to pick up newly added configuration.

Edit `config.yaml` and `config.d/mqtt.yaml` (which broker to talk to) if the defaults do not suit.

A newly created database has two accounts in it, `everyone` (which holds the permissions every
logged-in user gets) and `superuser`, which has no password - so give it one:
```
npx --no frugal-iot-setpassword superuser "<a-good-password>"
```
On a database that existed before this account was introduced, that command reports
`no user 'superuser'`, because id 1 was already taken by whoever registered first - and that
account already has the superuser's privileges. Log in as that one instead.

Then add an organization - this writes its yaml file into `config.d/organizations`, creates a
login account of the same name with its permissions, and sets its password on the MQTT broker:
```
npx --no frugal-iot-addorganization <org-id> <org-name> <email> <phone> <broker-password>
```

That password is the one used by the nodes and the broker. It will also work for login, so it is
recommended to give the login its own:
```
npx --no frugal-iot-setpassword <org-id> <login-password>
```

Now start it:
```
npx --no frugal-iot-server
```
If its working correctly you should see something like
```
readYamlConfigFile ./config.yaml
... and then reading each of the other files

Broker wss://frugaliot.naturalinnovation.org/wss - organizations: dev
Not logging HTTP requests (morgan: false in config.d/server.yaml)
Doing OTA updates at /ota_update from ...some path.../ota
Serving /node_modules from node_modules/frugal-iot-client/node_modules then ./node_modules
User Database exists
Opened user database
Exec-ed starting SQL
Created logger client for API integration
Mounted API routes at /api
Serving /data from ./data
Server starting on port 8080
Logger not reporting individual messages (verbose: false in config.d/logger.yaml)
Collecting readings in memory, writing them out every 300 seconds
mqtt dev connecting
mqtt dev connect
Subscribing topic dev/# 0
```
Where the broker and organizations are reported back,
then it successfully connects to the mqtt server.

**It then goes quiet, and that is what should happen.** A new installation is set up to write as
little as it can, because the usual home for this is a Raspberry Pi running from an SD card, and
cards wear out from being written to. So it does not log a line per message received, nor a line
per web request, and readings are collected in memory and written out every five minutes rather
than one at a time. Seeing nothing after the lines above does not mean nothing is arriving.

To watch the messages while setting up, or to work out why a node's readings are not appearing,
turn it back on in `config.d/logger.yaml` and restart:
```
verbose: true
```
and each message reappears as `Received dev/lotus/esp8266-85ea2b/humidity   71.8`. `morgan: true`
in `config.d/server.yaml` does the same for web requests. Turn both off again afterwards.
There is more on what gets written, and how to see how much, under
[Wear and tear on the SD card](INSTALLATION.md#wear-and-tear-on-the-sd-card).

Open a browser pointing at for example `localhost:8080` and you should see the UI.

If something is not right, this reports on the whole installation - versions, configuration,
broker logins, what has been logged - and changes nothing:
```
npx --no frugal-iot-diagnostic
```

To upgrade later: `npm update frugal-iot-server` then `npx --no frugal-iot-init`.

#### Developing the server, client or logger

Work from git clones rather than the npm package:
```
git clone https://github.com/mitra42/frugal-iot-server.git
cd frugal-iot-server
npm install
scripts/init.zsh   # creates the database and directories; leaves the repo's config files alone
```
The commands above have in-repo equivalents - `scripts/addorganization.zsh` and
`scripts/setpassword.zsh` - and the server is `node frugal-iot-server.js`. All of them work on
the directory you run them in, which for a clone is the top of the repo.

To work on the client or the logger from sibling checkouts as well, link them in. This needs no
edit to any file, so there is nothing to remember to change back:
```
cd ../frugal-iot-client && npm link
cd ../frugal-iot-logger && npm link
cd ../frugal-iot-server && npm link frugal-iot-client frugal-iot-logger
```
The server then loads both from your checkouts. `ls -l node_modules/frugal-iot-*` shows whether the
links are in place - a later `npm install` or `npm update` can replace them with the published
packages, which looks like your changes having no effect.

There are commented-out alternatives in `config.d/server.yaml` (for `htmldir`) and in
`frugal-iot-server.js` (for the `MqttLogger` import) that do the same job by editing instead. They
work, but they are easy to publish by accident, so prefer the links.

Before publishing, run:
```
npm run prerelease
```
It checks the sensor schema and copies it into the examples that ship with `frugal-iot-logger`, sets
the service worker's cache version from the client version this release installs, and refuses if:
- the package is wired to a local checkout - a `file:` dependency, an `npm link`, a switched import
  or a switched `htmldir`;
- it requires a version of the client or logger that has not been published (a warning if published
  but not the newest, since a fresh install resolves to the newest anyway while an existing one may
  not move);
- anything git ignores would be published. `files` in `package.json` is an allow-list, which fails
  closed, but a file sitting in one of the listed directories goes out whether or not you meant it
  to - which is how a working copy of the user database was published in 0.3.2.

It also lists anything in the repository that would *not* be published and is not already accounted
for in `scripts/not-published.txt`, so a newly added file that installers need does not go missing
unnoticed. `npm run check-files` runs just that part.

`npm run check-schema` on its own reports sensor topics that do not say whether they are logged, or
that are logged with no rule about how often - both of which are easy to add by accident and
expensive on an SD card.

#### Running a production server
To set it up as a service that runs at startup (and instructions vary between flavors of Linux)

copy and edit `extras/frugaliot.service` to `/etc/systemd/system/frugaliot.service`. As shipped it
matches the Raspberry Pi install in [INSTALLATION.md](INSTALLATION.md) - user `pi`, installed in
`/home/pi/frugal-iot` - so on any other machine change `User`, `WorkingDirectory` and `ExecStart`
to the account and directory you installed into.
```
sudo cp extras/frugaliot.service /etc/systemd/system/frugaliot.service
sudo systemctl daemon-reload
sudo systemctl enable --now frugaliot
```
`daemon-reload` is the step that is easy to miss - without it systemd keeps using the version it
read before, and your edits appear to do nothing. After that `service frugaliot start|stop|restart`
works as usual, and `systemctl status frugaliot` reports whether it is running.

If you already have the service installed and only want to change one setting, `sudo systemctl edit
frugaliot` writes an override rather than touching the file, which is easier to undo
(`sudo systemctl revert frugaliot`).

Stop it with `service frugaliot stop` rather than killing it, so that readings still held in memory
are written out first.

Note that this will give you a HTTP server, but OTA on ESP32 requires HTTPS.

The easiest way to do this is to put it behind a reverse proxy like nginx or apache.
Feel free to reach out if you do not know how to do this.

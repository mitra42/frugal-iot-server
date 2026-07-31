# Frugal IoT server

## Installation

For a self-contained server on a Raspberry Pi - including the MQTT broker, and starting from a
blank SD card - see [INSTALLATION.md](INSTALLATION.md).

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
npx frugal-iot-init
```
`frugal-iot-init` copies in the configuration files, creates the `data`, `ota` and
`config.d/organizations` directories, and creates the database. It never overwrites anything
already there, so run it again after an upgrade to pick up newly added configuration.

Edit `config.yaml` and `config.d/mqtt.yaml` (which broker to talk to) if the defaults do not suit.

The database is created with a `superuser` account that has no password, so give it one:
```
npx frugal-iot-setpassword superuser "<a-good-password>"
```

Then add an organization - this writes its yaml file into `config.d/organizations`, creates a
login account of the same name with its permissions, and sets its password on the MQTT broker:
```
npx frugal-iot-addorganization <org-id> <org-name> <email> <phone> <broker-password>
```

That password is the one used by the nodes and the broker. It will also work for login, so it is
recommended to give the login its own:
```
npx frugal-iot-setpassword <org-id> <login-password>
```

Now start it:
```
npx frugal-iot-server
```
If its working correctly you should see something like
```
readYamlConfigFile ./config.yaml
... and then reading each of the other files

Broker wss://frugaliot.naturalinnovation.org/wss - organizations: dev
Doing OTA updates at /ota_update from ...some path.../ota
Serving /node_modules from ./node_modules
User Database exists
Opened user database
Exec-ed starting SQL
Serving /data from ./data
Server starting on port 8080
mqtt dev connecting
mqtt dev connect
Subscribing topic dev/# 0
Received dev/lotus/esp8266-85ea2b/humidity   71.8
```
Where the broker and organizations are reported back, 
then it successfully connects to the mqtt server
and receives data from nodes attached to it. 

Open a browser pointing at for example `localhost:8080` and you should see the UI.

To upgrade later: `npm update frugal-iot-server` then `npx frugal-iot-init`.

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

To work on the client or logger from sibling checkouts, switch two places to their commented-out
development lines:
- `config.d/server.yaml` - `htmldir` and `nodemodulesdir` point at `../frugal-iot-client`
- `frugal-iot-server.js` - the `MqttLogger` import points at `../frugal-iot-logger/index.js`

Take care not to commit those local switches, and note that `npm publish` packages your working
tree - so check with `npm pack --dry-run` before publishing.

#### Running a production server
To set it up as a service that runs at startup (and instructions vary between flavors of Linux)

copy and edit `extras/frugaliot.service` to `/etc/systemd/system/frugaliot.service`
you'll need to change the user, the directory you installed into, and `ExecStart`

You can run`service frugaliot start` to start it
and `systemctl enable frugaliot` to make sure it starts at boot. 

Note that this will give you a HTTP server, but OTA on ESP32 requires HTTPS.

The easiest way to do this is to put it behind a reverse proxy like nginx or apache.
Feel free to reach out if you do not know how to do this.

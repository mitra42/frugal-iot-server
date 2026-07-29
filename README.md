# Frugal IoT server

## Installation

For a self-contained server on a Raspberry Pi - including the MQTT broker, and starting from a
blank SD card - see [INSTALLATION.md](INSTALLATION.md).

On a unix box that is already running ... 

Check you have node & npm installed `node -v`.
If not then you'll need nodejs from [nodejs.org](https://nodejs.org)

```
git clone https://github.com/mitra42/frugal-iot-server.git
cd frugal-iot-server
npm install
npm update # To make sure you have the latest version of the client since it comes from github
```
edit `config.yaml`

Create the user database, and give the `superuser` account it seeds a password
(the server also runs `frugal-iot-createdb.sql` itself at every startup, so this is only needed
up front if you want to add an organization before first run).
```
sqlite3 frugal-iot.db < frugal-iot-createdb.sql
scripts/setpassword.zsh superuser "<a-good-password>"
```

in `config.d` put a yaml file for your organization 
- the repo has an example for `dev` which is the developers. 
- or `scripts/addorganization.zsh <org-id> <org-name> <email> <phone> <password>` will write one,
  along with a login account, its permissions, and its broker password.
```
node frugal-iot-server.js
```
If its working correctly you should see something like
```
readYamlConfigFile ./config.yaml
... and then reading each of the other files

Config= {
  server: { port: 8080 },
  mqtt: { broker: 'wss://frugaliot.naturalinnovation.org/wss' },
  organizations: { 
    dev: { mqtt_password: 'public', projects: [Array] } 
  }
}
Doing OTA updates at /ota_update from ...some path.../frugal-iot-server/ota
Serving /node_modules from ../frugal-iot-client/node_modules
User Database exists
Opened user database
Serving /data from ./data
Server starting on port 8080
Serving from ...some path.../frugal-iot-server/node_modules/frugal-iot-client
Server starting on port 8080
mqtt dev connecting
mqtt dev connect
Received dev/lotus/esp8266-85ea2b/humidity   71.8
```
Where the config is reported back, 
then it successfully connects to the mqtt server
and receives data from nodes attached to it. 

Open a browser pointing at for example `localhost:8080` and you should see the UI.

#### Developing the client or the logger

The repo ships in production mode: the client and logger come from `node_modules`, so a fresh
clone runs as-is. To work on either of them from a sibling checkout instead, switch two places
to their commented-out development lines:
- `config.d/server.yaml` - `htmldir` and `nodemodulesdir` point at `../frugal-iot-client`
- `frugal-iot-server.js` - the `MqttLogger` import points at `../frugal-iot-logger/index.js`

Take care not to commit those local switches.

#### Running a production server
To set it up as a service that runs at startup (and instructions vary between flavors of Linux)

copy and edit `frugaliot.service` to `/usr/lib/systemd/system/frugaliot.service` 
you'll need to change the user and the place where its cloned and possibly the location of `node`

You can run`service frugaliot start` to start it
and `systemctl enable frugaliot` to make sure it starts at boot. 

Note that this will give you a HTTP server, but OTA on ESP32 requires HTTPS.

The easiest way to do this is to put it behind a reverse proxy like nginx or apache.
Feel free to reach out if you do not know how to do this.

# Frugal IoT server

## Installation

On a unix box ... 

Check you have node & npm installed `node -v`.
If not then you'll need nodejs from [nodejs.org](https://nodejs.org)

```
git clone https://github.com/mitra42/frugal-iot-server.git
cd frugal-iot-server
npm install
npm update # To make sure you have the latest version of the client since it comes from github
```
edit `config.yaml`

in `config.d` put a yaml file for your organization 
- the repo has an example for `dev` which is the developers. 
```
node frugal-iot-server.js
```
If its working correctly you should see something like
```
Config= {
  server: { port: 8080 },
  mqtt: { broker: 'wss://frugaliot.naturalinnovation.org/wss' },
  organizations: { 
    dev: { mqtt_password: 'public', projects: [Array] } 
  }
}
Serving from /Users/mitra/git/github_mitra42/frugal-iot-server/node_modules/frugal-iot-client
Server starting on port 8080
mqtt dev connecting
mqtt dev connect
Received dev/lotus/esp8266-85ea2b/humidity   71.8
```
Where the config is reported back, 
then it successfully connects to the mqtt server
and receives data from nodes attached to it. 

Open a browser pointing at for example `localhost:8080` and you should see the UI.

#### Running a production server
To set it up as a service that runs at startup (and instructions vary between flavors of Linux)

copy and edit `frugaliot.service` to `/usr/lib/systemd/system/frugaliot.service` 
you'll need to change the user and the place where its cloned and possibly the location of `node`

You can run`service frugaliot start` to start it
and `systemctl enable frugaliot` to make sure it starts at boot. 

Note that this will give you a http server, and OTA on ESP32 requires HTTPS.

The easiest way to do this is to put it behind a reverse proxy like nginx or apache.
Feel free to reach out if you do not know how to do this.

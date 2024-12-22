# Frugal IoT server

## Installation

On a unix box ... 

Check you have node & npm installed `node -v`.
If not then you'll need nodejs from [nodejs.org](https://nodejs.org)

```
git clone https://github.com/mitra42/frugal-iot-server.git
cd frugal-iot-server
npm install
```
edit `config.yaml`

This will change as we start reading organization specific configurations from `config.d`
```
node frugal-iot-server.js
```
If its working correctly you should see something like
```
Config= {
  server: { port: 8080 },
  mqtt: { broker: 'ws://naturalinnovation.org:9012' },
  organizations: [ { name: 'dev', mqtt_password: 'public', projects: [Array] } ]
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

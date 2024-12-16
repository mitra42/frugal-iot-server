TODO extract this from frugal-iot/README.md

# Frugal IoT server

## Installation

On a unix box ... 
```
git clone https://github.com/mitra42/frugal-iot-server.git
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
Received dev/Lotus Ponds/esp8266-85ea2b/humidity   71.8
```
Where the config is reported back, 
then it successully conects to the mqtt server
and receives data from nodes attached to it. 

# OTA Directory

Put files here for automated serving via OTA.

Use the directory scheme as follows - 
Note this might change in Jan 2025 - see [Issue #37](https://github.com/mitra42/frugal-iot/issues/37)

* ota
  * <organization> e.g. `dev`
    * <project> e.g. `lotus`
      * <node>  e.g. `esp8266-85ea2b`
        * <attribs> see notes
          * frugal-iot.ino.bin

The `attribs` are a series of attributes that are used to determine the best file to serve to a node.
They are built from the different modules included. 
The easist way to find it, is to in the Arduino IDE Serial consule look for what the device is requesting.
This will probably change ! 

The OTA will server a matching `bin` file if, and only if it has an MD5 hash 
different from the file on the device. 
Take care - if you flash a device it may try and auto update to an OLDER version.
This needs fixing (also see [Issue #37](https://github.com/mitra42/frugal-iot/issues/37))

Wild cards work so a file in /ota/dev/lotus/+/<attribs>/frugal-iot.ino.bin
will be updated onto any node currently running with the right attribs. 

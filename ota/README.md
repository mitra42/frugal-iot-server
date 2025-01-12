# OTA Directory

Put files here for automated serving via OTA.

Use the directory scheme as follows - 
Note this might change in Jan 2025 - see [Issue #37](https://github.com/mitra42/frugal-iot/issues/37)

* ota
  * <organization> e.g. `dev`
    * <project> e.g. `lotus`
      * <node>  e.g. `esp8266-85ea2b`
      * <attribs>  e.g. `esp8266-sht`
        * frugal-iot.ino.bin

The `attribs` is a board type defined by the `org` in _local.h. 

The OTA will server a matching `bin` file if, and only if it has an MD5 hash 
different from the file on the device. 
Take care - if you flash a device it may try and auto update to an OLDER version.
This needs fixing (also see [Issue #37](https://github.com/mitra42/frugal-iot/issues/37))

New frugal-iot.ino.bin files can be dropped in directories targeted at either 
a type of board, or a specific node.  
If both match - it will prefer the node. 

This means, if you want to change the type of a board, drop a copy of the .ino.bin file 
into a directory for that specific node, OR just flash it via the serial port.

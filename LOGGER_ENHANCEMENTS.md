# Logger Enhancements Required for API Integration

## Overview

The Frugal IoT Server API integration requires two new methods to be added to the `MqttLogger` class in `frugal-iot-logger/index.js`. These methods enable:

1. **Dynamic device schema generation** - Returns the schema for a specific device
2. **MQTT command routing** - Sends commands to devices via MQTT

Since the logger runs in the **same process** as the server, these methods should be called directly (not via HTTP).

---

## Required Method 1: getDeviceSchema()

### Purpose
Generate and return the device schema based on the MQTT topics that have been seen for that device.

### Signature
```javascript
getDeviceSchema(org, project, deviceId)
```

### Parameters
- `org` (string): Organization
- `project` (string): Project  
- `deviceId` (string): Device ID (e.g., "esp32-123456")

### Returns
```javascript
{
  "device-platform-device-id": "dev/org/esp32-123456",
  "farm-platform-device-id": null,
  "modules": {
    "sht": {
      "name": "SHT Sensor",
      "fields": [
        {
          "field": "temperature",
          "name": "Temperature",
          "type": "float",
          "rw": "r",
          "min": -40,
          "max": 125,
          "units": "Cel"
        },
        {
          "field": "humidity",
          "name": "Humidity",
          "type": "float",
          "rw": "r",
          "min": 0,
          "max": 100,
          "units": "%RH"
        }
      ]
    }
  }
}
```

### Implementation Notes
- Look at recently seen MQTT topics for the device
- Extract modules and fields from topic structure
- Determine read/write permissions from known topics
- Get type information from schema definitions in config
- Return null for farm-platform-device-id (set by server)

### Example Implementation Location
Add to `MqttLogger` class in `frugal-iot-logger/index.js`:

```javascript
getDeviceSchema(org, project, deviceId) {
  // 1. Get the nodes data for this device
  const nodes = this.reportNodes(); // { org: { project: { deviceId: lastSeen } } }
  
  if (!nodes[org]?.[project]?.[deviceId]) {
    return null; // Device not found
  }

  // 2. Build schema from known topics and configuration
  // This requires iterating through known MQTT topics for this device
  // and extracting module/field information
  
  const schema = {
    'device-platform-device-id': `${org}/${project}/${deviceId}`,
    'farm-platform-device-id': null,
    modules: {}
  };

  // 3. Extract modules and fields from this.topics structure
  // (implementation depends on how topics are stored)

  return schema;
}
```

---

## Required Method 2: sendCommand()

### Purpose
Send a command to a device via MQTT by publishing to the appropriate control topic.

### Signature
```javascript
async sendCommand(org, project, deviceId, command, value)
```

### Parameters
- `org` (string): Organization
- `project` (string): Project
- `deviceId` (string): Device ID
- `command` (string): Command in "module/field" format (e.g., "relay/on")
- `value` (any): Value to send (number, boolean, string, etc.)

### Returns
```javascript
{
  status: 'sent' | 'error',
  message: 'Human readable status'
}
```

### Error Responses
```javascript
// Device offline/unreachable
{
  status: 'error',
  message: 'Device offline'
}

// Invalid command format
{
  status: 'error',
  message: 'Invalid command format'
}
```

### Implementation Notes
- Convert command format "module/field" to MQTT topic
- Typical topic format: `{org}/{project}/{deviceId}/{module}/set/{field}`
- Publish value to MQTT topic
- Handle MQTT client availability
- Can check if device recently seen for "offline" detection

### Example Implementation Location
Add to `MqttLogger` class:

```javascript
async sendCommand(org, project, deviceId, command, value) {
  // 1. Validate inputs
  if (!command.includes('/')) {
    return { status: 'error', message: 'Command must be in module/field format' };
  }

  const [module, field] = command.split('/');

  // 2. Check if MQTT client is connected
  if (!this.mqttClient || !this.mqttClient.connected) {
    return { status: 'error', message: 'MQTT not connected' };
  }

  // 3. Build MQTT topic and publish
  const topic = `${org}/${project}/${deviceId}/${module}/set/${field}`;
  
  return new Promise((resolve) => {
    this.mqttClient.publish(topic, String(value), { retain: false }, (err) => {
      if (err) {
        resolve({
          status: 'error',
          message: `Failed to publish: ${err.message}`
        });
      } else {
        resolve({
          status: 'sent',
          message: 'Command sent to device'
        });
      }
    });
  });
}
```

---

## Integration with Server

Once these methods are added to the logger, the server will:

1. **Call getDeviceSchema()** when:
   - API receives `GET /api/devices/schema?device=dev/org/esp32`
   - Results are cached (5-minute TTL)
   - Used to validate commands in `POST /api/devices/command`

2. **Call sendCommand()** when:
   - API receives `POST /api/devices/command` with valid schema
   - Command is validated against schema first
   - Then sent directly via MQTT

---

## Benefits of This Approach

✅ **Direct process communication** - No HTTP overhead
✅ **Efficiency** - Eliminates network latency
✅ **Simplicity** - Leverages existing MQTT client
✅ **Reliability** - Same process means no network failures
✅ **Testability** - Can be tested in isolation
✅ **Scalability** - No additional service needed

---

## Testing

### After Implementation

1. **Test schema generation**:
```javascript
const schema = mqttLogger.getDeviceSchema('dev', 'lotus', 'esp32-123456');
console.log(schema);
// Should return valid schema with modules and fields
```

2. **Test command sending**:
```javascript
const result = await mqttLogger.sendCommand('dev', 'lotus', 'esp32-123456', 'relay/on', true);
console.log(result);
// Should return { status: 'sent', message: '...' }
```

3. **Test from server**:
```bash
npm test  # Should pass 76 tests
```

---

## Files to Modify

**File**: `../frugal-iot-logger/index.js`
**Class**: `MqttLogger`
**Methods to add**: 
- `getDeviceSchema(org, project, deviceId)`
- `sendCommand(org, project, deviceId, command, value)`

---

## Questions?

Refer to:
- API.md Section 5.2 for schema format
- API.md Section 6.5 for command format
- Test files in `/test/` for expected behavior



---
title: "Farm IoT Interoperability Standard"
status: "Early Draft"
version: "0.1"
date: "2026-03-09"
authors:
  - name: "Mitra Ardron"
    affiliation: "Natural Innovation (naturalinnovation.org)"
    email: "mitra@mitra.biz"
---

# Farm IoT Interoperability Standard

## Abstract

This document defines the interoperability protocol between a Device-Platform
and a Farm-Platform. It specifies how sensor data is structured and communicated,
how a Farm-Platform makes requests of a Device-Platform, and how a Device-Platform
pushes data and notifications to a Farm-Platform.

---

## Status of This Document

This is an early draft. It has not yet been reviewed or adopted by any standards body.

The intended audiences at this time are:

- Developers of IoT devices and Device-Platforms (such as Frugal IoT or OurSci)
- Developers of Farm-Platforms (such as FarmOS or LiteFarm)
- Developers of solutions that integrate a Farm-Platform with multiple Device-Platforms

Feedback and contributions are welcomed from all communities with an interest in
open farm data interoperability.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Layer 1a — Command Structure](#3-layer-1a--command-structure)
4. [Layer 1b — Packet Format](#4-layer-1b--packet-format)
5. [Layer 1c — Data Schema](#5-layer-1c--data-schema)
6. [Section 2 — Farm-Platform to Device-Platform](#6-section-2--farm-platform-to-device-platform)
7. [Section 3 — Device-Platform to Farm-Platform](#7-section-3--device-platform-to-farm-platform)
8. [Security Considerations](#8-security-considerations)
9. [Privacy Considerations](#9-privacy-considerations)
10. [References](#10-references)

Annexes:
- [Annex A — Data Schema Reference](#annex-a--data-schema-reference)
- [Annex B — [Title]](#annex-b)
- [Annex C — [Title]](#annex-c)
- [Annex D — [Title]](#annex-d)
- [Annex E — [Title]](#annex-e)

---

## 1. Introduction

### 1.1 Background

There is high potential, but very little use of IoT sensors in the Agroecology
space, due to cost and lack of integration between systems.

Projects like Frugal IoT and OurSci are building affordable devices for the
Agro-Ecology space that deliver real-time data, or one-off (e.g. lab soil
measurement) data. To be useful, data from these devices needs to be available
inside agroecology platforms (LiteFarm, FarmOS, etc.) where it can be integrated
with other data, or used for example for predictions and recommendations.

If, for example, Frugal IoT integrates only with LiteFarm, this creates lock-in
for farmers: if they choose to move to FarmOS, their devices become unusable
eWaste. Implementing interfaces between multiple platforms and multiple device
projects turns into a significant problem quickly. Each integration requires time
and resources from over-stretched and under-funded teams.

The solution is to specify a common interface (an API). Each Farm-Platform
implements one API, and each Device-Platform implements one API. Any farmer can
then choose their preferred devices and their preferred platform, knowing they
will work together.

### 1.2 Scope

This standard is concerned exclusively with communication between a
Device-Platform and a Farm-Platform. It does not specify:

- Internal Device-to-Device-Platform communication protocols
- Control logic internal to any platform
- User interface or experience requirements for Farm-Platforms

Exception: modification of setpoints on control systems operating within
Devices may be within scope where relevant to interoperability (see Section 6.5).

### 1.3 Design Goals

- **Easy to implement** in the context of existing Farm-Platforms and
  Device-Platforms, minimising the burden on resource-constrained teams
- **Easy to extend** as needs evolve and experience is gained
- **Supports both static and streaming devices** — including single-reading
  devices (such as soil testers) and those delivering a continuous stream of
  readings (such as temperature and humidity sensors)
- **Supports actuation** — allows setpoint control and direct control of
  actuators such as irrigation systems

---

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119].

| Term | Definition |
|------|------------|
| **Common Farm Conventions (CFC)** | A specification for communicating farm data, using [JSON-LD — TBD] as the underlying data format. |
| **Device** | A sensor device deployed in the field or laboratory, equipped with communications capability and one or more sensors. Also referred to as "Node" or "Thing" in other contexts. *(FrugalIoT: node)* |
| **Device-Platform** | A platform to which Devices connect natively and which manages device communication. *(FrugalIoT: Server)* (e.g. frugaliot.naturalinnovation.org) |
| **Farm-Platform** | A platform that provides a user experience (UX) to farmers, aggregating data from one or more Farms. |
| **Farm** | A location comprising one or more Devices, treated as a logical group by a Farm-Platform. *(FrugalIoT: Project)* |
| **Actuation** | The process by which a platform sends a message to a Device causing a physical action, such as activating irrigation or adjusting an automated setpoint. |
| **Control** | Internal platform processes that interpret sensed data and trigger Actuation. Control logic is explicitly **out of scope** for this standard. Exception: modification of setpoints on control systems operating *within* Devices may be within scope where relevant to interoperability. |
| **Device Schema** | A per-device or per-platform document that maps field names (as used in the `n` field of SenML packets) to their semantic meaning for a Farm-Platform. See Section 5.2. |

---

## 3. Layer 1a — Command Structure

### 3.1 Overview

This layer defines the structure of commands used in both directions of
communication between Device-Platform and Farm-Platform. Commands defined
here are referenced by Section 2 (Farm-Platform requests) and Section 3
(Device-Platform notifications and push).

### 3.2 Command Format

[Define the general structure of a command — e.g. method, endpoint pattern,
required headers, authentication tokens.]

### 3.3 Command Types

| Command Type | Direction | Description |
|---|---|---|
| Data Request | Farm-Platform → Device-Platform | Request sensor data for a device over a time period |
| User Registration | Farm-Platform → Device-Platform | Register a user with the Device-Platform |
| Device Registration | Farm-Platform → Device-Platform | Register a device to a user |
| Device Command | Farm-Platform → Device-Platform | Send a command to a Device (e.g. Actuation) |
| Data Push | Device-Platform → Farm-Platform | Push sensor data to Farm-Platform |
| Notification | Device-Platform → Farm-Platform | Send an event or alert notification |

### 3.4 Authentication and Authorisation

[Define how commands are authenticated — e.g. bearer tokens, API keys, OAuth2.]

### 3.5 Error Handling

[Define common error codes and response structures for failed commands.]

---

## 4. Layer 1b — Packet Format

### 4.1 Overview

This layer defines the format of data packets exchanged between platforms,
regardless of transport method. All data packets in this standard MUST conform
to SenML as defined in [RFC 8428].

### 4.2 SenML Conformance

[Describe the required SenML fields, any constraints or profiles applied to
the base RFC 8428 specification, and any extensions used.]

### 4.3 Encoding

All implementations MUST support JSON encoding (`application/senml+json`).
CBOR encoding is not required by this standard.

### 4.4 Example Packet

The following is an example SenML packet conveying temperature and humidity
readings from a device:

```json
[
  {"bn": "dev/lotus/esp32-123456/", "bt": 1.276020076001e+09},
  {"n": "sht/temperature", "v": 32.0, "u": "Cel"},
  {"n": "sht/humidity", "v": 85.2, "u": "%RH"}
]
```

Where `bn` is the base name (device identifier prefix), `bt` is the base time
(Unix timestamp), `n` is the field name relative to the base name, `v` is the
numeric value, and `u` is the unit of measurement per [RFC 8428].

---

## 5. Layer 1c — Data Schema

### 5.1 Overview

This layer defines the semantic meaning of the data communicated within
packets conforming to Layer 1b. Rather than specifying a single fixed schema
for the standard, this layer defines a mechanism by which a Device-Platform
can advertise the meaning of the fields its devices produce.

### 5.2 Device Schema

Each Device-Platform SHOULD provide a Device Schema for each device it manages.
A Device Schema maps field names (as used in the `n` field of SenML packets,
see Section 4.4) to their semantic meaning, enabling a Farm-Platform to
correctly interpret received data.

The Device Schema is not a fixed schema defined by this standard — it is a
per-device or per-platform document. [An example Device Schema is provided in
Annex A.]

A Farm-Platform MAY fetch the Device Schema for a given device using:

```
GET /devices/schema?device={device-id}
```

The response format for Device Schemas is [TBD].

### 5.3 Field Conformance

Data fields in SenML packets SHOULD be drawn from the Device Schema. A
Farm-Platform that receives a field it does not recognise or does not require
MUST NOT treat this as an error — it SHOULD silently ignore unrecognised
fields. It is expected that a Device-Platform may communicate data that a
given Farm-Platform does not care about.

Where a response is returned to the Device-Platform, the Farm-Platform SHOULD
indicate which fields were accepted and which were ignored.

### 5.4 Extensibility

[Define how implementations may extend the schema for proprietary or
experimental data fields, e.g. use of vendor-prefixed field names.]

---

## 6. Section 2 — Farm-Platform to Device-Platform

### 6.1 Overview

This section defines the requests and commands a Farm-Platform MAY issue to
a Device-Platform. All requests use HTTP. Commands MUST be authenticated as
defined in Layer 1a (Section 3.4).

### 6.2 Request Data for a Device

#### 6.2.1 Purpose

Request historical or recent sensor data for a specific Device over a defined
time period.

#### 6.2.2 Request

```
GET /data?device={device-id}&from={timestamp}&to={timestamp}
```

| Parameter | Required | Description |
|---|---|---|
| `device` | MUST | Fully qualified device identifier (e.g. `dev/lotus/esp1234/sht/temperature`) |
| `from` | MUST | Start of time period (ISO 8601 or Unix timestamp) |
| `to` | SHOULD | End of time period (ISO 8601 or Unix timestamp). Defaults to now if omitted. |

#### 6.2.3 Response

A SenML packet (Layer 1b) containing data conforming to the Device Schema
(Layer 1c). The response MAY include data points outside the requested time
period (e.g. the most recent reading before `from`). Implementations SHOULD
document their behaviour in this regard.

#### 6.2.4 Error Cases

[Define relevant error responses — e.g. device not found, unauthorised, no data
in range.]

---

### 6.3 Register a User

#### 6.3.1 Purpose

Register a Farm-Platform user with the Device-Platform, enabling subsequent
device registration and data access.

#### 6.3.2 Request

```
POST /users/register
```

```json
{
  "user-id": "[farm-platform-user-id]",
  "credentials": { "[TBD]" }
}
```

#### 6.3.3 Response

```json
{
  "status": "registered",
  "device-platform-user-id": "[id]"
}
```

#### 6.3.4 Error Cases

[Define relevant error responses — e.g. user already exists, invalid credentials.]

---

### 6.4 Register a Device to a User

#### 6.4.1 Purpose

Associate a Device with a registered user on the Device-Platform.

#### 6.4.2 Request

```
POST /devices/register
```

```json
{
  "user-id": "[device-platform-user-id]",
  "device-id": "[device-identifier]",
  "metadata": { "[TBD]" }
}
```

#### 6.4.3 Response

```json
{
  "status": "registered",
  "device-platform-device-id": "[id]"
}
```

#### 6.4.4 Error Cases

[Define relevant error responses — e.g. device not found, already registered,
user not found.]

---

### 6.5 Send a Command to a Device

#### 6.5.1 Purpose

Send an actuation command or setpoint change to a Device via the
Device-Platform. This is the primary mechanism for Actuation as defined in
the Terminology (Section 2).

#### 6.5.2 Request

```
POST /devices/command
```

```json
{
  "device-id": "[device-identifier]",
  "command": "[command-name]",
  "parameters": { "[TBD]" }
}
```

#### 6.5.3 Response

```json
{
  "status": "accepted | rejected",
  "reason": "[optional explanation]"
}
```

#### 6.5.4 Error Cases

[Define relevant error responses — e.g. device offline, command not supported,
unauthorised.]

---

## 7. Section 3 — Device-Platform to Farm-Platform

### 7.1 Overview

This section defines how a Device-Platform communicates with a Farm-Platform,
both to push sensor data and to send notifications. Transport MAY use HTTP POST
or MQTT. [Further commands to be defined.]

### 7.2 Push Sensor Data

#### 7.2.1 Purpose

Push one or more sensor readings from one or more Devices to the Farm-Platform.
This is the primary mechanism by which a Device-Platform delivers data without
an explicit request from the Farm-Platform.

#### 7.2.2 Request

```
POST /data
```

The request body MUST be a SenML packet (Layer 1b) which already encodes the
device identifier (via `bn`) and timestamps (via `bt` or `t`). No device
identifier is required in the URL.

#### 7.2.3 Response

[TBD — likely an acknowledgement including which fields were accepted/ignored
per Section 5.3.]

#### 7.2.4 Error Cases

[TBD]

---

### 7.3 Send a Notification

#### 7.3.1 Purpose

Send an event or alert notification from the Device-Platform to the
Farm-Platform — for example, to alert a farmer that a threshold has been
exceeded.

#### 7.3.2 Request

```
POST /notification
```

The request body MUST be a SenML packet (Layer 1b). Notifications SHOULD use
a string value field (`vs`) to carry a human-readable message. For example:

```json
[
  {"bn": "dev/lotus/esp32-123456/", "bt": 1.276020076001e+09},
  {"n": "message", "vs": "Your paddock is too dry"}
]
```

Additional structured fields MAY be included alongside the message to provide
machine-readable context.

#### 7.3.3 Response

[TBD]

#### 7.3.4 Error Cases

[TBD]

### 7.4 [Further commands TBD]

---

## 8. Security Considerations

[Describe security implications — authentication between platforms, data
integrity, authorisation of commands, risks of unauthenticated Actuation.]

---

## 9. Privacy Considerations

[Describe privacy implications — what farm and sensor data is transmitted, data
minimisation requirements, obligations on platform implementors.]

---

## 10. References

### 10.1 Normative References

- [RFC 2119] Bradner, S. "Key words for use in RFCs to Indicate Requirement
  Levels". IETF, 1997. https://www.rfc-editor.org/rfc/rfc2119
- [RFC 8428] Jennings, C. et al. "Sensor Measurement Lists (SenML)". IETF, 2018.
  https://www.rfc-editor.org/rfc/rfc8428

### 10.2 Informative References

- [[REF]] [Author]. "[Title]". [Publisher], [Year]. [URL]

---

## Annex A — Data Schema Reference

**(Normative)**

[Example Device Schema to be added. The schema maps field names as used in the
`n` field of SenML packets to their semantic meaning — including units,
descriptions, and valid value ranges. This is a per-device or per-platform
schema, not a fixed schema defined by this standard.]

---

## Annex B — [Title]

**(Normative | Informative)**

[TBD]

---

## Annex C — [Title]

**(Normative | Informative)**

[TBD]

---

## Annex D — [Title]

**(Normative | Informative)**

[TBD]

---

## Annex E — [Title]

**(Normative | Informative)**

[TBD]

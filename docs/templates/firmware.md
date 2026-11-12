# <Feature> (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/<name>.md) · [Manager](../../manager/docs/<name>.md) · [Hardware](../../hardware/docs/<name>.md)

## What it does
Two or three sentences, plain words.

## How it works on the ESP
Hardware and driver detail: peripherals, timers, pull-ups, debounce, sampling, limits, which pins are allowed and why.

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|

Where they are saved (NVS key/namespace) and when they are applied (boot, immediately, after reboot).

## Commands
Exact JSON in and out, one block per command:
```json
{"cmd":"...", ...}
```
Errors it can return.

## Events and state
What it publishes and where: WebSocket `/api/v1/ws` frames, MQTT topics, fields in `GET /api/v1/status` or other GETs.

## Code
`components/<name>/...` files and the main functions.

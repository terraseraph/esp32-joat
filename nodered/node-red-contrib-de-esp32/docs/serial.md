# Serial (Node-RED)

Firmware: [docs/features/serial.md](../../../docs/features/serial.md) · Manager: [manager/docs/serial.md](../../../manager/docs/serial.md)

## What Node-RED does with it
Not used by Node-RED. The palette talks to devices over HTTP, WebSocket and MQTT only (`nodes/de-esp32-device.js`, `lib/http.js`). It never sends `serial.hello` or `serial.bye`.

## Node settings
None.

## Messages
None. The NDJSON session lines have the same `{topic,data}` shape as WS/MQTT frames, so `lib/io.js` `parseIoMessage` would parse them.

## Commands sent / events used
`io.hydrate` is sent by `de-esp32-device` on WS open / MQTT subscribe; over those transports it does not start the UART session.

## Code
None.

## Gaps
- No serial transport. Support would need a serial port dependency, a `serialPort` property on `de-esp32-device`, `hello` (or `{"cmd":"serial.hello"}`) on open, `bye` on close, line splitting on `\n`, routing `{"topic":"io/..."}` lines to `_dispatchIo` and `{"v":1,"ok":..}` lines to pending commands (there is no `corr` echo unless the command sends one), and handling the `session` timeout line by sending `hello` again.

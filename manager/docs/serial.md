# Serial (Manager)

Firmware: [docs/features/serial.md](../../docs/features/serial.md) · Node-RED: [nodered/.../docs/serial.md](../../nodered/node-red-contrib-de-esp32/docs/serial.md)

## What the Manager does with it
Not used by the Manager. It reaches devices over HTTP and the device WebSocket only, and never sends `serial.hello` or `serial.bye`. Its own `io.hydrate` (`server/src/device/link.ts`, `corr: "mgr-hydrate"`) goes over WebSocket and does not start the UART session.

## UI fields
None. `sinks.serial` from `GET /api/v1/status` is typed but not shown.

## Server side
Types only, in `server/src/types/device-api.ts`:

| Type | Fields | Firmware |
|---|---|---|
| `SerialHelloCommand` / `SerialByeCommand` | `cmd` | same |
| `SerialHelloResult` | `id, name, topic_id, hostname, fw` | `v, id, name, topic_id, host, fw, heap` |
| `CommandResultMap["serial.bye"]` | `{session:false}` | same |
| `DeviceSinks.serial` | `number \| boolean` | bool |

`SerialHelloResult.hostname` is wrong: the firmware key is `host`. `v` and `heap` are missing.

## Fake device
`server/fake/commands.ts` `handleSerialHello` sets `state.serialSession = true` and returns `{id, name, topic_id, hostname, fw}` (same wrong `hostname` key, no `v`/`heap`); `handleSerialBye` clears it and returns `{session:false}`. `state.ts` reports `sinks.serial = serialSession`; `fakeDevice.ts` clears it on reboot. There is no UART, no idle timeout and no NDJSON stream.

## Code
`server/src/types/device-api.ts`, `server/fake/commands.ts`, `server/fake/state.ts`, `server/fake/fakeDevice.ts`

## Gaps
- No serial console or serial live view. Not needed for the current Manager flows.
- Fix `SerialHelloResult` (and the fake) to `host`, add `v` and `heap`.

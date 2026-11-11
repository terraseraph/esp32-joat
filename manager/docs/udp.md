# UDP (Manager)

Firmware: [docs/features/udp.md](../../docs/features/udp.md) · Node-RED: [nodered/.../docs/udp.md](../../nodered/node-red-contrib-de-esp32/docs/udp.md)

## What the Manager does with it
Not used by the Manager. Its live view comes from the device WebSocket (`server/src/device/link.ts`) and discovery uses mDNS and an HTTP sweep (`server/src/discovery/`), not the UDP announce.

## UI fields
None.

## Server side
- No route reads `GET /api/v1/udp` or sends `udp.configure`.
- `server/src/types/device-api.ts`: no `UdpConfigureCommand` in `DeviceCommand`, no result type in `CommandResultMap`, `DeviceSinks` has no `udp` field (the firmware sends `sinks.udp` in `GET /api/v1/status`).
- Backups do not include UDP settings (and do not list them in `gaps`).

## Fake device
Not simulated. `udp.configure` is not in `COMMAND_NAMES` (`server/fake/commands.ts`), so the fake answers `unknown cmd`; `GET /api/v1/udp` is not served; `state.ts` `sinks` has no `udp`.

## Code
None (`server/src/types/device-api.ts`, `server/fake/commands.ts`, `server/fake/state.ts` are where it would go).

## Gaps
To support UDP the Manager needs:
- Types: `UdpConfigureCommand {cmd:"udp.configure"; targets?: string[]; enabled?: boolean; announce?: boolean; announce_addr?: string; announce_s?: number}` in `DeviceCommand`; `UdpStatus {enabled, active, targets, sent, failed, oversize, seq, announce, announce_addr, announce_s, announced}` as its result; `DeviceSinks.udp?: boolean`.
- UI (e.g. Network or System tab): up to 2 `ipv4:port` targets, enabled switch, announce switch, announce address, interval 2-60 s, and the counters from `GET /api/v1/udp`.
- Backups: save/restore `targets`, `enabled`, `announce`, `announce_addr`, `announce_s` (plan step `udp.configure`), or list `udp` in `gaps`.
- Discovery (optional): listen on `239.255.77.1:7701` for `{"announce":"de-esp32",id,name,host,ip,fw,http}`.
- Fake: handle `udp.configure` with the firmware validation and error texts, serve `GET/POST /api/v1/udp`, report `sinks.udp`.

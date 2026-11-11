# UDP (Node-RED)

Firmware: [docs/features/udp.md](../../../docs/features/udp.md) · Manager: [manager/docs/udp.md](../../../manager/docs/udp.md)

## What Node-RED does with it
Not used by Node-RED. Live io comes over WebSocket `/api/v1/ws` or MQTT `<root>/<topic_id>/io` (`nodes/de-esp32-device.js`). Discovery uses mDNS, MQTT and HTTP probes (`lib/discover.js`), not the UDP announce.

## Node settings
None.

## Messages
None. A core `udp in` node can receive the datagrams by hand; `lib/io.js` `parseIoMessage` would parse them (it reads `topic` and `data` and ignores `id`/`seq`).

## Commands sent / events used
None. No node sends `udp.configure`.

## Code
None (`lib/io.js`, `lib/discover.js` for reference).

## Gaps
To support UDP:
- Live transport option on `de-esp32-device`: a `udp` mode that binds a `dgram` socket on a port, sends `{"cmd":"udp.configure","targets":["<node-red ip>:<port>"]}` on deploy and `{"cmd":"udp.configure","targets":[]}` on close, and routes datagrams to `_dispatchIo` after checking `id` equals the device's `deviceId`.
- Use `seq` to detect lost datagrams (no retry exists on the device); send `io.hydrate` over HTTP when a gap is seen.
- Only 2 target slots exist on the device; the node must not overwrite a slot another client uses (read `GET /api/v1/udp` `targets` first).
- Discovery: listen on `239.255.77.1:7701` (default `announce_addr`) for `{"announce":"de-esp32",id,name,host,ip,fw,http}` in `lib/discover.js`; needs the device's `announce` turned on.

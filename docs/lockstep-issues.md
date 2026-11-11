# Lockstep issues found while writing the feature docs (2026-11-11)

Mismatches between the firmware and Node-RED / the Manager / the Manager's fake device. Each feature doc's **Gaps** section has the detail. Delete lines as they are fixed; delete the file when empty.

## Fix first
- **MQTT password leaks to WebSocket clients.** `mqtt.configure` puts the raw request (password included) on the event bus as `mqtt/reconfigure`, and `web_server` forwards every bus topic to `/api/v1/ws`. ([mqtt](features/mqtt.md))
- **Saved pins can be lost.** All pins share one NVS blob `io/pins`, read into a 2048-byte buffer with no size check on write. Too big → boot applies no pins and the next `pin.configure` starts fresh. ([gpio](features/gpio.md))
- **Manager Pins tab treats touch pins as free.** Owner `touch_N` parses as "none", so the pin shows as `disabled` and can be overwritten. Backups drop touch pins. ([manager/touch](../manager/docs/touch.md))
- **Node-RED over MQTT never sees command errors.** `command()` resolves `{ok:true}` without a reply; nobody reads `{prefix}/events`. ([nodered/mqtt](../nodered/node-red-contrib-de-esp32/docs/mqtt.md))

## Manager vs firmware
- Add-on settings: the catalog sends `def` and choice values as strings, saved settings as numbers; `addonLogic.ts` compares with `===`. A new BME280 fails validation, Edit fails on `addr` / `osrs_*` / `filter`, and the I2C address clash check never fires.
- Editing the only add-on on a bus fails ("GPIO 18 is in use (bus_vspi)"): the bus pins are owned by `bus_*`, not `mod_<id>`.
- Editing a disabled add-on enables it (`enabled` isn't sent; the firmware treats missing as true).
- RFID CS pin isn't pre-filled: the firmware role is `cs`, the bus pin is named `ss`.
- `delivery` is missing from the module types, the UI and backups.
- The rule editor offers `out` pins as sources; the firmware only evaluates rules on `in` / `adc` / `touch`.
- Servo pins: the UI, Node-RED and the fake refuse a mode change; the firmware allows it.
- Servo `max_us <= min_us`: the firmware resets both to 500/2500; the Manager keeps showing what it sent.
- `MqttStatus.backlog` / `backlogs` types are swapped (bool vs count). `DeviceSinks` has no `udp`; `sinks.rules` is a bool, not a count. The `sinks` field is never shown.
- The OTA image check accepts files from 288 bytes; the device needs at least 32768.
- `serial.hello` reply: the firmware sends `host`, `v`, `heap`; `SerialHelloResult` has `hostname`.
- `network.wifi.set` reply `mdns` is the hostname string (typed `unknown`).
- RSSI is live; the Manager says "measured when it connected".
- `topic_id` falls back to the MAC id on the firmware but to the hostname in the fake and the UI preview.
- Names: the firmware cuts names to 31 chars, `""` clears the name. The fake errors on long names and the UI blocks empty names, so you can't reset to the default.
- Wording: the factory-reset warning leaves out UDP / OTA state / stats. The rename warning says the mDNS name changes (only the instance name and TXT `name` do). Discover says "Setting up its Wi-Fi from here is not available yet", but SoftAP setup exists.
- Static IP and Wi-Fi move need firmware from the unmerged branch `claude/wifi-change-fallback-ab5ac7` (`network.ip.*`, `wifi_change`).

## Fake device (`manager/server/fake/`) vs firmware
- MFRC522 catalog: role `ss` not `cs`, pin order differs, has `poll_ms` / `rx_gain` settings the device doesn't.
- BME280 catalog: `sample_ms` range is 100-60000 (device: 200-10000), and oversampling / filter use index values (device: 1, 2, 4, 8, 16 and 0, 2, 4, 8, 16). A fake-made backup is refused by real hardware.
- Rules: fires on every event (the device fires on change), doesn't check a new rule on save, requires `op` / else fields, different error texts.
- Pins: made-up error strings; allows pull-ups on 34-39; no 8-channel PWM / servo limit; no 500/2500 reset; emits input events with `irq` off; ADC threshold measured from the last reading, not the last value sent; deleting a pin removes it (the device keeps a disabled entry); rejects `mode: "touch"`.
- OTA: accepts images from 288 bytes, no chip-id check, `busy` ignores `rebooting`, `ota.apply` refuses `pending_verify` up front.
- MQTT root cleaning doesn't collapse repeated `/` or trim leading and trailing `/`.
- Out-of-range int module settings are clamped (the device refuses them).

## Node-RED vs firmware
- `module.add` never sends `settings`: a BME280 is always 0x76, so a second one on the bus fails.
- The editor draws a CS row for BME280; a click adds `pins.cs`, which the firmware drops, so the next deploy sees "pins differ".
- Pull-up on GPIO 34-39: hiding the row doesn't clear `pullUp`.
- `fingerprint.summarize` reads `status.board`, which doesn't exist (the board is only in mDNS TXT and `/hardware`). The Manager shares this code.
- No fallback when all 4 device WebSocket slots are taken (the 5th client gets no events). The Manager polls `/pins` instead.
- Renames from elsewhere aren't followed (`identity/rename` is ignored).
- No touch support; picking a touch pin with "configure" on turns it into `in`.

## Firmware quirks (documented, not mismatches)
- Nothing stops you configuring GPIO 2 as an output, and the status LED task rewrites it every 100 ms.
- A PWM frequency change affects every PWM pin, but the other pins' state keeps the old `hz`. A failed LEDC setup leaks its channel and pin claim.
- Debounce reads the level at the first edge, so a bounce that settles differently isn't reported until the next edge.
- With no ADC calibration, `mv` holds raw counts.
- After a failed `network.wifi.set` the board keeps trying the failed SSID until reboot.
- `mqtt.enabled` can only be turned off by factory reset. MQTT payloads over 511 bytes are dropped silently.
- `serial.hello` over HTTP / WS / MQTT also starts the UART stream. In `udp.configure`, leaving out `enabled` turns the stream back on.
- Safe mode survives software reboot and factory reset; only a power cycle clears it.

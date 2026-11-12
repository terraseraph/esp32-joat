# Touch (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/touch.md) · [Manager](../../manager/docs/touch.md) · [Hardware](../../hardware/docs/touch.md)

## What it does
Turns a touch-capable GPIO into a capacitive touch input. A bare wire, copper tape or a PCB pad is enough. The pin reports `level` 1 while touched and 0 when released, like a digital input.

## How it works on the ESP
- Driver: legacy `driver/touch_pad.h` (classic ESP32). It starts on the first touch pin (`touch_pad_init`, voltage 2.7 V / 0.5 V / 1 V atten, IIR filter period 10 ms). Boards with no touch pin never start it.
- Allowed pins (from `capability_manager.cpp`). Touch sensing has its own hardware, so ADC2 pins work with Wi-Fi on.

| Channel | T0 | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 |
|---|---|---|---|---|---|---|---|---|---|---|
| GPIO | 4 | 0 | 2 | 15 | 13 | 12 | 14 | 27 | 33 | 32 |

  GPIO 0, 2, 12 and 15 are strapping pins (see `/api/v1/hardware` notes).
- The pin is claimed in resource_manager with owner `touch_<gpio>`.
- Baseline: on configure the firmware waits 60 ms, then averages 8 filtered reads 10 ms apart. Keep fingers off while applying. The baseline is measured again on every boot.
- Detection (a touch lowers the reading):
  - touched when `raw < baseline × (100 − threshold_pct) / 100`
  - released when `raw > baseline × (100 − threshold_pct/2) / 100` (hysteresis)
- Drift: while untouched the baseline moves toward `raw`, 1/8 of the gap per sample upward and 1/256 downward, so a slow approach is not learned as the new baseline.
- One FreeRTOS task `touch` (stack 3072, prio 4) samples each pad every `sample_ms`. It wakes at the smallest `sample_ms` in use, or every 250 ms when no pad is set. A read of 0 or an error is skipped.
- Events: every touched/released edge is published. Raw-only updates go out only while some live sink is on (`RuntimeStatus::live_sinks() > 0`: WS viewers, MQTT, serial session, ADC rules, UDP), when `raw` moved at least max(2, baseline/50) counts, at most every 250 ms.
- Delivery class defaults to `reliable` (like `in`), see `io_delivery.hpp`.
- No deep-sleep touch wake-up.

## Settings
`pin.configure` fields for `mode: "touch"` (`command_router.cpp` `apply_one_pin`):

| Field | Type / range | Default | Notes |
|---|---|---|---|
| `gpio` | one of the 10 GPIOs above | required | |
| `mode` | `"touch"` | required | |
| `threshold_pct` | int 5-80 | 30 | Clamped, not rejected. Drop below baseline that counts as a touch. |
| `sample_ms` | int 20-500 | 50 | Clamped. |
| `delivery` | `reliable` \| `latest` | `reliable` | Anything else is an error. |
| `name` | string | none | Stored as sent, not used by io_touch. |

Saved in NVS namespace `io`, key `pins` (JSON blob shared with all pin modes), with the clamped values written back. Applied immediately; replayed at boot by `command_apply_saved_io` (skipped in safe mode). Configuring the GPIO with any other mode releases the pad and clears `touch_<gpio>`.

## Commands
```json
{"cmd":"pin.configure","pin":{"gpio":32,"mode":"touch","threshold_pct":30,"sample_ms":50}}
```
```json
{"v":1,"ok":true,"result":{"gpio":32,"mode":"touch","threshold_pct":30,"sample_ms":50}}
```
Turn it off:
```json
{"cmd":"pin.configure","pin":{"gpio":32,"mode":"disabled"}}
```
Errors (`"ok":false,"error":...`):
- `gpio has no touch channel (T0-T9: GPIO 4, 0, 2, 15, 13, 12, 14, 27, 33, 32)`
- `gpio not present on this SoC`, `gpio reserved for SPI flash`
- `gpio <n> owned by <owner>` (pin held by an add-on or bus)
- `touch pad setup failed: <esp_err>`, `touch pad gave no reading`
- `delivery must be reliable or latest`

`pin.set` does not apply to touch pins.

## Events and state
State key `touch_<gpio>`:
```json
{"id":"touch_32","mode":"touch","gpio":32,"channel":9,"level":1,"raw":540,"baseline":830,"threshold_pct":30,"sample_ms":50}
```
- WebSocket `/api/v1/ws`: `{"topic":"io/touch","data":{...}}`.
- MQTT `<root>/<topic_id>/io`: the same frame.
- Serial session NDJSON and UDP sink: the same frame (see [serial.md](serial.md), [udp.md](udp.md)).
- `GET /api/v1/pins` and `status.io` / `telemetry.io`: `touch_<gpio>` with a fresh reading (`io_touch_refresh`).
- `io.hydrate` re-emits every `touch_*` key as `io/touch`.
- `GET /api/v1/hardware`: `pins[].touch`, `pins[].touch_channel`, `pins[].owner` = `touch_<gpio>`.
- Rules: a touch pin can be a rule source; it compares `level` (see [rules.md](rules.md)).

## Code
- `components/io_touch/src/io_touch.cpp`: `io_touch_init`, `io_touch_configure`, `io_touch_release`, `io_touch_refresh`, `step` (detection and drift), `touch_task`.
- `components/capability_manager/src/capability_manager.cpp`: touch channel table, `capability_allows(.., "touch")`.
- `components/command_router/src/command_router.cpp`: `apply_one_pin` (clamping, persist), `io_emit_snapshot` (`touch_` → `io/touch`).
- `components/web_server/src/web_server.cpp` (`api_pins`), `components/telemetry/src/telemetry.cpp` (refresh before snapshots).
- Embedded UI: `web/source/index.html` offers `touch` mode and a `threshold_pct` field.
- `components/io_touch/io_touch_README.md` still exists and overlaps this doc.

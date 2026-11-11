# ADC (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/adc.md) · [Manager](../../manager/docs/adc.md)

## What it does
Reads analog voltage on ADC1 pins (GPIO 32-39), smooths it, and publishes millivolts only when the value moves past a threshold. ADC2 is refused because Wi-Fi is always on.

## How it works on the ESP
- IDF 5.x oneshot driver on `ADC_UNIT_1`, attenuation `ADC_ATTEN_DB_12` (about 0-3.3 V, less accurate near the rails), `ADC_BITWIDTH_DEFAULT` (12-bit, `raw` 0-4095).
- Calibration: line fitting (`default_vref` 1100) when the chip supports it. Without calibration `mv` carries **raw counts**, not millivolts (warning `ADC calibration unavailable, returning raw`).
- Each sample averages 4 oneshot reads (`kOversample`, not configurable), converts to mV, then applies an EMA: `filt = (smooth * prev + (100 - smooth) * mv) / 100`. `smooth` 0 = no filter. The first sample after configure seeds the filter.
- An `io/adc` event is sent when `|filt - last_sent| >= hysteresis_mv`, or on the first sample. Comparing to the last **sent** value (not the last reading) lets slow drift still report.
- Task `adc_live` (prio 4) samples each pin on its own `sample_ms`, waking at the smallest `sample_ms` of all ADC pins. It samples only while `RuntimeStatus::live_sinks() > 0` (a WS client on `/api/v1/ws`, MQTT connected to a broker, UDP sink on, serial session, or an enabled on-device rule with an ADC source); otherwise it idles in 250 ms steps.
- `io_adc_refresh()` re-reads every ADC pin into the state registry without touching last-sent or sending events. Called by the 15 s telemetry tick, `GET /api/v1/pins` and `io.hydrate`.
- Pin rules (`capability_allows` mode `adc`): pins with ADC2 fail first (`ADC2 cannot be used while Wi-Fi is on`: GPIO 0, 2, 4, 12-15, 25-27), then pins without ADC1 (`gpio has no ADC1 channel`). Allowed: 32 (CH4), 33 (CH5), 34 (CH6), 35 (CH7), 36 (CH0), 37 (CH1), 38 (CH2), 39 (CH3). 37/38 are often not routed.
- Claimed in `resource_manager` as `adc_N`.

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `gpio` | int | required | ADC1 pin. |
| `mode` | `adc` | | |
| `sample_ms` | int 20-1000 (clamped) | 50 | Per-pin sample period. |
| `hysteresis_mv` | int 5-500 (clamped) | 20 | Minimum move vs last sent value. |
| `smooth` | int 0-90 (clamped) | 70 | Percent weight of the previous filtered value. |
| `delivery` | `reliable` \| `latest` | `latest` | MQTT backpressure class. |

Clamped values are written back into the pin object before it is saved and echoed. Saved in NVS namespace `io`, key `pins` ([gpio.md](gpio.md#settings)). Applied immediately and at boot (skipped in safe mode).

## Commands
```json
{"cmd":"pin.configure","pin":{"gpio":34,"mode":"adc","sample_ms":50,"hysteresis_mv":20,"smooth":70}}
```
Reply: the pin with clamped `sample_ms`, `hysteresis_mv`, `smooth`. There is no read command; the value comes from events or `GET /api/v1/pins`.

Errors: capability errors above; `gpio N owned by <owner>`; `adc_oneshot_config_channel` errors as `esp_err` names.

## Events and state
State key `adc_N`, topic `io/adc`:
```json
{"id":"adc_34","mode":"adc","gpio":34,"mv":1650,"raw":2048,"sample_ms":50,"hysteresis_mv":20,"smooth":70}
```
`mv` is the filtered value; `raw` is the 4-read average of the latest sample, unfiltered. Delivered like every io event: WS `/api/v1/ws` frame `{"topic":"io/adc","data":{...}}`, MQTT `{root}/{topic_id}/io` (QoS 0 / dropped under backlog by default, `latest`), serial session, UDP sink; in `GET /api/v1/pins` and `status.io`; owner `adc_N` in `GET /api/v1/hardware`. On-device rules can use an ADC pin as source (`io_rules`, compares `mv`).

## Code
- `components/io_adc/src/io_adc.cpp`: `io_adc_init`, `io_adc_configure`, `sample`, `live_task`, `io_adc_refresh`, `io_adc_release`.
- `components/capability_manager/src/capability_manager.cpp`: ADC1/ADC2 flags and channel numbers.
- `components/command_router/src/command_router.cpp`: `apply_one_pin` (`adc` branch), `io_emit_snapshot`.
- `components/telemetry/src/telemetry.cpp`: 15 s refresh.
- Hardware check: pot on GPIO 34. With defaults, MQTT `.../io` should not chatter every sample but should follow the pot. `smooth` 0 with a low threshold chatters on Wi-Fi noise.

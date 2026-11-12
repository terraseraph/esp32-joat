# ADC (Node-RED)

Firmware: [docs/features/adc.md](../../../docs/features/adc.md) · Manager: [manager/docs/adc.md](../../../manager/docs/adc.md) · Hardware: [hardware/docs/adc.md](../../../hardware/docs/adc.md)

## What Node-RED does with it
`gpio in` with Mode `ADC` configures an ADC1 pin on deploy and outputs millivolts on each `io/adc` event. Transport is as in [gpio.md](gpio.md#commands-sent--events-used).

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| gpio in | `gpio` | `gpio` | Pads need `adc1` (`lib/pins.js` `padAllowed`); ADC2 pads are not selectable. |
| gpio in | `pinMode` = `adc` | `mode` | |
| gpio in | `pinName` | `name` | Default `gpio_<N>`; saved by the firmware, otherwise unused. |
| gpio in | `sampleMs` | `sample_ms` | Default 50; editor 20-1000. |
| gpio in | `hysteresisMv` | `hysteresis_mv` | Default 20; editor 5-500 ("Threshold (mV)"). |
| gpio in | `smooth` | `smooth` | Default 70; editor 0-90. |
| gpio in | `source`, `configure` | - | As in [gpio.md](gpio.md#node-settings). |

Values are sent as entered (non-numbers fall back to the defaults); the firmware clamps.

## Messages
Output on every `io/adc` event for its GPIO:
```json
{"payload":1650,"gpio":34,"mode":"adc","topic":"adc_34","data":{"id":"adc_34","mode":"adc","gpio":34,"mv":1650,"raw":2048,"sample_ms":50,"hysteresis_mv":20,"smooth":70}}
```
`payload` is `data.mv` (`lib/io.js` `parseIoMessage`). No input.

## Commands sent / events used
| When | Command |
|---|---|
| Deploy (`configure`) | `{"cmd":"pin.configure","pin":{"gpio":34,"mode":"adc","name":"gpio_34","sample_ms":50,"hysteresis_mv":20,"smooth":70}}` |
| Live link opens | `{"cmd":"io.hydrate"}` |

Listens to `io/adc` on MQTT `{prefix}/io` or WebSocket `/api/v1/ws`. The firmware samples only while it has a live sink (`live_sinks`): the node's WebSocket counts as one; on MQTT the device counts as live whenever it is connected to the broker.

## Code
- `nodes/de-esp32-gpio-in.js` (`pinBody`, `onEv`), `nodes/de-esp32-gpio-in.html` (`#de-esp32-row-adc`)
- `lib/io.js`, `lib/pins.js`

## Gaps
- `raw` is only in `msg.data`; no option to output it.
- No `delivery`.
- When the device has no ADC calibration, `mv` is raw counts; the node cannot tell.

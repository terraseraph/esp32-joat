# GPIO (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/gpio.md) · [Manager](../../manager/docs/gpio.md) · [Hardware](../../hardware/docs/gpio.md)

## What it does
Digital input and output on single pins, with optional invert, internal pull-up/pull-down, any-edge interrupts and software debounce for inputs. `capability_manager` decides which pins may be used for which mode before any hardware is touched.

## How it works on the ESP
- `out` pins are set to `GPIO_MODE_INPUT_OUTPUT` (so the level can be read back); `in` pins to `GPIO_MODE_INPUT`. Pulls go straight to `gpio_config` (`pull_up_en` / `pull_down_en`), for both modes.
- `invert` flips the logical level: `level` in commands and events is logical, the pad is `!level` when inverted.
- Interrupts: `in` pins with `irq` (default true) use `GPIO_INTR_ANYEDGE`. The ISR only queues the GPIO number (queue of 16). Task `gpio_irq` (prio 10) does the rest.
- Debounce (inputs only): after an accepted edge, further edges are ignored for `debounce_ms`. The level is read at the accepted edge and published only if it differs from the last published level. If bouncing ends on a different level inside the window, that is not reported until the next edge.
- `out` pins have no debounce; every `pin.set` publishes.
- Inputs with `irq:false` never update their stored state after configure (nothing polls them).
- Boot: `io_gpio_safe_defaults()` drives nothing. Outputs are only driven when the saved config is applied (`command_apply_saved_io`), which is skipped in safe mode.
- Each pin is claimed in `resource_manager` as `gpio_N`. Configuring a pin first releases any `gpio_/pwm_/adc_/touch_/servo_` use of that pin, so a mode change never needs a separate "off".

### Which pins are allowed (`capability_allows`)
Classic ESP32 table in `capability_manager.cpp`. Checks run in this order:

| Check | Error |
|---|---|
| GPIO not in the table (20, 24, 28-31, >= 40) | `gpio not present on this SoC` |
| GPIO 6-11 (SPI flash), any mode incl. `disabled` | `gpio reserved for SPI flash` |
| `out`/`pwm`/`servo` on GPIO 34-39 | `gpio is input-only` |
| `pwm`/`servo` on a pin without `PIN_PWM` | `gpio not suitable for PWM` (every output-capable pin has it) |
| `in` on a pin without input | `gpio cannot input` |
| `adc` on an ADC2 pin | `ADC2 cannot be used while Wi-Fi is on` |
| `adc` on a pin without ADC1 | `gpio has no ADC1 channel` |
| unknown mode | `unknown mode` |

Extra check in `io_gpio_configure`: `in` with `pull_up`/`pull_down` on an input-only pin (34-39) fails with `input-only pins have no internal pull`.

Pins that are allowed but special:

| GPIO | Note |
|---|---|
| 0 | BOOT button. `boot_button_task` (`main/app_main.cpp`) configures it as input with pull-up and watches it for recovery; low at reset enters download mode. |
| 2 | Status LED on DevKitC. `status_led_task` writes the board's status LED pin every 100 ms, so a user output there is overwritten. Not claimed in `resource_manager`. |
| 1, 3 | UART0 TX/RX (serial console). |
| 5, 12, 15 | Strapping. GPIO 12 high at reset can select 1.8 V flash and prevent boot. |
| 37, 38 | Often not routed on WROOM modules. |

## Settings
`pin.configure` fields for `out` / `in`:

| Field | Type / range | Default | Notes |
|---|---|---|---|
| `gpio` | int | required | |
| `mode` | `out` \| `in` \| `disabled` | `disabled` | |
| `invert` | bool | false | Must be a JSON bool; numbers are ignored. |
| `pull_up` | bool | false | Rejected on 34-39 for `in`. |
| `pull_down` | bool | false | Same. |
| `boot` | int 0/1 | 0 | `out` only. Level written on configure and at boot. Must be a number. |
| `irq` | bool | `true` for `in` | Ignored for `out`. |
| `debounce_ms` | int 0-500 (clamped) | 50 | `in` only; removed from the saved object for `out`. |
| `delivery` | `reliable` \| `latest` | `reliable` for `in`, `latest` for `out` | MQTT backpressure class (`io_delivery.hpp`). Other values: `delivery must be reliable or latest`. |

Saved in NVS namespace `io`, key `pins` (blob `{"v":1,"pins":[...]}`): the pin object is stored as sent (extra keys such as `name`, or `cmd` when fields are top-level, are kept), after clamping `debounce_ms`. `disabled` is stored as an entry too. Applied immediately, and again at every boot. The blob is read into a 2048-byte buffer and `persist_pin` does not check the size: past 2048 bytes the read fails, boot applies no pins and the next `pin.configure` starts a fresh list. A failed NVS write is not reported to the caller.

## Commands
```json
{"cmd":"pin.configure","pin":{"gpio":4,"mode":"out","boot":0,"invert":false}}
{"cmd":"pin.configure","pin":{"gpio":27,"mode":"in","pull_up":true,"debounce_ms":30}}
```
Pin fields may also sit at the top level (`pin` missing → the request itself is the pin). `POST /api/v1/pins` without `cmd` is `pin.configure`. Reply: `{"v":1,"ok":true,"result":<pin object as applied>}` (`corr` echoed).

```json
{"cmd":"pin.set","gpio":4,"value":1}
```
`mode` defaults to `out` (any value other than `pwm`/`servo` goes to GPIO). `value` is truthy/falsy (non-zero = 1). Reply `{"result":{"gpio":4,"value":1}}` echoing the request. Not saved: the boot level stays as configured.

Errors: capability errors above; `gpio N owned by <owner>` (claimed by a module or bus); `ESP_ERR_INVALID_STATE` from `pin.set` when the pin is not a configured output.

## Events and state
State key and event payload (`publish_gpio`):
```json
{"id":"gpio_27","mode":"in","gpio":27,"level":1,"debounce_ms":30}
```
`debounce_ms` only for `in`. Published as topic `io/gpio` on configure, on each accepted input edge and on each `pin.set`.

| Where | Shape |
|---|---|
| WebSocket `/api/v1/ws` | `{"topic":"io/gpio","data":{...}}` (only while a WS viewer is connected) |
| MQTT `{root}/{topic_id}/io` | same frame, QoS 1 (QoS 0 / dropped under backlog unless `reliable`) |
| Serial session, UDP sink | same bus event (`serial_session`, `udp_sink`) |
| `GET /api/v1/pins`, `status.io` in `GET /api/v1/status` | state map keyed `gpio_N` |
| `GET /api/v1/hardware` | `pins[]`: capability flags (`input`, `output`, `pull`, `pwm`, `adc1`, `adc2`, `touch`, `dac`, `strap`, `flash`, `input_only`, `status_led`, `boot_btn`, `adc_channel`, `touch_channel`, `role`, `notes`) plus live `owner` |
| `io.hydrate` | re-emits every stored pin state |

On-device rules (`io_rules`) can read `in` pins and drive `out` pins through `io_gpio_set`.

## Code
- `components/io_gpio/src/io_gpio.cpp`: `io_gpio_init`, `io_gpio_configure`, `io_gpio_set`, `io_gpio_get`, `io_gpio_release`, `irq_task`, `publish_gpio`.
- `components/capability_manager/src/capability_manager.cpp`: `capability_init` (pin table), `capability_allows`, `capability_dump`.
- `components/command_router/src/command_router.cpp`: `apply_one_pin`, `persist_pin`, `command_apply_saved_io`, `pin.set` dispatch.
- `components/runtime_core/include/io_delivery.hpp`: delivery classes.
- Test: `test/test_capability_spec.py`.

# potential_modules_README.md

## Purpose

Named backlog for optional hardware addons (`components/mod_*`) that are **not** in the tree yet. I2C bus claim and `bme280` shipped: [mod_bme280_README.md](../../components/mod_bme280/mod_bme280_README.md). The catalog pattern is [module_manager_README.md](../../components/module_manager/module_manager_README.md) + [mod_mfrc522_README.md](../../components/mod_mfrc522/mod_mfrc522_README.md). This file is the plan so we do not invent a generic “I2C gadget” with no chip settings, and so WS281x strips land as one FastLED-shaped type instead of a pile of almost-identical drivers.

Status: **later** for everything below except the I2C infrastructure and BME280 (those are **mvp**).

## User story

Hardware tab: add a BME280 on the default I2C pins, set address and oversampling, see `io/env` on MQTT. Add a WS2812B strip on GPIO 4, set length / color order / brightness, fill it from Node-RED. A second I2C sensor on the same SDA/SCL shares the bus; a second strip on another GPIO is its own instance.

## How addons are supposed to look

Copy MFRC522, not Arduino libraries.

- New type = new `components/mod_*` that calls `module_register_type` from init. `module_manager` must not `REQUIRES` the driver.
- Pin roles live on the vtable so the UI does not hardcode them.
- Shared bus pins (`share: "bus"`) must match the first claimant; instance pins (`cs`, `data`, …) stay unique.
- Native IDF drivers only. No FastLED Arduino, no Adafruit_* .
- Publish on the event bus (`io/<kind>`) the way RFID publishes `io/rfid`. Do not stream a full LED framebuffer every frame.
- Persist in NVS `components.modules`. Chip knobs that are not pins go in a `settings` object on the instance (schema bump when that field is added).

GPIO / PWM / servo / ADC stay `pin.configure` modes. DAC and touch, if they happen, are also pin modes — not modules.

## Build order

1. **I2C bus claim** in [resource_manager_README.md](../../components/resource_manager/resource_manager_README.md) (same shape as SPI). `module_manager` learns `bus_kind: "i2c"`. **Done.**
2. **One specific I2C type** (BME280) so the Hardware tab has real settings, not a raw address poke. **Done.** See [mod_bme280_README.md](../../components/mod_bme280/mod_bme280_README.md).
3. **WS281x strip** (`mod_led_strip`) — RMT, no I2C. Can ship in parallel with further I2C chips.
4. More I2C chips as their own types once the bus lock is boring.
5. Everything in the backlog table stays named, not started.

Bump `kMaxTypes` is done (now **16**). Blob cap is still **2048** bytes — keep instance JSON small.

---

## Base I2C (infrastructure, not a catalog type)

There is **no** user-facing `mod_i2c` that means “talk to whatever at 0x3C”. The Hardware tab cannot know oversampling, shunt milliohms, or whether a register map is BME280 vs SSD1306.

What “base I2C” *is*:

| Piece | Behaviour (mirror SPI) |
|---|---|
| `resource_i2c_host(bus_id)` | `i2c0` (and later `i2c1` if we ever enable it). Classic ESP32: I2C_NUM_0 / I2C_NUM_1. |
| `resource_i2c_claim(bus_id, sda, scl, hz)` | First claim stores SDA/SCL/Hz and takes those GPIOs as `bus_<id>`. Later claims must match **all three**. Refcount. |
| `resource_i2c_release(bus_id)` | Drop refcount; at 0, delete the driver and free the two GPIOs. |
| Default pins | Board profile already documents `i2c0`: SDA **21**, SCL **22**. Any output-capable pair is allowed; flash / input-only rejected. |
| Speed | Default **100 kHz**. Allow **400 kHz** when every device on that bus asked for it (first claim wins; a 100 kHz device must not join a 400 kHz bus — match-or-fail, like SPI pin mismatch). |
| Address | 7-bit. Unique per bus. Stored in instance `settings.addr`, not as a pin role. |
| Scan | Optional later `i2c.scan` command for the Hardware tab. Not required for BME280. |

`ModuleTypeOps` for I2C chips:

- `bus_kind`: `"i2c"`
- `default_bus`: `"i2c0"`
- pins: `sda` / `scl` required, `share: "bus"`, cap `out` (open-drain is the driver’s problem)
- no `cs`; address is settings

Do not implement I2C by bit-banging in each `mod_*`. One IDF `i2c_master` bus, many devices.

UART2 and 1-wire hosts are **not** this slice. RMT lock is the WS281x slice.

---

## I2C device types (specific modules)

Each row is a future `mod_*` with its own pin schema (shared `sda`/`scl`) and **chip settings**. First wave is the ones with distinct knobs people actually wire to a DevKitC.

### First wave

#### `bme280` — Bosch temp / pressure / humidity

**Shipped** as [mod_bme280_README.md](../../components/mod_bme280/mod_bme280_README.md). Kept here so the first-wave list stays one table.

| Setting | Why it is not generic I2C |
|---|---|
| `addr` | `0x76` (SDO low) or `0x77` (SDO high) |
| `sample_ms` | Poll period (default 1000, 200–10000) |
| `osrs_t` / `osrs_p` / `osrs_h` | Oversampling 1–16 (Bosch names) |
| `filter` | IIR 0/2/4/8/16 |
| `mode` | `normal` (default) or `forced` |

Event `io/env`: `{id,type,t_c,p_hpa,rh}`. State key `mod_<id>`. Max 2 instances (two addresses on one bus). IDF: `bme280` component or a small native driver — still no Arduino.

#### `aht20` — cheap temp / humidity

`addr` fixed `0x38`. Settings: `sample_ms` only. Same `io/env` shape (`p_hpa` omitted). Exists so a $2 board is a named type, not a BME280 with the wrong register map.

#### `bh1750` — ambient light

| Setting | Notes |
|---|---|
| `addr` | `0x23` (ADDR low) or `0x5C` (ADDR high) |
| `mode` | `cont_h` (1 lx, default), `cont_h2` (0.5 lx), `cont_l` (4 lx) |
| `sample_ms` | Must respect the chip’s min integration time for that mode |

Event `io/light`: `{id,type,lux}`.

#### `ina219` — bus voltage / current

| Setting | Notes |
|---|---|
| `addr` | `0x40`–`0x4F` (A0/A1 strapping) |
| `shunt_mohm` | Default 100 (the common breakout). Calibration is wrong without this. |
| `max_a` | Expected full-scale current; used to pick PGA |

Event `io/power`: `{id,type,vbus,vshunt_mv,i_ma,p_mw}`.

### Later I2C (named, not first wave)

| Type | Settings that force a real module | Event / role |
|---|---|---|
| `sht30` | `addr` 0x44/0x45, `repeatability` high/med/low | `io/env` |
| `ads1115` | `addr`, `gain`, `rate_sps`, `mux` (single 0–3 or diff) | Extra ADC while ADC2 stays banned |
| `mcp23017` | `addr` 0x20–0x27, per-pin `dir` / `pullup`; then `module.cmd` set/get | GPIO expander — treat banks as child pins, do not overload `pin.configure` |
| `pca9685` | `addr`, `freq_hz` (24–1526, default 50 for servos) | 16 extra PWM/servo channels |
| `ssd1306` | `addr` 0x3C/0x3D, `w`/`h` (128x64 default), `rotate` | Text/tiles only; no framebuffer product |
| `ds3231` | `addr` 0x68 | Time sync; thin |

Skip cameras, 128×160 color LCDs, and anything that wants a frame buffer on this 4 MB / no-PSRAM box.

---

## `mod_led_strip` — WS281x (FastLED-shaped)

One type covering the WS281* family and SK6812 RGBW. People say “FastLED”; we mean that **model** (chipset + color order + brightness + fill/set/effect), implemented with IDF `led_strip` on **RMT**, not the Arduino library.

APA102 / SK9822 are SPI clocked strips — separate type later if ever. This type is data-pin only.

### Pins

| Role | Required | Share | Cap |
|---|---|---|---|
| `data` | yes | instance | out |

One strip per data GPIO. RMT channel claimed in `resource_manager` (new RMT lock — today it does not exist). Classic ESP32: 8 RMT channels; LED strip uses one TX channel each. Cap **4** strips so Wi-Fi still has RMT headroom.

### Settings (this is the FastLED part)

| Setting | Values | Default | Why |
|---|---|---|---|
| `chip` | `ws2811` `ws2812` `ws2812b` `ws2813` `ws2815` `sk6812` | `ws2812b` | Timing + RGB vs RGBW. WS2812 and WS2812B are close; keep both names so the UI matches the reel label. |
| `order` | `rgb` `grb` `brg` `rbg` `gbr` `bgr` plus `rgbw`/`grbw` when `sk6812` | `grb` for WS2812*, `rgbw` for SK6812 | FastLED `GRB` vs `RGB` is the usual “why is everything purple” knob. |
| `count` | 1–300 | 30 | Pixel buffer is `count * (3 or 4)` bytes in DRAM. No PSRAM. 300×3 = 900 B per strip; 4×300 is the RAM ceiling we will not exceed. |
| `hz` |  | chip default | WS2811 is ~400 kHz; WS2812B ~800 kHz; WS2815 is 12V but same 800 kHz class. Prefer chip preset over a free numeric unless we must. |
| `brightness` | 0–255 | 64 | FastLED global brightness. Applied on show, not baked into the buffer, so raising it does not require a redraw from the host. |
| `effect` | `none` `solid` `rainbow` `chase` | `none` | On-device so a strip can run with the UI closed (same idea as `io_rules`). `none` = last `fill`/`set` buffer. |

Do not persist the pixel buffer in NVS. Persist chip/order/count/brightness/effect + solid color if effect is `solid`.

### Commands (`module.cmd`)

Same JSON through `command_router` as everything else.

```json
{"cmd":"module.cmd","id":"led0","op":"fill","r":255,"g":16,"b":0}
{"cmd":"module.cmd","id":"led0","op":"set","i":3,"r":0,"g":0,"b":255}
{"cmd":"module.cmd","id":"led0","op":"brightness","value":128}
{"cmd":"module.cmd","id":"led0","op":"effect","name":"rainbow","speed":20}
{"cmd":"module.cmd","id":"led0","op":"clear"}
```

HSV can wait until RGB is boring (`h` 0–359, `s`/`v` 0–255). Palettes and noise effects are a later slice **inside this type**, not `mod_fastled2`.

`show` is implicit after fill/set/effect tick. Do not require the host to call show.

### Events

`io/led`: `{id,type,chip,count,brightness,effect}` on config change and on effect name change. Not per-pixel. Hydrate from state `mod_<id>`.

### Resource / safety

- `data` must pass `capability_allows(..., out)`. Flash pins and input-only rejected.
- Claim GPIO as `mod_<id>` and one RMT TX channel.
- Level-shift 3.3→5 V is a wiring note in the type `summary`, not firmware.
- WS2813 dual-data fallback is wiring; firmware still drives one `data` pin.

---

## Other pin modes (not `mod_*`)

Already flagged in [capability_manager_README.md](../../components/capability_manager/capability_manager_README.md), still undriven:

| Mode | Pins | Notes |
|---|---|---|
| DAC | GPIO 25/26 | `pin.configure` mode `dac`, 8-bit. |
| Touch | touch-capable pads | Noisy near Wi-Fi; hysteresis required. |

---

## Backlog (named so we do not pretend)

| Kind | Candidate | Blocked on |
|---|---|---|
| 1-wire | `ds18b20` (parasite vs VCC, `sample_ms`) | bitbang / RMT RX, not I2C |
| 1-wire-ish | `dht22` | own timing |
| UART2 | GPS NMEA, MH-Z19, PMS5003, Modbus RTU | UART host lock; never reclaim UART0 |
| SPI | MAX31855, MCP3008 | bus already exists |
| Actuator | stepper (step/dir/en), H-bridge as one instance | pin groups |
| Host | Node-RED PWM / ADC / env / led nodes | [nodered_README.md](nodered_README.md) already marks PWM/ADC later |

Out of scope on this silicon: camera, BLE as a product feature, Matter, I2S audio, WROVER/PSRAM, Arduino FastLED.

---

## Depends on

When implemented: [module_manager_README.md](../../components/module_manager/module_manager_README.md),
[resource_manager_README.md](../../components/resource_manager/resource_manager_README.md),
[capability_manager_README.md](../../components/capability_manager/capability_manager_README.md),
[board_profiles_README.md](../../components/board_profiles/board_profiles_README.md),
[event_bus_README.md](../../components/event_bus/event_bus_README.md),
[state_registry_README.md](../../components/state_registry/state_registry_README.md),
[command_router_README.md](../../components/command_router/command_router_README.md).

## Used by

Nothing yet. Future Hardware tab + Node-RED nodes consume catalog JSON the same way MFRC522 does.

## How to update and maintain

1. Implementing a row means: new `components/mod_*`, its README, a barrel row **mvp**, and shrink or remove that row here.
2. I2C chips stay separate types. If two chips share an event shape (`io/env`), that is the topic, not a merged driver.
3. Extend instance JSON with `settings` once; bump `RUNTIME_CONFIG_SCHEMA`.
4. Add `resource_i2c_*` (and RMT for strips) in the same change as the first driver that needs them — do not land a dead API.
5. Host tests: extend `test/test_module_spec.py` with pin/address/bus-match recipes before hardware.

## How to test

No firmware tests until a type exists. This document is the spec to implement against.

## Known limits

Classic ESP32, 4 MB, no PSRAM, OTA slots 1792 KB. Catalog is compile-in. I2C/UART/RMT locks do not exist today. Max 8 types and 2 KB module blob until those constants move. WS281x `count` cap is a DRAM budget, not a marketing number.

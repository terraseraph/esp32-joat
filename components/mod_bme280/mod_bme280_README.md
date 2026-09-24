# mod_bme280_README.md

## Purpose

Native IDF BME280 I2C environmental sensor. Instances share one I2C master bus; each sensor has its own 7-bit address (`0x76` / `0x77`). Polls temperature, pressure, and humidity and publishes `io/env`.

## User story

Live control: wire a BME280 to SDA 21 / SCL 22, add it from the Hardware tab with address and oversampling, see °C / %RH / hPa on MQTT `{prefix}/io` and the Addons card. A second chip on the same pins uses the other address.

## Public API

`mod_bme280_init()` registers type `bme280` with [module_manager_README.md](../module_manager/module_manager_README.md).

Pin schema: `sda` / `scl` (shared bus). Default bus `i2c0`. Max 2 instances.

Settings (persisted on the instance, not pins):

| Key | Values | Default |
|---|---|---|
| `addr` | 118 (`0x76`) or 119 (`0x77`) | 118 |
| `sample_ms` | 200–10000 | 1000 |
| `osrs_t` / `osrs_p` / `osrs_h` | 1, 2, 4, 8, 16 | 1 |
| `filter` | 0, 2, 4, 8, 16 | 0 |
| `mode` | `normal` / `forced` | `normal` |

State key `mod_<id>`. Event `{id,type,ok,addr,t_c,p_hpa,rh}` on `io/env` when `ok` flips or T/P/RH move (~0.1 °C / 0.5 hPa / 0.5 %RH). Missing chip id `0x60` stays configured (`ok: false`), same idea as a silent RFID reader.

Commands: none beyond catalog add/remove. `module.cmd` returns not-supported. I2C is 100 kHz.

## Depends on

[module_manager_README.md](../module_manager/module_manager_README.md),
[resource_manager_README.md](../resource_manager/resource_manager_README.md) (`resource_i2c_*`),
[event_bus_README.md](../event_bus/event_bus_README.md),
[state_registry_README.md](../state_registry/state_registry_README.md).

## Used by

Boot (`mod_bme280_init` after `module_manager_init`).

## How to update and maintain

Keep Bosch integer compensation in this file. Do not pull Adafruit/Arduino BME280. A second I2C chip type must reuse `resource_i2c_claim` / `add_device`, not open its own master bus.

## How to test

`python test/test_module_spec.py`. Hardware: `module.add` a BME280 on i2c0 addr `0x76`, reboot, `module.list` still shows settings; MQTT `…/io` carries `io/env`. Second sensor: same SDA/SCL, addr `0x77`. `pin.configure` GPIO 21 as out must fail owned-by `bus_i2c0`. Chip id `0x58` (BMP280) logs a warning and stays `ok: false`.

## Known limits

Classic ESP32 I2C0/I2C1 only. Internal pull-ups are weak — use the breakout’s 4.7 kΩ. No BMP280 / BME680 type. Humidity skipped on a miswired chip rather than inventing numbers.

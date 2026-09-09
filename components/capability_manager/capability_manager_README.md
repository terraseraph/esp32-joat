# capability_manager_README.md

## Purpose

Classic ESP32 pin database and `capability_allows(gpio, mode)` so invalid requests fail **before** hardware mutation. Encodes flash pins, strapping, input-only, ADC1 vs ADC2+Wi-Fi.

## User story

Safe pins: the Hardware tab pinout shows why GPIO 12/6–11/34–39 are special. ADC on GPIO 4 is rejected while Wi-Fi is on (ADC2). Click a header pin to `pin.configure`.

## Public API

`capability_init()`, `capability_pin()`, `capability_allows()`, `capability_dump()`.

Dump fields per GPIO: `input`, `output`, `pull`, `pwm`, `adc1`, `adc2`, `touch`, `dac`, `strap`, `flash`, `input_only`, `status_led`, `boot_btn`, `adc_channel`, `touch_channel`, `role`, `notes`. `role` is the default mux label (VSPI MOSI, I2C SDA, UART0 TX, …) — not a live assignment.

REST: `GET /api/v1/hardware` (`pins` array).

## Depends on

None of our components (SoC knowledge only).

## Used by

io_gpio, io_pwm, io_adc, command_router, web_server, [board_profiles_README.md](../board_profiles/board_profiles_README.md) (LED/BOOT numbers).

## How to update and maintain

When adding a board that routes GPIO 37/38, keep the SoC flags and put routing notes in the board profile. Update `test/test_capability_spec.py` in the same change. ADC2 must stay rejected while this firmware always runs Wi-Fi.

## How to test

`python test/test_capability_spec.py`. Hardware: try to configure GPIO 6 as out — API error. GPIO 34 as out — error. GPIO 32 as adc — ok. GPIO 4 as adc — error.

## Known limits

GPIO 1/3 are UART0; allowed by the table but noted. GPIO 37/38 often unbonded on WROOM modules. `role` is documentation (including RFID-style SPI names); firmware still only configures `in`/`out`/`pwm`/`adc`. DAC is flagged, not driven.

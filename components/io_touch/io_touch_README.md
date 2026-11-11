# io_touch_README.md

## Purpose

Capacitive touch input on the ESP32's built-in touch pads (legacy `driver/touch_pad.h`, the only touch driver IDF 5.4 has for the original ESP32). No external parts: a bare wire, copper tape or a PCB pad on the GPIO is enough.

## User story

`pin.configure` with `mode: "touch"` on a touch GPIO: T0–T9 = GPIO 4, 0, 2, 15, 13, 12, 14, 27, 33, 32. Options: `threshold_pct` (default 30, 5–80) and `sample_ms` (default 50, 20–500). State key `touch_<gpio>`, event topic `io/touch`:

```json
{"id":"touch_32","mode":"touch","gpio":32,"channel":9,"level":1,"raw":540,"baseline":830,"threshold_pct":30,"sample_ms":50}
```

`level` 1 = touched. Touch pads share pins with ADC2, but touch sensing has its own hardware, so it works with Wi-Fi on.

## Public API

`io_touch_init`, `io_touch_configure(gpio, threshold_pct, sample_ms, …)`, `io_touch_refresh`, `io_touch_release`.

A touch **lowers** the reading. At configure time the pad's untouched baseline is the average of 8 filtered reads (keep fingers off during Apply). Touched when `raw < baseline × (100 − threshold_pct)%`; released when `raw > baseline × (100 − threshold_pct/2)%` (hysteresis). While untouched the baseline follows drift: up quickly (1/8 per sample), down slowly (1/256), so a slow approach is not learned as the new baseline.

Events: every touched/released edge goes to the bus (delivery defaults to `reliable`, like `in`). While a live viewer is connected, `raw` changes of at least 2 % of baseline are also published, at most every 250 ms, to help tune `threshold_pct`. The touch driver itself only starts when the first pad is configured.

## Depends on

capability (`PIN_TOUCH` + `touch_channel`), resource, state_registry, event_bus, runtime_core (`live_sinks`), `driver`.

## Used by

command_router, telemetry and `/pins` (via `io_touch_refresh`), [rules.md](../../docs/features/rules.md): rules treat touch like `in` (`level` 1/0).

## How to update and maintain

Readings depend on pad size, wire length and the case around it. Tune `threshold_pct` from the live `raw`/`baseline` instead of changing the defaults. Deep-sleep touch wake-up is not wired yet; it would need `esp_sleep_enable_touchpad_wakeup` plus a hardware threshold from `touch_pad_config`.

## How to test

Configure GPIO 32 as touch with a jumper wire on it. `GET /api/v1/pins` should show `touch_32` with `level` 0 and a `baseline` of a few hundred or more. Hold the wire: `level` goes to 1 and an `io/touch` event appears on the WebSocket. Let go: `level` returns to 0.

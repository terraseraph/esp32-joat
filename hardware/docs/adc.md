# Analog in (ADC1) (Hardware)

Firmware: [docs/features/adc.md](../../docs/features/adc.md) · Node-RED: [nodered/.../docs/adc.md](../../nodered/node-red-contrib-de-esp32/docs/adc.md) · Manager: [manager/docs/adc.md](../../manager/docs/adc.md)

## What it needs from the hardware
A GPIO with an ADC1 channel: 32, 33, 34, 35, 36, 37, 38, 39 (37/38 are often not routed on WROOM modules). ADC2 pins are refused because Wi-Fi is on. Input range is about 0-3.3 V (12 dB attenuation).

## Provided today
Nothing yet. No design has an analog input, divider or protection.

## Electrical limits
Do not exceed 3.3 V on the pin. Accuracy is worse near 0 V and 3.3 V. Without calibration the firmware reports raw counts, not millivolts.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. Planned, not designed: per-input power monitoring. The firmware has no feature that reads a monitor chip either. The S3 has a different ADC pin map from the one in the [firmware doc](../../docs/features/adc.md), which describes the classic ESP32.

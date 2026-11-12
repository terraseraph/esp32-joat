# Analog in (ADC1) (Hardware)

Firmware: [docs/features/adc.md](../../docs/features/adc.md) · Node-RED: [nodered/.../docs/adc.md](../../nodered/node-red-contrib-de-esp32/docs/adc.md) · Manager: [manager/docs/adc.md](../../manager/docs/adc.md)

## What it needs from the hardware
A GPIO with an ADC1 channel: 32, 33, 34, 35, 36, 37, 38, 39 (37/38 are often not routed on WROOM modules). ADC2 pins are refused because Wi-Fi is on. Input range is about 0-3.3 V (12 dB attenuation).

## Provided today
Nothing yet. No design has an analog input, divider or protection.

## Electrical limits
Do not exceed 3.3 V on the pin. Accuracy is worse near 0 V and 3.3 V. Without calibration the firmware reports raw counts, not millivolts.

## Gaps
base-s3 (draft) brings no analog inputs out; per-input power monitoring uses INA226 chips over I2C (see [status](status.md)), not the ADC. The S3 has a different ADC pin map from the one in the [firmware doc](../../docs/features/adc.md), which describes the classic ESP32.

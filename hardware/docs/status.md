# Status, telemetry, live events (Hardware)

Firmware: [docs/features/status.md](../../docs/features/status.md) · Node-RED: [nodered/.../docs/status.md](../../nodered/node-red-contrib-de-esp32/docs/status.md) · Manager: [manager/docs/status.md](../../manager/docs/status.md)

## What it needs from the hardware
No hardware dependency of its own. It reports whatever the other features read. The status LED pin is described in [system](system.md).

## Provided today
Not applicable.

## Electrical limits
None.

## Gaps
Planned, not designed: per-input power monitoring would need a telemetry shape in the firmware as well as a circuit. Neither exists.

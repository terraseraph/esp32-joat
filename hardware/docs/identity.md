# Device id and name (Hardware)

Firmware: [docs/features/identity.md](../../docs/features/identity.md) · Node-RED: [nodered/.../docs/identity.md](../../nodered/node-red-contrib-de-esp32/docs/identity.md) · Manager: [manager/docs/identity.md](../../manager/docs/identity.md)

## What it needs from the hardware
No hardware dependency beyond the chip's own MAC address, which the id is derived from.

## Provided today
Not applicable.

## Electrical limits
None.

## Gaps
None. A per-board ID stored on the base board is not part of the identity feature today; the planned auto-detect applies to expansion boards (see [modules](modules.md)).

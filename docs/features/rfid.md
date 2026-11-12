# RFID MFRC522 (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/rfid.md) · [Manager](../../manager/docs/rfid.md) · [Hardware](../../hardware/docs/rfid.md)

Framework (add/remove, NVS, validation): [modules.md](modules.md).

## What it does
Module type `mfrc522`: an RC522 13.56 MHz reader on SPI. It polls for a card and reports its UID when a card arrives or leaves. Several readers share one SPI bus, each with its own chip-select.

## How it works on the ESP
- Native ESP-IDF driver (`spi_master`), no Arduino library. SPI mode 0, 1 MHz, no DMA, `max_transfer_sz` 64.
- Buses: `vspi` (SPI3) or `hspi` (SPI2). The first reader on a bus sets SCK/MISO/MOSI (`resource_spi_claim`); later readers must use the same three pins. MISO pull is set floating after bus init.
- Pins (catalog roles, `kPins`):

| Role | Required | Share | Cap | Owner |
|---|---|---|---|---|
| `sck` | yes | bus | out | `bus_<bus>` |
| `mosi` | yes | bus | out | `bus_<bus>` |
| `miso` | yes | bus | in | `bus_<bus>` |
| `cs` | yes | instance | out | `mod_<id>` |
| `rst` | no | instance | out | `mod_<id>` |

  On RC522 boards the pad labelled SDA is the SPI chip-select. Board default VSPI: SCK 18, MISO 19, MOSI 23, SS 5; HSPI: SCK 14, MISO 12, MOSI 13, SS 15 (`board_profiles.cpp`). GPIO 12 is a boot strap.
- Apply: optional RST pulse (low 2 ms, then high, wait 50 ms), soft reset, timer/ASK/CRC setup, antenna on. Reads `VersionReg` (0x37) and `TxControlReg`. `0x00`/`0xFF` logs "chip not answering"; the instance still stays configured.
- One poll task (`rfid_poll`, 3072 bytes stack, prio 5) for all readers, every 150 ms (`kPollMs`). Per reader: antenna off/on, REQA then WUPA, ISO 14443 anticollision/select up to 3 cascade levels (4, 7 or 10-byte UID).
- State is published only when `present` or `uid` changes.
- Limits: max 4 readers (`kMax`); no IRQ pin; no card crypto/auth, no read/write of card memory.

## Settings
No settings (`settings` is null in `kOps`). Instance fields: `id` (prefix `rfid`), `bus` (default `vspi`), `pins`, `enabled`, `delivery` (default `reliable`). Saved in NVS `components`/`modules` like every module ([modules.md](modules.md)).

## Commands
Only the generic module commands:

```json
{"cmd":"module.add","type":"mfrc522","id":"rfid0","bus":"vspi","pins":{"sck":18,"miso":19,"mosi":23,"cs":5,"rst":4}}
```
```json
{"cmd":"module.cmd","id":"rfid0"}
```
→ `{"v":1,"ok":false,"error":"module has no commands"}`.

Driver errors from apply: `mfrc522 id and cs required`, `mfrc522 already applied`, `mfrc522 limited to 4 instances`, `unknown spi bus`, `spi_bus_initialize <err>`, `spi_bus_add_device <err>`, plus resource errors (`spi <bus> pins must match ...`, GPIO owned by another owner).

## Events and state
State key `mod_<id>`, event bus topic `io/rfid`:

```json
{"topic":"io/rfid","data":{"id":"rfid0","type":"mfrc522","present":true,"uid":"04A1B2C3","version":146,"tx":131}}
```

| Field | Notes |
|---|---|
| `present` | card in the field |
| `uid` | uppercase hex, no separators, up to 20 chars; `""` when no card |
| `version` | `VersionReg` value read at apply; 0 or 255 = chip not answering (wiring) |
| `tx` | `TxControlReg` at apply; low two bits 0b11 = antenna on |

Seen on WS `/api/v1/ws`, MQTT `{root}/{topic_id}/io`, `GET /api/v1/pins`, `module.list` `state`, `io.hydrate`. Delivery class `reliable` by default (never downgraded to QoS 0 under backlog).

## Code
- `components/mod_mfrc522/src/mod_mfrc522.cpp` — `kPins`, `kOps`, `apply`, `teardown`, `pcd_init`, `poll_task`, `poll_one`, `picc_reqa`, `picc_uid`, `publish`.
- `components/mod_mfrc522/include/mod_mfrc522.hpp` — `mod_mfrc522_init()`.
- Test by hand: wire SCK 18 / MISO 19 / MOSI 23 / SS 5, `module.add`, present a card, watch `io/rfid` on the WS. `pin.configure` on GPIO 18 must then fail as owned by `bus_vspi`.

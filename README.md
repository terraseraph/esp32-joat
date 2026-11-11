# de-esp32 — managed device runtime

Native **ESP-IDF 5.4.2** firmware for classic ESP32 (WROOM-32 DevKitC, 4 MB, no PSRAM). Flash once, then configure GPIO/PWM/ADC1, hobby servos, optional RFID (MFRC522) and BME280, Wi-Fi, and MQTT from a local UI. **Not Arduino.**

How firmware, flasher, Node-RED and Manager fit together (start here): **[docs/HOW-IT-FITS.md](docs/HOW-IT-FITS.md)**. Before pushing: `node tools/precheck.mjs`.

Feature index: [docs/FEATURES_README.md](docs/FEATURES_README.md)

## Hardware baseline

- ESP32-WROOM-32 DevKitC, 4 MB flash, no PSRAM
- Status LED GPIO2, BOOT GPIO0 (hold **after** boot for recovery; hold during reset = download mode)

## Build / flash

See [docs/dev/toolchain.md](docs/dev/toolchain.md).

```powershell
. .\tools\env.ps1        # finds ESP-IDF 5.4 (C:\esp, D:\esp, ~\esp, C:\Espressif, or $env:IDF_PATH)
idf.py set-target esp32  # first time only
idf.py build             # output in .\build, same as CI
idf.py -p COMx flash monitor
```

Every pull request is built in Espressif's ESP-IDF 5.4.2 image by [.github/workflows/build.yml](.github/workflows/build.yml), so a green check means it builds on a clean machine.

Or pick a COM port interactively (optional device name):

```powershell
.\tools\flash.ps1
.\tools\flash.ps1 -Port COM3 -Name kitchen-relay
```

Once the board is on Wi-Fi, find it and OTA without USB:

```powershell
.\tools\discover.cmd
.\tools\ota_push.cmd
.\tools\ota_push.cmd --name kitchen-relay
```

On first boot join SoftAP `esp32-<last6>` (open, no password). The phone should show **Sign in to network** and open the portal; otherwise go to `http://192.168.4.1`. Set an AP password from the Network tab if you want; factory reset makes it open again.

Node-RED (same LAN as a provisioned board): see [nodered/node-red-contrib-de-esp32/README.md](nodered/node-red-contrib-de-esp32/README.md).

Browser install (Chrome or Edge, USB serial): see [install/README.md](install/README.md).

## Host test (no hardware)

```powershell
python test/test_capability_spec.py
python test/test_module_spec.py
python test/test_rule_spec.py
```

## Layout

- `main/` — boot orchestrator
- `components/` — one IDF component per feature; feature docs in `docs/features/`, internal components keep `<name>_README.md` beside the code
- `web/dist/index.html` — embedded UI
- `nodered/node-red-contrib-de-esp32/` — Node-RED palette (not part of the IDF build)
- `install/` — browser flash page (Web Serial; stage bins with `tools/stage_web_flash.ps1`)
- `partitions.csv` — A/B OTA slots; apply from the System tab or `ota.apply`

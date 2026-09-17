# de-esp32 — managed device runtime

Native **ESP-IDF 5.4.2** firmware for classic ESP32 (WROOM-32 DevKitC, 4 MB, no PSRAM). Flash once, then configure GPIO/PWM/ADC1, hobby servos, optional RFID (MFRC522), Wi-Fi, and MQTT from a local UI. **Not Arduino.**

Feature index (start here): **[docs/FEATURES_README.md](docs/FEATURES_README.md)**

## Hardware baseline

- ESP32-WROOM-32 DevKitC, 4 MB flash, no PSRAM
- Status LED GPIO2, BOOT GPIO0 (hold **after** boot for recovery; hold during reset = download mode)

## Build / flash

See [docs/features/toolchain_README.md](docs/features/toolchain_README.md).

```powershell
$env:IDF_PATH = "D:\esp\esp-idf"
$env:IDF_TOOLS_PATH = "D:\esp\idf-tools"
. D:\esp\esp-idf\export.ps1
# This workspace is on a mapped UNC share; keep the build tree on local D:.
idf.py -B D:\esp\de-esp32-build set-target esp32
idf.py -B D:\esp\de-esp32-build build
idf.py -B D:\esp\de-esp32-build -p COMx flash monitor
```

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

Node-RED (same LAN as a provisioned board): see [docs/features/nodered_README.md](docs/features/nodered_README.md).

## Host test (no hardware)

```powershell
python test/test_capability_spec.py
python test/test_module_spec.py
python test/test_rule_spec.py
```

## Layout

- `main/` — boot orchestrator
- `components/` — one IDF component per feature (`<name>_README.md` beside the code)
- `web/dist/index.html` — embedded UI
- `nodered/node-red-contrib-de-esp32/` — Node-RED palette (not part of the IDF build)
- `partitions.csv` — A/B OTA slots; apply from the System tab or `ota.apply`

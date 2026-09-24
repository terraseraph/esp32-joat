# de-esp32 browser installer

Static page that flashes a classic ESP32 (DevKitC, 4 MB) from Chrome or Edge, then sets the device name and Wi-Fi over the USB serial console. It is not part of the IDF build.

Web Serial only works on `localhost` or HTTPS. Opening the HTML file directly will not show a port picker.

## Stage firmware

From a normal IDF build (`D:\esp\de-esp32-build` by default):

```powershell
.\tools\stage_web_flash.ps1
.\tools\stage_web_flash.ps1 -BuildDir D:\esp\de-esp32-build
```

That copies `bootloader.bin`, `partition-table.bin`, and `de_esp32_runtime.bin` into `install/firmware/`. Those three images are committed so a GitHub-hosted copy of this folder can flash a board. Re-run the script after a firmware build and commit the new bins. Offsets live in `manifest.json`: bootloader `0x1000`, partition table `0x8000`, app `0x20000` (`ota_0`).

## Serve

```powershell
cd install
python -m http.server 8080
```

Open `http://127.0.0.1:8080/` in Chrome or Edge. Plug in the board, enter a name (31 characters max) and Wi-Fi, then Install. Erase flash is on by default, so a first install wipes NVS and the page writes the name and Wi-Fi afterward. Clear the checkbox to keep an existing config; filled fields are still sent.

Scan talks to a board that is already running this firmware (`network.wifi.scan`). Install sends `identity.set_name` and `network.wifi.set`. A wrong password is not saved.

Hold BOOT during the connect step if the board does not enter download mode on its own.

## Test the log parser

```powershell
node --test install/test/console.test.js
```

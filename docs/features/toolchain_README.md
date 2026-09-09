# toolchain_README.md

## Purpose

Prove and document a native **ESP-IDF 5.4.2** build for classic ESP32. This project is not Arduino and must not use PlatformIO's Arduino-ESP32 or the ancient `framework-espidf@3.2` packages on this machine.

## User story

Flash once: a developer on this PC (or a CI agent) can `idf.py build` and flash a DevKit over USB-UART.

## Public API

None. Environment variables:

- `IDF_PATH` — `D:\esp\esp-idf` (v5.4.2 tag) on this workstation
- `IDF_TOOLS_PATH` — `D:\esp\idf-tools` (keep off the nearly-full C: drive)

Python for IDF: `C:\Users\terra\AppData\Local\Programs\Python\Python39\python.exe` (3.9). Do not use PlatformIO's Python 3.7.

## Depends on

None.

## Used by

Every firmware component. See the [barrel](../FEATURES_README.md).

## How to update and maintain

Pin upgrades are deliberate: change `main/idf_component.yml` (`idf.version`), this README, `runtime_version.hpp` (`RUNTIME_IDF_PINNED`), and re-run `idf.py fullclean`. Do not jump to IDF 6.x without a dedicated spike.

Refresh submodules with the IDF tree, not with random GitHub clones of Arduino-ESP32.

## How to test

```powershell
$env:IDF_PATH = "D:\esp\esp-idf"
$env:IDF_TOOLS_PATH = "D:\esp\idf-tools"
. D:\esp\esp-idf\export.ps1
cd Y:\dev\esp\de-esp32
# Y: is a mapped UNC share; cmd.exe cannot cwd there. Keep the build tree on local D:.
idf.py -B D:\esp\de-esp32-build set-target esp32
idf.py -B D:\esp\de-esp32-build build
```

Host pin-rule spec (no IDF): `python test/test_capability_spec.py`

Proven on this machine (2026-08-27): `idf.py -B D:\esp\de-esp32-build build` produced `de_esp32_runtime.bin` **0xe3d40** bytes (~912 KB) with **49%** free in the 1792 KB OTA slot (ESP-IDF 5.4.2, xtensa-esp-elf 14.2).

## Known limits (this workstation, 2026-08)

- Windows 10 **18363 (1909)**. Official IDF Windows installers often want a newer OS. We cloned IDF to `D:\esp\esp-idf` and install tools to `D:\esp\idf-tools`.
- **C: has ~14 GB free** — do not install Espressif tools on C:.
- **Git 2.14.1** is old; shallow clone of v5.4.2 worked. Prefer a newer Git if submodules fail.
- **WSL is version 1** with Ubuntu Python 3.6. It is **not** a viable IDF 5.4 environment. Do not use WSL1 for this project unless the distro is upgraded to Python 3.10+ and a current IDF.
- PlatformIO has `framework-arduinoespressif32` and `framework-espidf@3.30202` — **do not** point this repo at those.
- PlatformIO Python 3.7 is on the default PATH and **breaks** `idf_tools.py` (`ssl` import). Always put Python 3.9 first and clear `PYTHONHOME`/`PYTHONPATH`. Use [tools/env.ps1](../../tools/env.ps1).

### Install (already started on this machine)

```powershell
git clone --depth 1 --branch v5.4.2 https://github.com/espressif/esp-idf.git D:\esp\esp-idf
cd D:\esp\esp-idf
git submodule update --init --depth 1 --recursive
$env:IDF_TOOLS_PATH = "D:\esp\idf-tools"
# Python 3.9 first on PATH, then:
.\install.bat esp32
.\export.ps1
```

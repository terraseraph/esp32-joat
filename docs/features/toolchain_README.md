# toolchain_README.md

## Purpose

Prove and document a native **ESP-IDF 5.4.2** build for classic ESP32. This project is not Arduino and must not use PlatformIO's Arduino-ESP32 or the ancient `framework-espidf@3.2` packages on this machine.

## User story

Flash once: a developer on this PC (or a CI agent) can `idf.py build` and flash a DevKit over USB-UART.

## Public API

None. Environment variables (all optional; [tools/env.ps1](../../tools/env.ps1) fills them in):

- `IDF_PATH` — an ESP-IDF **v5.4.2** checkout. If unset, `env.ps1` tries `C:\esp\esp-idf`, `D:\esp\esp-idf`, `~\esp\esp-idf`, then `C:\Espressif\frameworks\esp-idf-v5.4*`.
- `IDF_TOOLS_PATH` — Espressif tools. If unset, `env.ps1` uses an `idf-tools` folder beside `esp-idf`, else IDF's default (`~\.espressif`).

Python: any 3.9–3.12 to run `install.ps1`. `env.ps1` then uses whichever `idf5.4_py*_env` venv the installer created. Do not use PlatformIO's Python 3.7.

Rule: **no machine-specific paths in the repo.** Scripts default to the repo's `build\` (same as CI) and find IDF through `env.ps1`.

## Depends on

None.

## Used by

Every firmware component. See the [barrel](../FEATURES_README.md).

## How to update and maintain

Pin upgrades are deliberate: change `main/idf_component.yml` (`idf.version`), this README, `runtime_version.hpp` (`RUNTIME_IDF_PINNED`), both workflows in `.github/workflows/` (`esp_idf_version`), and re-run `idf.py fullclean`. Do not jump to IDF 6.x without a dedicated spike.

Refresh submodules with the IDF tree, not with random GitHub clones of Arduino-ESP32.

## How to test

```powershell
. .\tools\env.ps1
idf.py set-target esp32   # first time, or after fullclean
idf.py build
```

Host specs (no IDF): `python test/test_capability_spec.py`, `test_module_spec.py`, `test_rule_spec.py`.

The source of truth is CI: [build.yml](../../.github/workflows/build.yml) builds every PR (and non-main push) in Espressif's v5.4.2 image and runs the host specs; [install.yml](../../.github/workflows/install.yml) builds `main` for the browser installer. A green PR check means it builds on a clean machine, not just yours.

If the repo lives on a UNC/network share, `cmd.exe` cannot cwd there during compile/link: build to a local folder with `idf.py -B C:\some\local\build build` and pass `-BuildDir` / `--bin` to the tools.

## Set up a new Windows machine

Tested on Windows 11, 2026-11-10 (Python 3.12.10, Git 2.55):

```powershell
winget install -e --id Python.Python.3.12 --scope user
git clone --depth 1 --branch v5.4.2 --recurse-submodules --shallow-submodules https://github.com/espressif/esp-idf.git C:\esp\esp-idf
$env:IDF_TOOLS_PATH = "C:\esp\idf-tools"
& C:\esp\esp-idf\install.ps1 esp32
```

Open a new terminal, then `. .\tools\env.ps1` from the repo. Any drive works: put `esp-idf` and `idf-tools` side by side under one folder, or set `IDF_PATH` / `IDF_TOOLS_PATH` yourself.

USB-UART: Windows 11 normally installs CP210x / CH340 drivers itself. If no new COM port appears when the DevKitC is plugged in, install the Silicon Labs CP210x or WCH CH340 driver.

## Known pitfalls

- PlatformIO's `framework-arduinoespressif32` and `framework-espidf@3.x` — **do not** point this repo at those.
- PlatformIO or Cursor may inject `PYTHONHOME`/`PYTHONPATH` (Python 3.7); that breaks `idf_tools.py` and the IDF venv. `env.ps1` and the `.cmd` wrappers clear both.
- The bare `python` on a fresh Windows box is the Microsoft Store alias, not a real interpreter. Install Python first.
- WSL1 with an old distro Python is not a viable IDF 5.4 environment.

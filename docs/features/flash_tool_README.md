# flash_tool_README.md

## Purpose

Windows helper that lists USB serial (COM) ports, flashes the native IDF image from the local `D:` build tree, and optionally writes the human device name into NVS over UART.

## User story

Flash once: pick the board from a COM list, give it a name like `kitchen-relay`, and see that name on the Overview page after boot.

## Public API

```powershell
.\tools\flash.ps1
.\tools\flash.ps1 -Port COM3 -Name kitchen-relay
.\tools\flash.ps1 -Build -Monitor
.\tools\flash.cmd
```

Parameters: `-Port`, `-Name`, `-Build`, `-Monitor`, `-NoNamePrompt`, `-BuildDir` (default `D:\esp\de-esp32-build`).

State file `tools/flash_state.json` remembers last port and name (not committed).

UART after flash: console `name <string>` then `reboot`. Max 31 characters. Identity (`device_id` / MAC) is unchanged.

## Depends on

[toolchain_README.md](toolchain_README.md),
[boot_state_machine_README.md](boot_state_machine_README.md) (console `name`),
[device_identity_README.md](../../components/device_identity/device_identity_README.md),
[tools/env.ps1](../../tools/env.ps1).

## Used by

Developers flashing DevKitC boards on Windows.

## How to update and maintain

Keep `-B` on a **local** NTFS path (`D:\esp\de-esp32-build`). The repo on `Y:` is a UNC share; `cmd.exe` cannot cwd there during compile/link.

COM listing uses `Win32_PnPEntity` names matching `(COMx)` so CH340/CP210x show up (plain `Win32_SerialPort` often misses USB-UART). If a new adapter family should be tagged `[likely ESP]`, add a keyword to the regex in `flash.ps1`.

The `name` console command must stay in `app_main.cpp` for `-Name` to work. Older images: set the name from the UI (`identity.set_name`) instead.

## How to test

1. Plug one DevKit, run `.\tools\flash.ps1` with no args, confirm the list, flash.
2. Run again with `-Name test-bench`, reboot, Overview title / `status` UART line shows `name=test-bench`.
3. Unplug UART: script must error with “No COM ports found”.

## Known limits

Does not put the board into download mode for you — hold BOOT if auto-reset fail. Does not erase NVS unless you factory-reset. Naming requires this firmware on the chip (rebuild after pulling the `name` command).

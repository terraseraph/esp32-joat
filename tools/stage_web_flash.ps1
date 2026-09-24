# Copy the three flash images into install/firmware/ for the browser installer.
# Usage:
#   .\tools\stage_web_flash.ps1
#   .\tools\stage_web_flash.ps1 -BuildDir D:\esp\de-esp32-build

[CmdletBinding()]
param(
    [string]$BuildDir = "D:\esp\de-esp32-build"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $RepoRoot "install\firmware"

$files = @(
    @{ Src = "bootloader\bootloader.bin"; Dst = "bootloader.bin" },
    @{ Src = "partition_table\partition-table.bin"; Dst = "partition-table.bin" },
    @{ Src = "de_esp32_runtime.bin"; Dst = "de_esp32_runtime.bin" }
)

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($f in $files) {
    $src = Join-Path $BuildDir $f.Src
    if (-not (Test-Path $src)) {
        throw "Missing $src. Build with idf.py -B $BuildDir build first."
    }
    Copy-Item $src (Join-Path $Dest $f.Dst) -Force
    Write-Host "staged $($f.Dst)"
}
Write-Host "Firmware is in $Dest. Serve install/ over localhost or HTTPS."

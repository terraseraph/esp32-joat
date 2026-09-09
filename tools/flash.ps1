# Flash de-esp32 firmware from Windows. Enumerates COM ports and can set the device name.
# Usage:
#   .\tools\flash.ps1
#   .\tools\flash.ps1 -Port COM3 -Name kitchen-relay
#   .\tools\flash.ps1 -Build -Monitor
#
# Requires: ESP-IDF 5.4.2 (see tools\env.ps1). Build output lives on local D: because Y: is UNC.

[CmdletBinding()]
param(
    [string]$Port,
    [string]$Name,
    [switch]$Build,
    [switch]$Monitor,
    [switch]$NoNamePrompt,
    [string]$BuildDir = "D:\esp\de-esp32-build"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$StatePath = Join-Path $PSScriptRoot "flash_state.json"
$BinPath = Join-Path $BuildDir "de_esp32_runtime.bin"

function Import-FlashState {
    if (Test-Path $StatePath) {
        try { return Get-Content -Raw $StatePath | ConvertFrom-Json } catch { }
    }
    return [pscustomobject]@{ LastPort = ""; LastName = ""; Labels = @{} }
}

function Save-FlashState($state) {
    $state | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $StatePath
}

function Get-ComDevices {
    $found = @()
    $entities = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '\(COM\d+\)' }
    foreach ($e in $entities) {
        if ($e.Name -match '(COM\d+)') {
            $com = $Matches[1]
            $likely = $e.Name -match 'CP210|CH340|CH910|FTDI|USB.SERIAL|Silicon Labs|USB-SERIAL|Espressif|UART'
            $found += [pscustomobject]@{
                Port        = $com
                Description = $e.Name
                LikelyEsp   = [bool]$likely
            }
        }
    }
    # Fallback: ports that WMI serial APIs see but PnP naming missed
    try {
        $names = [System.IO.Ports.SerialPort]::GetPortNames()
        foreach ($n in $names) {
            if (-not ($found | Where-Object { $_.Port -eq $n })) {
                $found += [pscustomobject]@{
                    Port        = $n
                    Description = $n
                    LikelyEsp   = $false
                }
            }
        }
    } catch { }
    return $found | Sort-Object { if ($_.LikelyEsp) { 0 } else { 1 } }, Port
}

function Select-ComPort($ports, $state) {
    if (-not $ports -or $ports.Count -eq 0) {
        throw "No COM ports found. Plug in the USB-UART (hold BOOT if the board is in a bad state) and retry."
    }
    Write-Host ""
    Write-Host "Serial ports:" -ForegroundColor Cyan
    $i = 1
    foreach ($p in $ports) {
        $mark = ""
        if ($p.LikelyEsp) { $mark = "  [likely ESP]" }
        $saved = ""
        if ($state.Labels) {
            $prop = $state.Labels.PSObject.Properties[$p.Port]
            if ($prop -and $prop.Value) { $saved = "  label=$($prop.Value)" }
        }
        $last = ""
        if ($state.LastPort -eq $p.Port) { $last = "  (last used)" }
        Write-Host ("  [{0}] {1,-6} {2}{3}{4}{5}" -f $i, $p.Port, $p.Description, $mark, $saved, $last)
        $i++
    }
    $default = 1
    if ($state.LastPort) {
        for ($j = 0; $j -lt $ports.Count; $j++) {
            if ($ports[$j].Port -eq $state.LastPort) { $default = $j + 1; break }
        }
    }
    $choice = Read-Host "Choose port number, or type COMx [$default]"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "$default" }
    if ($choice -match '^COM\d+$') { return $choice.ToUpper() }
    $n = 0
    if ([int]::TryParse($choice, [ref]$n) -and $n -ge 1 -and $n -le $ports.Count) {
        return $ports[$n - 1].Port
    }
    throw "Invalid selection: $choice"
}

function Get-IdfPython {
    $candidates = @()
    if ($env:IDF_PYTHON_ENV_PATH) {
        $candidates += (Join-Path $env:IDF_PYTHON_ENV_PATH "Scripts\python.exe")
    }
    if ($env:IDF_TOOLS_PATH) {
        $candidates += (Join-Path $env:IDF_TOOLS_PATH "python_env\idf5.4_py3.9_env\Scripts\python.exe")
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    throw "ESP-IDF venv python not found. Re-run D:\esp\esp-idf\install.bat esp32"
}

function Initialize-Idf {
    $envFile = Join-Path $PSScriptRoot "env.ps1"
    if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
    Write-Host "Loading ESP-IDF environment..." -ForegroundColor Cyan
    . $envFile
    $script:IdfPython = Get-IdfPython
    $script:IdfPy = Join-Path $env:IDF_PATH "tools\idf.py"
    if (-not (Test-Path $script:IdfPy)) { throw "Missing $script:IdfPy" }
    # Windows .py file association often launches PlatformIO 3.7 or system 3.9 (no IDF packages).
    & $script:IdfPython -c "import click"
    if ($LASTEXITCODE -ne 0) {
        throw "IDF venv cannot import click ($script:IdfPython). Clear PYTHONHOME and re-run install.bat."
    }
}

function Set-DeviceNameOverSerial([string]$com, [string]$devName) {
    Write-Host "Setting device name '$devName' on $com ..." -ForegroundColor Cyan
    $sp = $null
    try {
        $sp = New-Object System.IO.Ports.SerialPort $com, 115200, None, 8, one
        $sp.ReadTimeout = 2000
        $sp.WriteTimeout = 2000
        $sp.NewLine = "`n"
        $sp.DtrEnable = $false
        $sp.RtsEnable = $false
        $sp.Open()
        Start-Sleep -Seconds 4
        try { $null = $sp.ReadExisting() } catch { }
        $sp.WriteLine("name $devName")
        Start-Sleep -Milliseconds 400
        $reply = ""
        try { $reply = $sp.ReadExisting() } catch { }
        if ($reply -notmatch 'name=') {
            Write-Host "No name= reply. Firmware may be an older image; set the name from the UI (identity.set_name) after joining the AP." -ForegroundColor Yellow
            Write-Host $reply
            return
        }
        Write-Host $reply.Trim()
        $sp.WriteLine("reboot")
        Start-Sleep -Milliseconds 200
        Write-Host "Name saved in NVS; board rebooting." -ForegroundColor Green
    } finally {
        if ($sp -and $sp.IsOpen) { $sp.Close() }
        if ($sp) { $sp.Dispose() }
    }
}

# --- main ---
Set-Location $RepoRoot
$state = Import-FlashState

if ($Name -and $Name.Length -gt 31) {
    throw "Device name max 31 characters."
}

Initialize-Idf

if ($Build -or -not (Test-Path $BinPath)) {
    if (-not (Test-Path $BinPath)) {
        Write-Host "No firmware at $BinPath - building." -ForegroundColor Yellow
    }
    & $script:IdfPython $script:IdfPy -B $BuildDir build
    if ($LASTEXITCODE -ne 0) { throw "Build failed." }
}

$ports = @(Get-ComDevices)
if ($Port) {
    $com = $Port.ToUpper()
    if ($com -notmatch '^COM\d+$') { throw "Port must look like COM3, got $Port" }
} else {
    $com = Select-ComPort $ports $state
}

if (-not $Name -and -not $NoNamePrompt) {
    $hint = $state.LastName
    $prompt = "Device name (optional, shown in the UI; blank to skip)"
    if ($hint) { $prompt += " [$hint]" }
    $entered = Read-Host $prompt
    if ([string]::IsNullOrWhiteSpace($entered)) {
        if ($hint) {
            $useLast = Read-Host "Reuse last name '$hint'? [y/N]"
            if ($useLast -match '^[yY]') { $Name = $hint }
        }
    } else {
        $Name = $entered.Trim()
    }
}

Write-Host ""
Write-Host "Flash  $BinPath" -ForegroundColor Cyan
Write-Host "Port   $com"
if ($Name) { Write-Host "Name   $Name" }
Write-Host ""

& $script:IdfPython $script:IdfPy -B $BuildDir -p $com flash
if ($LASTEXITCODE -ne 0) { throw "Flash failed." }

$state.LastPort = $com
if ($Name) {
    $state.LastName = $Name
    $labelMap = @{}
    if ($state.Labels) {
        foreach ($prop in $state.Labels.PSObject.Properties) {
            $labelMap[$prop.Name] = $prop.Value
        }
    }
    $labelMap[$com] = $Name
    $state.Labels = [pscustomobject]$labelMap
    Start-Sleep -Seconds 2
    Set-DeviceNameOverSerial $com $Name
}
Save-FlashState $state

Write-Host "Done. Join SoftAP (open) and open http://192.168.4.1" -ForegroundColor Green

if ($Monitor) {
    & $script:IdfPython $script:IdfPy -B $BuildDir -p $com monitor
}

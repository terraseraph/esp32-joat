# Load the ESP-IDF 5.4 environment into this PowerShell session.
#   . .\tools\env.ps1
#   idf.py build            # output goes to .\build, same as CI
#   .\tools\flash.ps1
#
# Finds IDF without machine-specific paths:
#   1. $env:IDF_PATH if it is already set (set it yourself for unusual locations)
#   2. otherwise the first of: C:\esp\esp-idf, D:\esp\esp-idf, ~\esp\esp-idf,
#      C:\Espressif\frameworks\esp-idf-v5.4.* (Espressif's Windows installer)
# IDF_TOOLS_PATH: kept if set, else an idf-tools folder beside esp-idf, else IDF's own default.

function Test-IdfRoot([string]$p) { $p -and (Test-Path (Join-Path $p "tools\idf.py")) }

if (-not (Test-IdfRoot $env:IDF_PATH)) {
    $candidates = @("C:\esp\esp-idf", "D:\esp\esp-idf", (Join-Path $HOME "esp\esp-idf"))
    $candidates += Get-ChildItem "C:\Espressif\frameworks" -Directory -Filter "esp-idf-v5.4*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object FullName
    $env:IDF_PATH = $candidates | Where-Object { Test-IdfRoot $_ } | Select-Object -First 1
    if (-not $env:IDF_PATH) {
        throw "ESP-IDF 5.4 not found. Install it (docs\features\toolchain_README.md) or set `$env:IDF_PATH first."
    }
}

if (-not $env:IDF_TOOLS_PATH) {
    $sibling = Join-Path (Split-Path -Parent $env:IDF_PATH) "idf-tools"
    if (Test-Path $sibling) { $env:IDF_TOOLS_PATH = $sibling }
}
$toolsRoot = if ($env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH } else { Join-Path $HOME ".espressif" }

# PlatformIO (and Cursor) can inject PYTHONHOME/PYTHONPATH; either one breaks the IDF venv.
Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue

# Use whichever IDF 5.4 venv install.ps1 created, whatever Python version built it.
# It goes first on PATH so export.ps1 and idf.py run inside it.
$venv = Get-ChildItem (Join-Path $toolsRoot "python_env") -Directory -Filter "idf5.4_py*_env" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $venv) {
    throw "No IDF 5.4 Python env under $toolsRoot\python_env. Run: & `"$env:IDF_PATH\install.ps1`" esp32"
}
$env:IDF_PYTHON_ENV_PATH = $venv.FullName
$env:PATH = "$($venv.FullName)\Scripts;" + $env:PATH

. (Join-Path $env:IDF_PATH "export.ps1")

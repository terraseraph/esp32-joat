# Source this after IDF install.bat has completed.
$env:IDF_PATH = "D:\esp\esp-idf"
$env:IDF_TOOLS_PATH = "D:\esp\idf-tools"
$env:IDF_PYTHON_ENV_PATH = "D:\esp\idf-tools\python_env\idf5.4_py3.9_env"
# PlatformIO (and Cursor) inject PYTHONHOME=python37; that poisons 3.9 and the IDF venv.
Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
$py = "C:\Users\terra\AppData\Local\Programs\Python\Python39"
$venvScripts = Join-Path $env:IDF_PYTHON_ENV_PATH "Scripts"
$env:PATH = "$venvScripts;$py;$py\Scripts;C:\Program Files\Git\cmd;" + $env:PATH
. "$env:IDF_PATH\export.ps1"

# Usage:
#   . .\tools\env.ps1
#   idf.py -B D:\esp\de-esp32-build build
#   .\tools\flash.ps1

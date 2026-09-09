@echo off
setlocal
set PYTHONHOME=
set PYTHONPATH=
set PY39=%LOCALAPPDATA%\Programs\Python\Python39\python.exe
if exist "%PY39%" (
  "%PY39%" "%~dp0discover.py" %*
) else (
  py -3.9 "%~dp0discover.py" %*
)
exit /b %ERRORLEVEL%

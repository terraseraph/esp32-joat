@echo off
setlocal
set PYTHONHOME=
set PYTHONPATH=
rem Any Python 3.9+ works (stdlib only). Prefer the py launcher; the bare
rem "python" may be the Microsoft Store alias, which only opens the Store.
where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -3 "%~dp0discover.py" %*
) else (
  python "%~dp0discover.py" %*
)
exit /b %ERRORLEVEL%

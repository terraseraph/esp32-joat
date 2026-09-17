@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nodered_push.ps1" %*
exit /b %ERRORLEVEL%

@echo off
cd /d "%~dp0"
echo Merobiman v0.2 - Open http://localhost:8080 after the server starts.
echo Keep this window open. Press Ctrl+C to stop.
"%~dp0bin\merobiman-windows-amd64.exe"
if errorlevel 1 pause

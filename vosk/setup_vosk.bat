@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo  SPX Voice Input - Vosk Server Setup
echo ============================================================
echo.

REM --- 1. Install Python dependencies ---
echo [1/3] Installing Python packages (vosk, websockets)...
python -m pip install --upgrade pip >nul 2>&1
python -m pip install vosk websockets
if errorlevel 1 (
    echo ERROR: pip install failed. Check Python is in PATH.
    pause
    exit /b 1
)
echo Done.
echo.

REM --- 2. Download Vietnamese model if missing ---
echo [2/3] Checking Vietnamese model...
if exist "vosk-model-small-vn-0.4" (
    echo Model already present, skipping download.
) else (
    echo Downloading vosk-model-small-vn-0.4 ^(~78MB^)...
    powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://alphacephei.com/vosk/models/vosk-model-small-vn-0.4.zip' -OutFile 'model.zip'"
    if errorlevel 1 (
        echo ERROR: Download failed.
        pause
        exit /b 1
    )
    echo Extracting...
    powershell -NoProfile -Command "Expand-Archive -Force 'model.zip' '.'"
    del model.zip
    echo Done.
)
echo.

REM --- 3. Create startup shortcut (VBS to run pythonw silently) ---
echo [3/3] Setting up Windows auto-start...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\vosk_server.vbs"
set "PYW="
for %%X in (pythonw.exe) do set "PYW=%%~$PATH:X"
if "!PYW!"=="" (
    echo WARNING: pythonw.exe not found in PATH. Using python.exe ^(will show console^).
    set "PYW=python.exe"
)

> "%VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS%" echo WshShell.Run """!PYW!"" """ ^& "%CD%\vosk_server.py" ^& """", 0, False
echo Created: %VBS%
echo.
echo Auto-start configured. Server will launch on next Windows boot.
echo.

REM --- 4. Start server now (silent) ---
echo Starting server now in background...
start "" /B "!PYW!" "%CD%\vosk_server.py"
timeout /t 2 /nobreak >nul
echo.

echo ============================================================
echo  Setup complete!
echo  - Server running on ws://localhost:2700
echo  - Logs: %CD%\vosk_server.log
echo  - Test: open SPX page, click mic, should detect Vosk.
echo ============================================================
pause

@echo off
setlocal
REM Launch Microsoft Edge (Main Profile = "OVG n SPX" = con.ong.vang.q9@gmail.com)
REM with remote debugging port 9222 - matches .mcp.json so the edge-devtools
REM MCP server can attach for live smoke testing.
REM
REM >>> Double-click this file. Do NOT "Run as administrator". <<<
REM Edge started elevated de-elevates itself and drops the debug flags.
REM
REM This uses your REAL Edge profile (Main Profile), so the debug port only
REM binds if NO other Edge is running. The bat detects a running Edge and,
REM after you confirm, closes it and relaunches in debug mode.
REM
REM NOTE: no parenthesized if-blocks - the Edge path has "(x86)"; an unquoted
REM expansion inside a ( ) block lets that ")" close the block early. goto
REM labels avoid that whole class of parse error.

REM --- Refuse to run elevated ----------------------------------------------
whoami /groups | find "S-1-16-12288" >nul
if not errorlevel 1 goto :elevated

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" goto :noedge

REM --- Edge must not be running, else debug port 9222 won't bind -----------
tasklist /fi "imagename eq msedge.exe" /nh | find /i "msedge.exe" >nul
if errorlevel 1 goto :launch

echo.
echo [edge-debug] Edge dang chay. De debug Main Profile (con.ong.vang.q9),
echo [edge-debug] TAT CA cua so Edge phai dong truoc (ke ca tien trinh nen).
echo [edge-debug] Nhan phim bat ky de DONG HET Edge va mo lai o che do debug,
echo [edge-debug] hoac dong cua so nay de huy (neu dang co tab chua luu).
echo.
pause
taskkill /f /im msedge.exe >nul 2>&1
REM cho Edge thoat han truoc khi mo lai
ping -n 3 127.0.0.1 >nul

:launch
start "" "%EDGE%" --remote-debugging-port=9222 --profile-directory="Main Profile" --no-first-run --no-default-browser-check

REM Success path: no pause - Edge runs detached, so this window can close
REM itself. (Error paths below keep pause so the message stays readable.)
exit /b 0

:elevated
echo.
echo [edge-debug] Ban dang chay file nay AS ADMINISTRATOR.
echo [edge-debug] Edge se tu de-elevate va bo cac flag debug - KHONG mo duoc.
echo [edge-debug] Hay DOUBLE-CLICK file nay binh thuong, khong Run as administrator.
echo.
pause
exit /b 1

:noedge
echo.
echo [edge-debug] Khong tim thay Edge tai duong dan:
echo %EDGE%
echo.
pause
exit /b 1

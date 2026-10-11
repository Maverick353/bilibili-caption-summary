@echo off
rem ============================================================
rem  Bilibili App-Mode Launcher
rem  Opens www.bilibili.com in a standalone browser window
rem  (no address bar, no tabs) using your DEFAULT browser profile,
rem  so Tampermonkey and your Bilibili login are still available.
rem
rem  IMPORTANT: we intentionally do NOT pass --user-data-dir.
rem  A custom profile dir would start an empty profile with no
rem  extensions, and the userscript would not run.
rem ============================================================

setlocal
set "URL=https://www.bilibili.com"

set "CHROME_A=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "CHROME_B=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
set "CHROME_C=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
set "EDGE_A=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "EDGE_B=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if exist "%CHROME_A%" ( start "" "%CHROME_A%" --app=%URL% & goto :done )
if exist "%CHROME_B%" ( start "" "%CHROME_B%" --app=%URL% & goto :done )
if exist "%CHROME_C%" ( start "" "%CHROME_C%" --app=%URL% & goto :done )
if exist "%EDGE_A%"   ( start "" "%EDGE_A%"   --app=%URL% & goto :done )
if exist "%EDGE_B%"   ( start "" "%EDGE_B%"   --app=%URL% & goto :done )

echo.
echo  Chrome / Edge not found in the usual locations.
echo  Please open this URL manually and use "Install as app" / "Create shortcut":
echo    %URL%
echo.
pause

:done
endlocal

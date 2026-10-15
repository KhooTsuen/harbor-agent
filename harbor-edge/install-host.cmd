@echo off
rem ============================================================================
rem  Harbor native host installer  (Edge browser extension)  -- Phase 1b
rem
rem  usage: install-host.cmd [extension-id] [harbor-dir]
rem
rem    extension-id : optional. If omitted, the script launches an isolated Edge
rem                   instance, loads harbor-edge\ext, and reads the REAL
rem                   extension id from the profile. An unpacked extension id is
rem                   derived from its load path and cannot be computed by hand
rem                   (measured: hand calculation gave a different id).
rem    harbor-dir   : optional. Directory containing Harbor.exe. Resolution order:
rem                   1) this argument, 2) %HARBOR_INSTALL_DIR%,
rem                   3) <repo>\dist-portable\Harbor
rem
rem  What it does (idempotent - running twice gives the same result):
rem    1. copies harbor-host.cmd into the Harbor directory
rem    2. writes the native host manifest to <Harbor>\data\edge-host\
rem    3. writes HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.harbor.agent
rem       (both 64-bit and 32-bit registry views)
rem    4. reads the real extension id and puts it into allowed_origins
rem
rem  THIS FILE MUST STAY PURE ASCII. cmd.exe reads .cmd files using the OEM
rem  codepage (GBK on zh-CN Windows); non-ASCII bytes in comments turn into
rem  garbage and then get executed as commands. This actually happened once
rem  during the Phase 0 experiments.
rem
rem  Uninstall with uninstall-host.cmd.
rem ============================================================================

setlocal enabledelayedexpansion

set "HOST_NAME=com.harbor.agent"
set "SRC_CMD=%~dp0harbor-host.cmd"
set "READID_JS=%~dp0tools\read-extid.cjs"

rem ---- which extension? ------------------------------------------------
rem The REAL extension is the build output (harbor-edge\dist\sidepanel):
rem its manifest.json + service-worker.js come from harbor-edge\extension\
rem via the vite publicDir, and index.html is the side panel page.
rem Build it first:  npx vite build --config harbor-edge/vite.config.ext.ts
rem The Phase 1b probe (harbor-edge\ext) is kept as a historical asset and
rem is NOT what the host should be wired to.
set "EXT_DIR=%~dp0dist\sidepanel"

rem ---- resolve harbor dir ----
set "HARBOR_DIR=%~2"
if defined HARBOR_DIR goto :have_dir
if defined HARBOR_INSTALL_DIR set "HARBOR_DIR=%HARBOR_INSTALL_DIR%"
if defined HARBOR_DIR goto :have_dir
for %%i in ("%~dp0..\dist-portable\Harbor") do set "HARBOR_DIR=%%~fi"
:have_dir

echo.
echo === Harbor native host installer ===
echo   Harbor dir  : %HARBOR_DIR%
echo   Extension   : %EXT_DIR%
echo.

if not exist "%HARBOR_DIR%\Harbor.exe" (
  echo [X] Harbor.exe not found in "%HARBOR_DIR%"
  echo     usage: install-host.cmd [extension-id] [harbor-dir]
  exit /b 1
)
if not exist "%SRC_CMD%" (
  echo [X] missing "%~dp0harbor-host.cmd"
  exit /b 1
)
if not exist "%EXT_DIR%\manifest.json" (
  echo [X] extension build output not found: "%EXT_DIR%"
  echo     build it first:  npx vite build --config harbor-edge/vite.config.ext.ts
  exit /b 1
)

set "HOST_CMD=%HARBOR_DIR%\harbor-host.cmd"
set "MANIFEST_DIR=%HARBOR_DIR%\data\edge-host"
set "MANIFEST=%MANIFEST_DIR%\%HOST_NAME%.json"

rem ---- 1. copy the wrapper next to Harbor.exe ----
copy /Y "%SRC_CMD%" "%HOST_CMD%" >nul
if errorlevel 1 (
  echo [X] failed to copy wrapper to "%HOST_CMD%"
  exit /b 1
)
echo [1/4] wrapper copied

rem ---- 2. figure out the extension id ----
set "EXT_ID=%~1"
if defined EXT_ID goto :have_id
if not exist "%READID_JS%" goto :no_id
echo [2/4] reading the real extension id (launches an isolated Edge) ...
set "ID_OUT=%TEMP%\harbor-extid-%RANDOM%.txt"
set ELECTRON_RUN_AS_NODE=1
"%HARBOR_DIR%\Harbor.exe" "%READID_JS%" --ext="%EXT_DIR%" > "%ID_OUT%" 2>nul
set ELECTRON_RUN_AS_NODE=
if exist "%ID_OUT%" set /p EXT_ID=<"%ID_OUT%"
if exist "%ID_OUT%" del /F /Q "%ID_OUT%" >nul 2>nul
:no_id
if not defined EXT_ID (
  echo [X] could not determine the extension id.
  echo     Load harbor-edge\ext in Edge ^(edge://extensions, Developer mode^),
  echo     copy its id, then run:  install-host.cmd ^<extension-id^>
  exit /b 1
)
:have_id
echo [2/4] extension id = %EXT_ID%

rem ---- 3. registry key ----
reg ADD "HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f /reg:64 >nul
if errorlevel 1 (
  echo [X] failed to write registry key
  exit /b 1
)
reg ADD "HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f /reg:32 >nul 2>nul
echo [3/4] registry written

rem ---- 4. manifest (JSON needs doubled backslashes) ----
if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%"
set "HOST_CMD_JSON=%HOST_CMD:\=\\%"
> "%MANIFEST%" echo {
>> "%MANIFEST%" echo   "name": "%HOST_NAME%",
>> "%MANIFEST%" echo   "description": "Harbor browser companion host",
>> "%MANIFEST%" echo   "path": "%HOST_CMD_JSON%",
>> "%MANIFEST%" echo   "type": "stdio",
>> "%MANIFEST%" echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
>> "%MANIFEST%" echo }
echo [4/4] manifest written

echo.
echo Done.
echo   Manifest : %MANIFEST%
echo   Wrapper  : %HOST_CMD%
echo.
echo Next: load the Harbor extension in Edge
echo   edge://extensions  -^> Developer mode -^> Load unpacked -^> %EXT_DIR%
echo Verify the wiring with:  node harbor-edge\tools\accept-extension.cjs
exit /b 0

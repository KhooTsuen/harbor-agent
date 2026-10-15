@echo off
rem ============================================================================
rem  Harbor native host uninstaller  (Edge browser extension)  -- Phase 1b
rem
rem  usage: uninstall-host.cmd [harbor-dir]
rem
rem  Removes everything install-host.cmd created. Idempotent: running it when
rem  nothing is installed succeeds and changes nothing.
rem    1. deletes the Edge NativeMessagingHosts registry key (64 and 32 bit)
rem    2. deletes the wrapper copied next to Harbor.exe
rem    3. deletes the manifest directory
rem
rem  THIS FILE MUST STAY PURE ASCII (see install-host.cmd for the reason).
rem ============================================================================

setlocal

set "HOST_NAME=com.harbor.agent"

set "HARBOR_DIR=%~1"
if defined HARBOR_DIR goto :have_dir
if defined HARBOR_INSTALL_DIR set "HARBOR_DIR=%HARBOR_INSTALL_DIR%"
if defined HARBOR_DIR goto :have_dir
for %%i in ("%~dp0..\dist-portable\Harbor") do set "HARBOR_DIR=%%~fi"
:have_dir

echo.
echo === Harbor native host uninstaller ===
echo   Harbor dir : %HARBOR_DIR%
echo.

reg DELETE "HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f /reg:64 >nul 2>nul
reg DELETE "HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f /reg:32 >nul 2>nul
echo [1/3] registry key removed

if exist "%HARBOR_DIR%\harbor-host.cmd" del /F /Q "%HARBOR_DIR%\harbor-host.cmd" >nul 2>nul
echo [2/3] wrapper removed

if exist "%HARBOR_DIR%\data\edge-host" rmdir /S /Q "%HARBOR_DIR%\data\edge-host" >nul 2>nul
echo [3/3] manifest directory removed

echo.
echo Verification (the query below should report nothing):
reg QUERY "HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" 2>nul
if exist "%HARBOR_DIR%\harbor-host.cmd" echo   WARNING: wrapper still present
if exist "%HARBOR_DIR%\data\edge-host" echo   WARNING: manifest dir still present
echo Done.
exit /b 0

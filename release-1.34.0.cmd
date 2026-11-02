@echo off
setlocal
rem ============================================================================
rem  Harbor 1.34.0 release  --  double-click this file
rem
rem  Why a double-click script: `npm run package` calls taskkill /F /IM Harbor.exe
rem  (scripts/build-portable.mjs -> killRunning). That closes every Harbor window,
rem  including the one the agent is running inside. So the build has to happen in
rem  a console that is NOT owned by Harbor.
rem
rem  What it does, in order (every step appends to the log):
rem    [1/6] npm run package       -> rebuild dist-portable\Harbor from source
rem    [2/6] npm run release:zip   -> dist-portable\harbor-1.34.0-win-x64.zip
rem    [3/6] robocopy -> E:\Harbor-Dev\dist-portable\Harbor   (dev copy)
rem    [4/6] robocopy -> E:\Harbor                            (installed copy)
rem    [5/6] npm run release:upload   create GitHub Release + upload the zip
rem    [6/6] read back the version of all three copies, then relaunch the dev copy
rem
rem  Never touched: any data\ directory (chats / memory / credentials live there),
rem  and E:\Harbor-Dev\...\harbor-host.cmd (a per-machine native-messaging launcher
rem  that only exists in the dev copy).
rem
rem  Steps 1-4 are local and safe to re-run. Step 5 is idempotent too: an existing
rem  Release is reused and an existing asset with the same name is skipped.
rem  If step 5 fails (network / token), the three copies are already updated --
rem  just run:  npm.cmd run release:upload
rem ============================================================================

set ROOT=E:\CodexWorkbench
set SRC=%ROOT%\dist-portable\Harbor
set DEVAPP=E:\Harbor-Dev\dist-portable\Harbor
set INSAPP=E:\Harbor
set DEVEXE=%DEVAPP%\Harbor.exe
set LOG=%ROOT%\tmp\release-1.34.0.log

if not exist "%ROOT%\package.json" (
  echo Cannot find %ROOT%\package.json - aborting.
  pause
  exit /b 1
)

cd /d "%ROOT%"
echo ============================================================ > "%LOG%"
echo === Harbor 1.34.0 release : %DATE% %TIME% === >> "%LOG%"

echo.
echo [1/6] npm run package  (this closes every Harbor window) ...
call npm.cmd run package >> "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [2/6] npm run release:zip ...
call npm.cmd run release:zip >> "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [3/6] sync dev copy  (data\ untouched) ...
robocopy "%SRC%" "%DEVAPP%" /MIR /XD data /XF harbor-host.cmd /NFL /NDL /NJH /NJS /NP >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
echo   dev sync exit=%RC% >> "%LOG%"
if %RC% GEQ 8 goto :fail

echo [4/6] sync installed copy  (data\ untouched) ...
robocopy "%SRC%" "%INSAPP%" /MIR /XD data /NFL /NDL /NJH /NJS /NP >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
echo   installed sync exit=%RC% >> "%LOG%"
if %RC% GEQ 8 goto :fail

echo [5/6] upload Release to GitHub  (a few minutes) ...
call npm.cmd run release:upload >> "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [6/6] read back versions ...
echo -- A: repo dist-portable -- >> "%LOG%"
type "%SRC%\resources\app\package.json" | findstr /c:"\"version\"" >> "%LOG%" 2>&1
type "%SRC%\resources\app\build-info.json" >> "%LOG%" 2>&1
echo -- B: dev copy -- >> "%LOG%"
type "%DEVAPP%\resources\app\package.json" | findstr /c:"\"version\"" >> "%LOG%" 2>&1
type "%DEVAPP%\resources\app\build-info.json" >> "%LOG%" 2>&1
echo -- C: installed copy -- >> "%LOG%"
type "%INSAPP%\resources\app\package.json" | findstr /c:"\"version\"" >> "%LOG%" 2>&1
type "%INSAPP%\resources\app\build-info.json" >> "%LOG%" 2>&1
echo === DONE : %DATE% %TIME% === >> "%LOG%"

echo.
echo ============================================================
echo   ALL DONE
echo ============================================================
echo   A repo     : %SRC%
echo   B dev      : %DEVAPP%
echo   C installed: %INSAPP%
echo   zip        : %ROOT%\dist-portable\harbor-1.34.0-win-x64.zip
echo   log        : %LOG%
echo.
echo   Next, only if you want the old release removed
echo   (retention policy keeps 1 stable + 1 beta; default is a dry run):
echo     npm.cmd run release:prune -- --keep=v1.34.0,v1.30.0-beta.17
echo     npm.cmd run release:prune -- --keep=v1.34.0,v1.30.0-beta.17 --tags --apply
echo.
echo   Relaunching the dev copy ...
start "" "%DEVEXE%"
echo Press any key to close this window.
pause >nul
exit /b 0

:fail
echo.
echo ============================================================
echo   FAILED - stopped at the step printed above, nothing after it ran.
echo ============================================================
echo   log: %LOG%
echo.
echo   Steps 1-4 are safe to re-run from here (double-click this file again,
echo   or run the single failed command by hand).
echo Press any key to close this window.
pause >nul
exit /b 1

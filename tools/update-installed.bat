@echo off
chcp 65001 >nul
setlocal
title Harbor 打包 + 同步装机版（在 Harbor 外面跑）

set "SRC=E:\CodexWorkbench"
set "DST=E:\Harbor"
set "REPO_APP=%SRC%\dist-portable\Harbor"

echo.
echo ============================================================
echo   Harbor 打包 + 同步装机版
echo   源：%REPO_APP%
echo   目标：%DST%   （data\ 两侧都排除，一个字节都不动）
echo ============================================================
echo.

rem ── 0. Harbor 必须在关着 ──────────────────────────────────
rem 为什么必须关：打包脚本第一步是 taskkill /F /IM Harbor.exe（按镜像名杀，不看路径）。
rem 应用开着的话，同步中途文件被占用，而且在 Harbor 里发起这一步还会把发起方自己杀掉。
tasklist /FI "IMAGENAME eq Harbor.exe" /NH 2>nul | find /I "Harbor.exe" >nul
if not errorlevel 1 (
  echo [!] 检测到 Harbor 正在运行。
  echo     请先把它完全退出：点窗口的 × 会最小化到托盘，
  echo     要右键任务栏托盘里的 Harbor 图标 -^> 退出。
  echo     退出后重新双击本文件。
  echo.
  pause
  exit /b 1
)
echo [0/5] Harbor 没在运行，可以开始。
echo.

rem ── 1. 记录 data\ 指纹（更新前）─────────────────────────────
echo [1/5] 记录 %DST%\data 的指纹（更新前）…
for /f "usebackq delims=" %%i in (`node "%SRC%\tools\data-fingerprint.cjs" "%DST%\data"`) do set "FP1=%%i"
echo      %FP1%
echo.

rem ── 2. 打包（约 20 秒）──────────────────────────────────
echo [2/5] npm run package（约 20 秒）…
pushd "%SRC%"
call npm run package
set "PKG=%ERRORLEVEL%"
popd
if not "%PKG%"=="0" (
  echo.
  echo [X] 打包失败（退出码 %PKG%），没有同步任何东西。把上面的输出发给我。
  echo.
  pause
  exit /b %PKG%
)
echo      打包完成。
echo.

rem ── 3. 同步到装机版 ─────────────────────────────────────
rem 注意：刚跑过一次 build-portable 之后，Electron 运行时（dll/pak）的**时间戳**会变新，
rem       robocopy 会按时间戳重拷一遍（实测 236MB）—— 内容其实没变，只是怂一点，别慌。
echo [3/5] 同步程序文件到 %DST%（排除两侧 data\）…
robocopy "%REPO_APP%" "%DST%" /MIR /XD "%REPO_APP%\data" "%DST%\data" /NFL /NDL /NP /NJH /NJS
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo.
  echo [X] robocopy 失败（退出码 %RC%，8 以上算失败）。data\ 没被动过。
  echo.
  pause
  exit /b %RC%
)
echo      同步成功（robocopy 退出码 %RC%，小于 8 都算成功）。
echo.

rem ── 4. 核对 data\ 指纹（更新后）──────────────────────────
echo [4/5] 核对 %DST%\data 的指纹（更新后）…
for /f "usebackq delims=" %%i in (`node "%SRC%\tools\data-fingerprint.cjs" "%DST%\data"`) do set "FP2=%%i"
echo      更新前：%FP1%
echo      更新后：%FP2%
if "%FP1%"=="%FP2%" (
  echo      [OK] 指纹完全一致 —— data\ 一个字节都没动。
) else (
  echo      [!!] 指纹不一致！先别打开应用，把这两行发给我。
)
echo.

rem ── 5. 版本 + 结论 ──────────────────────────────────────
echo [5/5] 版本：
for /f "usebackq delims=" %%v in (`node -e "console.log(require('%DST%/resources/app/package.json').version)"`) do echo      装机版 = %%v
for /f "usebackq delims=" %%v in (`node -e "console.log(require('%REPO_APP%/resources/app/package.json').version)"`) do echo      构建产物 = %%v

echo.
echo ============================================================
echo   做完了。打开 %DST%\Harbor.exe 就是新版。
echo   回来把上面「指纹」两行和版本号告诉我。
echo ============================================================
echo.
pause
endlocal

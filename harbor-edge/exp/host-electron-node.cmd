@echo off
rem exp 3b: .cmd wrapper -> ELECTRON_RUN_AS_NODE + Harbor.exe -> native-host.cjs
rem ASCII ONLY (see host-node.cmd for why). No extra Node install required:
rem reuses the Electron binary that ships with Harbor, in pure-Node mode.
rem Arguments from Edge (origin + --parent-window) are intentionally NOT forwarded
rem with %*: native-host.cjs does not need them.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\dist-portable\Harbor\Harbor.exe" "%~dp0..\..\dist-portable\Harbor\resources\app\electron\native-host.cjs"

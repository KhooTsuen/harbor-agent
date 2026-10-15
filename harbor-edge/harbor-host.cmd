@echo off
rem ============================================================================
rem  Harbor native messaging host wrapper  (Edge browser extension)
rem
rem  This file is the "path" target in the native host manifest. Edge launches
rem  it; it starts Harbor.exe in PURE NODE MODE and runs native-host.cjs, which
rem  speaks the native messaging frame protocol on stdin/stdout.
rem
rem  WHY THIS WRAPPER EXISTS (measured, not guessed - see
rem  docs/research/edge-extension-host-stdout-experiments.md):
rem    * A host manifest "path" must be a plain executable path. It can NOT
rem      carry command line arguments: Edge treats the whole string as a file
rem      path and reports "Specified native messaging host not found."
rem      So we cannot write "Harbor.exe native-host.cjs" directly.
rem    * Letting Harbor.exe start as a normal Chromium app is also broken: the
rem      Chromium init path writes a single CRLF to stdout during startup, which
rem      corrupts the 4-byte little-endian frame header (Edge then reads a
rem      nonsense frame length and reports a communication error).
rem    * ELECTRON_RUN_AS_NODE=1 makes the Electron binary run as plain Node
rem      WITHOUT initializing Chromium. stdout is then byte-exact (verified by
rem      dumping raw bytes locally against a node.exe control).
rem
rem  RULES - breaking any of these silently corrupts the protocol stream:
rem    1. THIS FILE MUST STAY PURE ASCII. cmd.exe reads it as the OEM codepage
rem       (GBK on zh-CN Windows); non-ASCII bytes in comments become garbage and
rem       are then executed as commands. This actually happened once.
rem    2. DO NOT add "chcp 65001". It looks like the fix but chcp writes to
rem       stdout, which IS the protocol channel.
rem    3. Keep "@echo off": command echo also goes to stdout.
rem    4. Do not forward %* . The script takes no arguments on purpose.
rem
rem  Uninstall: uninstall-host.cmd (deletes the registry key and this file).
rem ============================================================================

setlocal
set ELECTRON_RUN_AS_NODE=1
rem  Data root (Phase 2). native-host.cjs cannot use core/paths.cjs here: that module
rem  relies on markPackaged() which main.cjs calls, and under this wrapper main.cjs
rem  never runs. So the wrapper tells it explicitly ("%~dp0" ends with a backslash).
set HARBOR_DATA_ROOT=%~dp0data
"%~dp0Harbor.exe" "%~dp0resources\app\electron\native-host.cjs"

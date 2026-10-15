@echo off
rem exp 3a: .cmd wrapper -> node.exe -> pure Node probe.
rem ASCII ONLY. cmd reads .cmd as the OEM codepage (GBK here), so any UTF-8
rem Chinese comment turns into mojibake and may be executed as a command.
rem DO NOT use chcp to fix this: chcp writes to stdout and would corrupt frames.
setlocal
"E:\nodejs\node.exe" "%~dp0..\..\dist-portable\Harbor\resources\app\electron\native-host.cjs"

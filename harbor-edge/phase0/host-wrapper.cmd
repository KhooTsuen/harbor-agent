@echo off
rem ── Phase 1a：让 Harbor.exe 以「纯 Node 模式」当 native host ─────
rem
rem 为什么必须这样：Harbor.exe（Electron 的 Windows 二进制）是 **GUI 子系统**
rem 程序，它的 stdout 不会指向 Edge 建立的 native messaging 管道 ——
rem 实测 fs.writeSync(1, frame) 返回 51（写"成功"），但 Edge 一个字节收不到。
rem 读没问题（fd 0 靠 Windows 代读），写这条路是断的。
rem
rem ELECTRON_RUN_AS_NODE=1 让 electron 二进制**以纯 Node 跑**，不初始化
rem Chromium / GUI —— 此时的 stdio 就是普通 console 行为，管道通。
rem
rem @echo off 是必须的：否则 cmd 会把每条命令回显到 stdout，污染协议帧。
setlocal
set ELECTRON_RUN_AS_NODE=1
"E:\CodexWorkbench\dist-portable\Harbor\Harbor.exe" "E:\CodexWorkbench\dist-portable\Harbor\resources\app\electron\native-host.cjs" %*

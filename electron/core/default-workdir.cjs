const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')

/* ══════════════════════════════════════════════════════════════
   「没配工作目录时到底用哪儿」—— **唯一一份**

   两条路都要用同一个答案：
     · `handlers/workdir.cjs` 的 `currentWorkdir()`（对话 / 工具的工作目录）
     · `core/pty.cjs`（终端起在哪儿）
   以前各写各的：一个 `DIRS.workspace`、一个 `DIRS.chat`，于是在「workspace 里有东西」
   的机器上会岔开 —— 终端开在一个空目录、Agent 却在另一个目录干活（自检日志里真看到过）。

   规则（2026-10-05 用户拍板：默认位置改成 `data/chat`，但不搬家）：
     · `workspace` 里有东西、而 `chat` 还空着 → **继续用 workspace**（升级完东西还在原处）；
     · 否则（新装 / 两边都空 / 两边都有）→ 用 chat。
   调这个函数之前，`config.general.workdir` 有没有配、目录在不在，由调用方判断。
   ══════════════════════════════════════════════════════════════ */

/** 目录里有没有东西（读不了当没有 —— 权限问题不归这里管） */
function hasContent(dir) {
  try {
    return fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

function defaultWorkdir() {
  if (hasContent(DIRS.workspace) && !hasContent(DIRS.chat)) return DIRS.workspace
  return DIRS.chat
}

module.exports = { defaultWorkdir, hasContent }

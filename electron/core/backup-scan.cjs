/**
 * 自动备份：**清单、路径、扫描**
 *
 * 从 `backup.cjs` 拆出来的（2026-10-04）—— 那边加完「空壳备份」的防护后到了 315 行，
 * 过了 300 行红线。拆法按职责切：这边只有**只读**的东西（清单常量、路径、算体积、列出备份），
 * 真正会动磁盘的（create / restore / remove / prune / maybeAuto）留在 `backup.cjs`。
 *
 * 为什么 `ITEMS` 在这边：`list()` 要拿它算「哪几项缺了 / 是不是空壳」，
 * 放一起就不用两边互相 require。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')

/** 留最近几份。太多没意义，用户也不会去翻 */
const KEEP = 10

/** 备份清单：只备用户自己的东西 */
const ITEMS = [
  { name: 'config.json', dir: false },
  /* `memory.json` —— 以前写的是 `memory.md`（老路径，启动时早被改名了），
     于是记忆从来没被备到过，而备份照报「成功」（审计问题 5） */
  { name: 'memory.json', dir: false },
  { name: 'sessions', dir: true },
  { name: 'skills', dir: true },
]

function backupRoot() {
  return path.join(DIRS.data, 'backups')
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * 这一项里有真东西吗（文件非空 / 目录里有条目）。
 *
 * 首启时 config/memory 还没落盘、sessions 是空目录 → 备份会做成一个「壳」。
 * 恢复这种壳 = 拿空目录盖掉用户现有的对话与技能（审计问题 13）。**按磁盘算**，
 * 所以历史遗留的壳也能被标出来，不只管新写的 meta。
 */
function hasContent(target) {
  try {
    const st = fs.statSync(target)
    if (!st.isDirectory()) return st.size > 0
    return fs.readdirSync(target).length > 0
  } catch {
    return false
  }
}

function dirSize(target) {
  let total = 0
  const walk = (p) => {
    let entries
    try {
      entries = fs.readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          /* 读不到就算了 */
        }
      }
    }
  }
  try {
    if (fs.statSync(target).isDirectory()) walk(target)
    else return fs.statSync(target).size
  } catch {
    return 0
  }
  return total
}

/** 列出所有备份，新的在前 */
function list() {
  let entries = []
  try {
    entries = fs.readdirSync(backupRoot(), { withFileTypes: true })
  } catch {
    return []
  }

  return (
    entries
      /* 同一秒内连点会顺延成 20260914-080206-1，后缀要认得 */
      .filter((e) => e.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(e.name))
      .map((e) => {
        const full = path.join(backupRoot(), e.name)
        let meta = {}
        try {
          meta = JSON.parse(fs.readFileSync(path.join(full, 'meta.json'), 'utf8'))
        } catch {
          /* 老备份可能没有 meta */
        }
        /* 缺哪几项（没有 / 是空的）；empty = 一个用户项都没有 → 界面禁用「恢复」 */
        const missing = ITEMS.filter((i) => !hasContent(path.join(full, i.name))).map((i) => i.name)
        return {
          name: e.name,
          path: full,
          size: dirSize(full),
          reason: typeof meta.reason === 'string' ? meta.reason : '手动',
          items: Array.isArray(meta.items) ? meta.items : [],
          createdAt: fs.statSync(full).mtimeMs,
          empty: missing.length === ITEMS.length,
          missing,
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  )
}

module.exports = { KEEP, ITEMS, backupRoot, stamp, hasContent, dirSize, list }

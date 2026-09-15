/**
 * 自动备份
 *
 * 备份「用户自己的数据」到 data/backups/<时间戳>/。恢复就是把文件拷回去。
 *
 * 为什么只备这几样：config（配置）、memory（记忆）、sessions（对话）、skills（技能）。
 * 日志是排错用的、缓存能重建，备了只是浪费空间。
 *
 * 为什么用目录拷贝而不是打包压缩：用户能直接进去看、单独拿一个文件出来。
 * 这个软件本来就是「文件都在文件夹里」的形态，备份也跟着这个逻辑走。
 *
 * 便携版有个真实风险：整个文件夹拷到 U 盘时中途拔了，data 就残了 ——
 * 所以启动时会（每 24 小时）自动备一份。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')

/** 留最近几份。太多没意义，用户也不会去翻 */
const KEEP = 10
/** 自动备份的间隔 */
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 备份清单：只备用户自己的东西 */
const ITEMS = [
  { name: 'config.json', dir: false },
  { name: 'memory.md', dir: false },
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
        return {
          name: e.name,
          path: full,
          size: dirSize(full),
          reason: typeof meta.reason === 'string' ? meta.reason : '手动',
          items: Array.isArray(meta.items) ? meta.items : [],
          createdAt: fs.statSync(full).mtimeMs,
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  )
}

/** 超量就删最旧的 */
function prune() {
  const all = list()
  const removed = []
  for (const old of all.slice(KEEP)) {
    try {
      fs.rmSync(old.path, { recursive: true, force: true })
      removed.push(old.name)
    } catch (error) {
      log.warn(`删旧备份失败 ${old.name}：${error instanceof Error ? error.message : error}`)
    }
  }
  return removed
}

/**
 * 做一次备份。
 *
 * @param {string} reason  'manual' | 'auto' | 'before-restore'
 */
function create(reason = 'manual') {
  const name = stamp()
  const target = path.join(backupRoot(), name)

  /* 同一秒内重复触发（连点按钮）就顺延，别覆盖上一份 */
  let finalTarget = target
  let suffix = 1
  while (fs.existsSync(finalTarget)) {
    finalTarget = `${target}-${suffix++}`
  }

  const copied = []
  try {
    fs.mkdirSync(finalTarget, { recursive: true })

    for (const item of ITEMS) {
      const source = path.join(DIRS.data, item.name)
      if (!fs.existsSync(source)) continue
      const dest = path.join(finalTarget, item.name)
      fs.cpSync(source, dest, { recursive: item.dir, force: true })
      copied.push(item.name)
    }

    fs.writeFileSync(
      path.join(finalTarget, 'meta.json'),
      JSON.stringify(
        { reason, items: copied, createdAt: new Date().toISOString(), version: 1 },
        null,
        2,
      ),
      'utf8',
    )
  } catch (error) {
    /* 备份失败不能影响主流程，但要把半成品清掉免得被当成有效备份 */
    try {
      fs.rmSync(finalTarget, { recursive: true, force: true })
    } catch {
      /* 清不掉也只能算了 */
    }
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`备份失败：${message}`)
    return { ok: false, error: message }
  }

  const removed = prune()
  log.info(`已备份：${path.basename(finalTarget)}（${copied.join(', ')}）`)

  return {
    ok: true,
    name: path.basename(finalTarget),
    path: finalTarget,
    size: dirSize(finalTarget),
    items: copied,
    removed,
  }
}

/**
 * 启动时调：距上次备份超过一天就自动备一份。
 * 用备份目录里最新一份的时间来判断，不额外存状态 —— 少一个可能不同步的地方。
 */
function maybeAuto() {
  const all = list()
  const newest = all[0]
  if (newest && Date.now() - newest.createdAt < AUTO_INTERVAL_MS) {
    return { skipped: true, lastAt: newest.createdAt }
  }
  return create('auto')
}

/**
 * 恢复：先把当前数据备份一次（before-restore），再拷回去。
 * 恢复本身很危险，先留后路。
 */
function restore(name) {
  const source = path.join(backupRoot(), name)
  if (!fs.existsSync(source)) return { ok: false, error: `找不到备份 ${name}` }

  const safety = create('before-restore')
  const restored = []

  try {
    for (const item of ITEMS) {
      const from = path.join(source, item.name)
      if (!fs.existsSync(from)) continue
      const to = path.join(DIRS.data, item.name)
      /* 先删再拷：不然旧文件会和新文件混在一起（比如已删的会话又活了） */
      fs.rmSync(to, { recursive: item.dir, force: true })
      fs.cpSync(from, to, { recursive: item.dir, force: true })
      restored.push(item.name)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`恢复失败：${message}`)
    return {
      ok: false,
      error: message,
      safetyBackup: safety.ok ? safety.name : '',
    }
  }

  log.info(`已从 ${name} 恢复（${restored.join(', ')}）`)
  return {
    ok: true,
    restored,
    safetyBackup: safety.ok ? safety.name : '',
    needsRestart: true,
  }
}

function remove(name) {
  const target = path.join(backupRoot(), name)
  if (!fs.existsSync(target)) return { ok: false, error: '找不到这个备份' }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 打开备份目录（用系统文件管理器） */
function root() {
  return backupRoot()
}

module.exports = { create, list, restore, remove, maybeAuto, root, stamp, KEEP, ITEMS }

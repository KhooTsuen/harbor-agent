/**
 * 内核：数据目录的保留期（logs / events / crash）
 *
 * ── 为什么单独一个文件，不和 `error-retention.cjs` 合并 ──
 *
 * 那个文件管的是「错误记录」这一种形状（`<日期>.jsonl`），三条自我约束写得很好，
 * 这里**逐条照抄**：
 *   1. **只删自己写的名字**：文件名形状不认得的一律不碰（用户往这些目录里放别的
 *      东西是他的自由，不是清理对象）；
 *   2. **永远保留每个形状里最新的那个**（哪怕它比保留期还老）—— 否则用户一打开
 *      会以为数据没了；
 *   3. **删了什么要留痕**：删了几条写进主日志，删数据这件事不能静默。
 *
 * 不合并的理由：这边要管**三种形状完全不同**的文件（按天的主日志 / 按天的 jsonl /
 * 每次大输出一个的 tool-output / 崩溃转储），规则各不相同；合并只会让两边都变难读，
 * 而 error 那条链已经验过，不该为了省一个文件去动它。
 *
 * 会话诊断快照那一半（要跟会话对账）在 `diag-retention.cjs`。
 *
 * ── 两个通用约定 ──
 *   · **绝不抛**：清理只是省空间，不是功能。失败记一行 warn 就回去（问题 1/3/4/10/11
 *     的共同验收要求：清理抛错时应用照样能起）。
 *   · **保留期写死 30 天**，和 `error-retention.cjs` 一致 —— 不在这里加配置项
 *     （那属于新功能，见 improvement-checklist）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const diagRetention = require('./diag-retention.cjs')

const KEEP_DAYS = 30
/** 崩溃转储：不管多老，至少留最近这么多份（崩溃现场值钱） */
const CRASH_KEEP_MIN = 3
/** tool-output：同理（长任务的完整输出常常是过几天才回头查的） */
const OUTPUT_KEEP_MIN = 5
/** token-metrics 单文件上限 —— 和 `log-actions.cjs` 的 6MB 同口径 */
const METRICS_MAX_BYTES = 6 * 1024 * 1024

const DAY_MS = 86_400_000
const pad = (n) => String(n).padStart(2, '0')
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 主日志：一天一个 `2026-10-04.log` */
const MAIN_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.log$/
/** 动作流水：一天一个 `actions-2026-10-04.jsonl`（单文件 6MB 轮转在 log-actions 里） */
const ACTIONS_RE = /^actions-(\d{4}-\d{2}-\d{2})\.jsonl$/
/** 事件流：一天一个 `2026-10-03.jsonl` */
const EVENTS_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
/** 工具大输出：每次一个 `tool-output-<epoch ms>.log` */
const TOOL_OUTPUT_RE = /^tool-output-(\d{10,16})\.log$/

/**
 * 「一天一个文件」的统一保留期（logs 主日志 / actions / events 共用）。
 *
 * @param {{dir: string, re: RegExp, days?: number, now?: number, label?: string}} options
 * @returns {{ok: boolean, removed: string[], kept: number, reason?: string}}
 */
function pruneDaily({ dir, re, days = KEEP_DAYS, now = Date.now(), label = '按天文件' }) {
  try {
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return { ok: true, removed: [], kept: 0, reason: '目录还不存在' }
    }
    const dated = names.map((name) => ({ name, m: re.exec(name) })).filter((x) => x.m)
    if (dated.length === 0) return { ok: true, removed: [], kept: 0, reason: '没有可清理的文件' }

    /* 按日期倒序 → 第 0 个是最新的，从第 1 个开始才允许删（约束 2） */
    dated.sort((a, b) => b.m[1].localeCompare(a.m[1]))
    const limit = dayOf(new Date(now - days * DAY_MS))
    const removed = []
    for (const { name, m } of dated.slice(1)) {
      /* YYYY-MM-DD 定长同构 → 字符串比较就是日期比较 */
      if (m[1] >= limit) continue
      try {
        fs.unlinkSync(path.join(dir, name))
        removed.push(name)
      } catch {
        /* 占用/权限删不掉就算了，下次启动还会来 */
      }
    }
    if (removed.length > 0) {
      log.warn(`清理${label}：删了 ${removed.length} 个（保留最近 ${days} 天，最早 ${removed[removed.length - 1]}）`)
    }
    return { ok: true, removed, kept: dated.length - removed.length }
  } catch (error) {
    log.warn(`清理${label}失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, removed: [], kept: 0, reason: String(error) }
  }
}

/**
 * 按「年龄 + 至少留 N 份」清理（tool-output / 崩溃转储共用）。
 *
 * 年龄优先取**文件名里的时间戳**（tool-output 带），取不到退回 mtime。
 * 名字形状不认得的**一个都不碰**（约束 1）—— 崩溃目录里可能还有用户自己放的
 * 转储/说明文件。
 *
 * @param {{dir: string, re: RegExp, days?: number, keepMin?: number, now?: number, label?: string}} o
 */
function pruneByAge({ dir, re, days = KEEP_DAYS, keepMin = 0, now = Date.now(), label = '旧文件' }) {
  try {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return { ok: true, removed: [], kept: 0, reason: '目录还不存在' }
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const m = re.exec(entry.name)
      if (!m) continue
      const fromName = m[1] ? Number(m[1]) : NaN
      let at = Number.isFinite(fromName) && fromName > 0 ? fromName : NaN
      if (!Number.isFinite(at)) {
        try {
          at = fs.statSync(path.join(dir, entry.name)).mtimeMs
        } catch {
          at = now /* 读不到时间就算「刚写的」→ 不删 */
        }
      }
      files.push({ name: entry.name, at })
    }
    if (files.length === 0) return { ok: true, removed: [], kept: 0, reason: '没有可清理的文件' }

    files.sort((a, b) => b.at - a.at)
    const limit = now - days * DAY_MS
    const removed = []
    for (const item of files.slice(keepMin)) {
      if (item.at >= limit) continue
      try {
        fs.unlinkSync(path.join(dir, item.name))
        removed.push(item.name)
      } catch {
        /* 同上 */
      }
    }
    if (removed.length > 0) {
      log.warn(`清理${label}：删了 ${removed.length} 个（保留最近 ${days} 天，且至少留 ${keepMin} 份）`)
    }
    return { ok: true, removed, kept: files.length - removed.length }
  } catch (error) {
    log.warn(`清理${label}失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, removed: [], kept: 0, reason: String(error) }
  }
}

/**
 * 单文件超上限就改名留一份旧的（审计问题 4：`token-metrics.jsonl` 以前只增不减）。
 *
 * 和 `log-actions.rotateIfNeeded` 同一套做法（那份没动 —— 不动已验过的代码）。
 * 只留一份 `.1`（下次再超会把它盖掉），所以总量有界。
 *
 * @returns {boolean} 有没有真的转
 */
function rotateFile(file, incoming = 0, maxBytes = METRICS_MAX_BYTES) {
  try {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size + incoming <= maxBytes) return false
    const backup = `${file}.1`
    fs.rmSync(backup, { force: true })
    fs.renameSync(file, backup)
    log.warn(`清理 token 指标：单文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，旧的改名成 ${path.basename(backup)}`)
    return true
  } catch {
    /* 轮转失败不影响写指标 */
    return false
  }
}

/**
 * 启动时扫一遍：五条一起（每条单独 try，互不影响）。
 *
 * 调用点在 `boot-cleanup.sweepStaleTasks()`（那是「启动清扫」的家）——
 * 所以不碰 `main.cjs`（只剩 299 行）。
 *
 * @param {{now?: number, dirs?: object}} [options] `dirs` 同上，给测试用。
 */
function pruneAll({ now = Date.now(), dirs = {} } = {}) {
  const logs = dirs.logs ?? DIRS.logs
  const out = {}
  const steps = [
    ['logs.daily', () => pruneDaily({ dir: logs, re: MAIN_LOG_RE, now, label: '主日志' })],
    ['logs.actions', () => pruneDaily({ dir: logs, re: ACTIONS_RE, now, label: '动作流水' })],
    [
      'logs.toolOutput',
      () =>
        pruneByAge({
          dir: logs,
          re: TOOL_OUTPUT_RE,
          keepMin: OUTPUT_KEEP_MIN,
          now,
          label: '工具大输出',
        }),
    ],
    [
      'events',
      () => pruneDaily({ dir: dirs.events ?? DIRS.events, re: EVENTS_RE, now, label: '事件流' }),
    ],
    [
      'crash',
      () =>
        pruneByAge({
          dir: dirs.crash ?? DIRS.crash,
          re: /\.dmp$/i,
          keepMin: CRASH_KEEP_MIN,
          now,
          label: '崩溃转储',
        }),
    ],
    ['promptDiag', () => diagRetention.pruneOrphanDiags({ dirs })],
    /*
     * token 指标（问题 4）：写的时候也会轮转（`recordRequest` 里那道），
     * 这里补一次「启动时也看一眼」—— 上次跑完正好压线、之后又没发过请求的话，
     * 那个大文件会一直躺到下一次请求。返回形状和别的步骤对齐（ok + removed + kept）。
     */
    [
      'logs.metrics',
      () => {
        const file = path.join(logs, 'token-metrics.jsonl')
        const rotated = rotateFile(file, 0)
        return { ok: true, removed: rotated ? [path.basename(`${file}.1`)] : [], kept: rotated ? 1 : 0 }
      },
    ],
  ]
  for (const [key, run] of steps) {
    try {
      out[key] = run()
    } catch (error) {
      /* 双保险：上面每个函数自己都不抛，这里再兜一层（验收要求「清理抛错也要能起」） */
      log.warn(`启动清理 ${key} 失败：${error instanceof Error ? error.message : error}`)
      out[key] = { ok: false, removed: [], kept: 0, reason: String(error) }
    }
  }
  return out
}

module.exports = {
  KEEP_DAYS,
  CRASH_KEEP_MIN,
  OUTPUT_KEEP_MIN,
  METRICS_MAX_BYTES,
  MAIN_LOG_RE,
  ACTIONS_RE,
  EVENTS_RE,
  TOOL_OUTPUT_RE,
  pruneDaily,
  pruneByAge,
  rotateFile,
  pruneAll,
}

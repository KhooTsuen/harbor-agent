/**
 * 内核：会话诊断快照的清理（审计问题 10）
 *
 * `core/context-diag.cjs` 每轮往 `data/cache/prompt-diag/<sessionId>.json` 写一份分层
 * 诊断快照（每会话只留最后一份）。它**只写不删** —— 会话删了，快照就成了孤儿。
 *
 * 两条清理路径：
 *   ① 删会话时顺手删那一份（`session-write.remove`）—— 主路径，见下；
 *   ② 启动时扫一遍「没有主的」（本模块的 `pruneOrphanDiags`）—— 兜这次修复**之前**
 *      留下的孤儿，以及「会话文件被别的方式删掉」的情况。
 *
 * 从 `data-retention.cjs` 拆出来的（那边加完保留策略过 300 行了）。拆法按职责：
 * 那边管「按天/按年龄的文件，谁也不认识谁」；这里管的是**要跟会话对账**的那一种。
 *
 * 三条自我约束照抄 `error-retention.cjs`：
 *   1. **只删自己写的名字**：只认 `<sess_…>.json` 这个形状（别的名字一律不碰）；
 *   2. **读不到会话目录时不动手**（读不到 ≠ 全都没了）；
 *   3. **删了要留痕**。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')

/** 快照文件名的形状（去掉 `.json` 之后必须长这样才认） */
const SNAP_ID_RE = /^sess_[a-z0-9]+$/

/**
 * 快照路径（`cache/prompt-diag/<id>.json`）。
 *
 * ★ 必须和 `context-diag.cjs` 的 `snapFile()` **逐字一致**：那边只写，删的两处
 *   在这里与 `session-write.remove`。一致不是靠注释，是靠测试钉的 ——
 *   `batch4Retention.test.ts` 里真调 `contextDiag.diagnose()` 写一份快照，
 *   再删会话，断言那个文件**真的没了**（路径算错就红）。
 *   id 能走到这里必过 `session-io.fileFor` 的白名单（`sess_` + 小写字母数字），
 *   所以那边 `[^\w.-] → _` 的净化对我们是恒等变换。
 */
function snapPathFor(id) {
  return path.join(DIRS.chatCache, 'prompt-diag', `${String(id)}.json`)
}

/** 删掉一个会话的快照（删不掉也不影响删会话） */
function removeSnap(id) {
  try {
    fs.rmSync(snapPathFor(id), { force: true })
  } catch {
    /* 一个几 KB 的快照清不掉，不该影响主流程 */
  }
}

/**
 * 删掉「没有主」的快照。
 *
 * @param {{now?: number, label?: string, dirs?: {chatCache?: string, sessions?: string}}} [options]
 *   `dirs` 是给测试留的口子（照 `error-retention.prune({dir})` 的先例）。
 * @returns {{ok: boolean, removed: string[], kept: number, reason?: string}} 绝不抛
 */
function pruneOrphanDiags({ label = '会话诊断快照', dirs = {} } = {}) {
  try {
    const dir = path.join(dirs.chatCache ?? DIRS.chatCache, 'prompt-diag')
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return { ok: true, removed: [], kept: 0, reason: '目录还不存在' }
    }

    let alive
    try {
      alive = new Set(
        fs.readdirSync(dirs.sessions ?? DIRS.sessions).map((n) => n.replace(/\.jsonl$/, '')),
      )
    } catch {
      return { ok: true, removed: [], kept: 0, reason: '会话目录读不到，这一轮不动手' }
    }

    const removed = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!SNAP_ID_RE.test(id) || alive.has(id)) continue
      try {
        fs.unlinkSync(path.join(dir, name))
        removed.push(id)
      } catch {
        /* 占用/权限删不掉就算了，下次启动还会来 */
      }
    }
    if (removed.length > 0) {
      log.warn(`清理${label}：删了 ${removed.length} 个无主快照（会话已经不在了）`)
    }
    return { ok: true, removed, kept: names.length - removed.length }
  } catch (error) {
    /* 清理失败绝不影响启动 */
    log.warn(`清理${label}失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, removed: [], kept: 0, reason: String(error) }
  }
}

module.exports = { SNAP_ID_RE, snapPathFor, removeSnap, pruneOrphanDiags }

/**
 * 回滚前的「覆盖冲突」判定 + 整批回滚的执行体
 *
 * 为什么单独一个文件：`changeset.cjs` 已经贴到 300 行红线，判定 + 执行塞进去必破线；
 * 而且「什么算冲突」这条判据要能被自检单独钉住，不跟写 meta 的细节混在一起。
 *
 * ⚠️ 这条判据只服务 **整批撤销**（`changeset.rollback(id)`，界面上那个「撤销」按钮）。
 * 「撤到某个检查点」走 `changeset-rollback.cjs`，那边**没有**这套保护 —— 见本轮交付报告
 * 的「已知遗留」。
 *
 * ★ 为什么需要它（2026-11-06 隔离探针实测的现状）：`rollback()` 以前拿到快照就无条件写回。
 *   于是「11 月 1 日那次事务」的快照，可以盖掉此后任何合法改动 —— 探针里同一个文件
 *   被更晚的两次（已提交、且用户认可的）改动改过，点一下撤销就回到旧内容，界面上只报
 *   「已撤销，恢复 1 个」，看不出丢了什么。
 *
 * ★ 判据分三条，逐文件独立判，任一命中就**一个字都不写盘**：
 *   A `later_changeset` —— 另一个**没被撤回**的事务也在 `record()` 过同一个文件，
 *      而且记的时刻更晚 → 磁盘上现在那份很可能是它的成果，不是本事务的。
 *      这条不依赖文件系统时间戳，所以对「事务一直 open、之后又跑了很多轮」的
 *      过期事务（`cs_mvchkbew_1t4v` 那种）也有效。
 *   B `modified_after` —— 文件 mtime 晚于本事务**最后一次活动**（committed 的 `finishedAt` /
 *      已撤过的 `rolledBackAt`）+ 1 秒容差 → 事务收尾之后有别的程序（多半是用户）
 *      动过它。
 *   C `deleted_after` / `recreated` —— 本来存在的文件现在不见了（撤销会把它重建回来），
 *      或者事务**新建**的文件被删掉又重新建了一份新的（撤销会把用户那份删掉）。
 *
 * ★ 为什么 open 状态的事务**不比 mtime**（这条很容易写错）：
 *   `record()` 是在写文件**之前**调用的，所以 open 事务里文件的 mtime 天然晚于
 *   `startedAt`；一个跑了几分钟的任务，其 mtime 更是远晚于 `startedAt`。拿它当
 *   「事后被改过」的证据，会把**正常任务失败后的整批撤销**全部拦下来 —— 那正是
 *   「不许破坏现有恢复能力」要保的东西。
 *   所以 B / C 只对**有结束时刻**的事务生效（committed / rolled-back）；open 事务只用 A。
 *   界面也只列 `committed` 的事务（`useTaskStore.ts`），open 事务本来点不到。
 *
 * ★ `force: true` = 用户在确认卡上看过冲突清单、仍然要撤。这时行为与今天逐字节一致。
 */

const fs = require('node:fs')
const path = require('node:path')
const log = require('./log.cjs')

/*
 * mtime 与「事务收尾时刻」之间允许的偏差。
 *
 * ★ 这 50ms 不是拍脑袋，是量出来的（`tmp/probe-mtime-grain.cjs`，40 次采样）：
 *   Windows 上 `writeFileSync` 返回后，文件 mtime 会比那一刻的 `Date.now()` **大**
 *   0.1~1.2ms（40 次里 21 次 ≥1ms，最大值 1.17ms）。这是 NTFS 时间戳与系统时钟
 *   采样粒度不同造成的，不是 bug。
 *   于是「取整到毫秒再比」也不够干净 —— 66 组（`rollback(id)` 老行为）实测被误拦过一次：
 *   老老实实提交的事务，因为它自己那次写入的 mtime 比 finishedAt 大了不到 1ms。
 *   50ms 既是这个偏差的 40 倍余量，又远小于人点一次「撤销」所需的动作
 *   （打开面板、找到那一行、按下按钮），所以它带来的盲区在真实使用里不存在。
 *
 * ★ 盲区如实记：**事务收尾后 50ms 内**别人对文件做的改动判不出来。
 *   要根除它得在 meta 里记「写后内容指纹」—— 那要改数据结构，本次按拍板不做。
 */
const MTIME_SLACK_MS = 50

/**
 * 判据：文件 mtime 是否落在「事务最后一次活动」之后（超过容差才算）。
 *
 * 两个方向代价不对称：漏判 = 静默覆盖用户的改动（数据没了）；
 * 误判 = 多弹一张确认卡（点一下就撤）。所以容差只开到能盖住时钟粒度的程度 ——
 * 试过 1 秒，探针里「事后被改 / 被删 / 被重建」全漏掉了。
 */
function laterThanSettled(mtimeMs, settled) {
  return mtimeMs > settled + MTIME_SLACK_MS
}

/** 事务最后一次「动过盘」的时刻；还在跑（open）的返回 0 —— 表示不参与 mtime 判定 */
function settledAt(meta) {
  const finished = Number(meta.finishedAt) || 0
  const rolledBack = Number(meta.rolledBackAt) || 0
  return Math.max(finished, rolledBack)
}

/** 目录里其它事务的 meta（排除自己、排除已撤回的） */
function siblingMetas(selfId) {
  /* 惰性 require：changeset.cjs 顶层 require 本文件，直接引用会拿到没赋值的空导出 */
  const changeset = require('./changeset.cjs')
  let names = []
  try {
    names = fs.readdirSync(changeset.root()).filter((name) => name.startsWith('cs_'))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (name === selfId) continue
    const meta = changeset.readMeta(name)
    if (!meta || !Array.isArray(meta.files)) continue
    /* 已经整批撤回去的事务，它的文件内容不再是「后来的改动」 */
    if (meta.status === 'rolled-back') continue
    out.push(meta)
  }
  return out
}

/** 这个文件在别的（没被撤回的）事务里、且记得比 `at` 晚吗？返回那个事务 id */
function laterWriter(siblings, file, at) {
  for (const meta of siblings) {
    for (const entry of meta.files) {
      if (entry.path !== file) continue
      const theirAt = Number(entry.at) || Number(meta.startedAt) || 0
      if (theirAt > at) return meta.id
    }
  }
  return ''
}

/** 单个文件的冲突（没有冲突返回 null） */
function conflictOf(entry, meta, siblings, settled) {
  const ownAt = Number(entry.at) || Number(meta.startedAt) || 0

  /* A：更晚的事务也动过这个文件 —— 所有状态都判 */
  const later = laterWriter(siblings, entry.path, ownAt)
  if (later) {
    return {
      path: entry.path,
      kind: 'later_changeset',
      reason: `这个文件之后又被另一次改动（${later}）改过，撤销会把那次改动一起盖掉`,
      detail: later,
    }
  }

  /* 还在跑（open）的事务不参与后面两条 —— 见文件头「为什么 open 不比 mtime」 */
  if (!settled) return null

  let stat = null
  try {
    stat = fs.statSync(entry.path)
  } catch {
    stat = null
  }

  if (!stat) {
    if (!entry.existed) return null /* 事务新建的、现在也没有 → 撤销无事可做 */
    return {
      path: entry.path,
      kind: 'deleted_after',
      reason: '这个文件在事务结束之后已经被删掉了，撤销会把旧内容重新建回来',
      detail: '',
    }
  }

  if (laterThanSettled(stat.mtimeMs, settled)) {
    return entry.existed
      ? {
          path: entry.path,
          kind: 'modified_after',
          reason: '这个文件在事务结束之后又被改过，撤销会覆盖掉那段改动',
          detail: new Date(stat.mtimeMs).toISOString(),
        }
      : {
          path: entry.path,
          kind: 'recreated',
          reason: '这个文件是那次改动新建的，之后被删掉又重新建了一份，撤销会删掉现在这份',
          detail: new Date(stat.mtimeMs).toISOString(),
        }
  }

  return null
}

/**
 * 算一遍「这次撤销会盖掉什么」。**纯读**：不写盘、不改 meta。
 *
 * @param {string} id 事务 id
 * @param {object} meta 已经读出来的 meta（调用方刚读过，别再读一遍）
 * @returns {Array<{path: string, kind: string, reason: string, detail: string}>}
 */
function inspect(id, meta) {
  if (!meta || !Array.isArray(meta.files) || meta.files.length === 0) return []
  const siblings = siblingMetas(id)
  const settled = settledAt(meta)
  const out = []
  for (const entry of meta.files) {
    const hit = conflictOf(entry, meta, siblings, settled)
    if (hit) out.push(hit)
  }
  return out
}

/**
 * 整批回滚。三类都要处理：① 改过的 → 写回快照 ② 新建的 → 删掉 ③ 没快照的（太大）→ 明确告诉用户
 *
 * @param {string} id 事务 id
 * @param {{force?: boolean}} [options] `force` = 用户已经看过冲突清单、确认要覆盖
 * @returns {{ok: boolean, blocked?: boolean, forced?: boolean, conflicts?: object[],
 *            restored: string[], removed: string[], failed: object[], error?: string}}
 */
function rollback(id, options = {}) {
  const changeset = require('./changeset.cjs')
  const key = String(id ?? '')
  const meta = changeset.readMeta(key)
  if (!meta) return { ok: false, error: '事务不存在', restored: [], removed: [], failed: [] }

  const force = options?.force === true
  if (!force) {
    const conflicts = inspect(key, meta)
    if (conflicts.length > 0) {
      /* 一个字都不写：不碰文件、不改 meta.status —— 用户取消之后这条事务还撤得动 */
      log.info(`撤销被拦下（会覆盖 ${conflicts.length} 个文件的新改动）：${key}`)
      return { ok: true, blocked: true, forced: false, conflicts, restored: [], removed: [], failed: [] }
    }
  }

  const restored = []
  const removed = []
  const failed = []

  for (const entry of meta.files) {
    try {
      if (!entry.existed) {
        if (fs.existsSync(entry.path)) fs.rmSync(entry.path, { force: true })
        removed.push(entry.path)
        continue
      }

      if (!entry.snapshot || !entry.snap) {
        failed.push({ path: entry.path, reason: entry.reason ?? '没有快照' })
        continue
      }

      const content = fs.readFileSync(path.join(changeset.root(), key, 'files', entry.snap), 'utf8')
      fs.mkdirSync(path.dirname(entry.path), { recursive: true })
      fs.writeFileSync(entry.path, content, 'utf8')
      restored.push(entry.path)
    } catch (error) {
      failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  meta.status = 'rolled-back'
  meta.rolledBackAt = Date.now()
  changeset.writeMeta(key, meta)

  log.info(
    `改动事务回滚${force ? '（用户确认覆盖）' : ''}：恢复 ${restored.length} 个，` +
      `删除 ${removed.length} 个，失败 ${failed.length} 个`,
  )
  return { ok: true, blocked: false, forced: force, restored, removed, failed }
}

module.exports = { rollback, inspect, laterThanSettled, MTIME_SLACK_MS }

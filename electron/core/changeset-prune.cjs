/**
 * 改动事务的清理（从 `changeset.cjs` 拆出来的）
 *
 * ── 为什么拆 ──
 *
 * `changeset.cjs` 本来就在 300 行红线上。加「存量要用户批准」这层判定得更长，
 * 所以按职责切：这边只管「哪些该删 / 删不删 / 删了报什么」，`changeset.cjs`
 * 仍持有 `root()` / `readMeta()`（判据不重写一份，惰性 require 它）。
 * 与 `backup-prune.cjs` 同一套拆法。
 *
 * ── 两条不能省的保护（2026-11-07：真机 1128 个事务 / 116MB，从没被清过）──
 *
 *   ① **`open` 的一个都不删** —— 那是正在跑的任务的回滚凭据，删了 commit 会失败。
 *   ② **删了什么要说出来**（`names` + 一条日志）—— 删数据不能静默。
 *
 * ── 第三层：**存量要问过**（2026-11-07 补）──
 *
 * 上一轮把它接进了启动链，代价是：下次启动会一口气删掉 1078 个用户没批过的事务。
 * 现在一次要删超过 `SAFE_BATCH.changesets` 就只盘点、不删，等用户批准
 * （判据在 `retention-guard.cjs`，那边是唯一真相源）。
 */

const fs = require('node:fs')
const log = require('./log.cjs')
const guard = require('./retention-guard.cjs')

/** 一个事务目录占多少字节（不递归算文件内容，够了 —— 主要成本是快照文件数） */
function dirBytes(full) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const sub = `${full}/${entry.name}`
      try {
        total += entry.isDirectory() ? dirBytes(sub) : fs.statSync(sub).size
      } catch {
        /* 读不到就不算 */
      }
    }
  } catch {
    /* 目录没了 */
  }
  return total
}

/**
 * 只算不删：哪些会进删除名单、有几个进行中的要留着。
 *
 * @param {number} [keep] 保留多少个已关闭的事务
 */
function planPrune(keep = 50) {
  const cs = require('./changeset.cjs')
  let names = []
  try {
    names = fs.readdirSync(cs.root()).filter((name) => name.startsWith('cs_')).sort()
  } catch {
    return { stale: [], keptOpen: 0, keep, bytes: 0 }
  }

  /* 先分拣：open 的一律留着；已关闭的才参与「保留最近 N 个」 */
  const closed = []
  let keptOpen = 0
  for (const id of names) {
    const meta = cs.readMeta(id)
    if (meta?.status === 'open') {
      keptOpen += 1
      continue
    }
    closed.push(id)
  }

  const stale = closed.slice(0, Math.max(0, closed.length - keep))
  const bytes = stale.reduce((sum, id) => sum + dirBytes(cs.dirFor(id)), 0)
  return { stale, keptOpen, keep, bytes }
}

/**
 * 清理旧的（保留最近 N 个已关闭的事务）。
 *
 * @param {number} [keep] 保留多少个已关闭的事务
 * @returns {{ ok: boolean, removed: number, names: string[], keptOpen: number,
 *             pending?: number, bytes?: number }}
 */
function prune(keep = 50) {
  const cs = require('./changeset.cjs')
  const plan = planPrune(keep)
  const would = plan.stale.length

  if (guard.decide({ key: 'changesets', would }) === 'report') {
    guard.notePending({ key: 'changesets', items: plan.stale, bytes: plan.bytes })
    log.warn(
      `改动事务积压 ${would} 个（约 ${Math.round(plan.bytes / 1048576)}MB），` +
        '超过一次能清的量 —— 只记清单，一个都没删。清单在 data/retention-pending.json',
    )
    return { ok: true, removed: 0, names: [], keptOpen: plan.keptOpen, pending: would, bytes: plan.bytes }
  }

  const removed = []
  for (const id of plan.stale) {
    try {
      fs.rmSync(cs.dirFor(id), { recursive: true, force: true })
      removed.push(id)
    } catch {
      /* 删不掉就算了（下次启动还会来） */
    }
  }
  if (removed.length > 0) {
    log.warn(
      `清理改动事务：删了 ${removed.length} 个（保留最近 ${keep} 个；另有 ${plan.keptOpen} 个进行中的没动）`,
    )
  }
  return { ok: true, removed: removed.length, names: removed, keptOpen: plan.keptOpen }
}

module.exports = { planPrune, prune }

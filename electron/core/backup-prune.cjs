/**
 * 自动备份：**清理超量的旧备份**（从 `backup.cjs` 拆出来的）
 *
 * ── 为什么单独一个文件 ──
 *
 * `backup.cjs` 加完这 30 行到了 325 行（硬约束 #2 是 300）。按职责切最省事：
 * 这边只做「哪些能删 / 删掉」，`list` 与 `KEEP` 仍从 `backup-scan.cjs` 拿
 * —— 判据不重写一份（那边已经是唯一真相源）。
 *
 * ── 这轮为什么要补（2026-11-07 真机实测）──
 *
 * `prune()` 只在 `create()` 末尾调。而 `maybeAuto()` 每 24 小时才真备一次，
 * 中间几十次启动全是「今天已经备过了」→ `create()` 不跑 → `prune()` **永不执行**。
 * 真机攒到 **12 份 / 3556MB**（`KEEP` = 10），多出来的那两份一直躺着。
 *
 * 所以清理要能**独立被启动链调**，不能挂在「这次真备了一份」后面。
 *
 * ── 哪些不删（两条都不许省）──
 *
 *   ① **没有 `meta.json` 的**：那是「正在写」或「用户自己拷进来的」——
 *      前者删了等于毁掉一次备份，后者是用户留的退路。宁可多占一个位置。
 *      真机上就有一份手工拷进来的 `20261107-021212`（无 meta）。
 *   ② **最新的 `KEEP` 份**：留足回退点（`KEEP` 在 `backup-scan.cjs`）。
 *
 * 删了什么写进主日志 —— 删用户数据这件事不能静默。
 */

const fs = require('node:fs')
const log = require('./log.cjs')
/* 清单与排序都在那边（唯一真相源）。惰性不必要：backup-scan 不 require 本文件 */
const { KEEP, list } = require('./backup-scan.cjs')

/**
 * 把超量的旧备份删掉。
 *
 * @param {{ root?: string, keep?: number }} [options]
 *   `root` / `keep` 只给测试注入；生产不传 = 真实备份目录 + `backup-scan` 的 `KEEP`。
 * @returns {{ ok: boolean, removed: string[], skipped: string[], kept: number }}
 */
function pruneBackups({ root, keep } = {}) {
  const limit = Number.isFinite(keep) ? Number(keep) : KEEP
  const all = list(root)
  const removed = []
  const skipped = []
  for (const old of all.slice(limit)) {
    if (!Array.isArray(old.items) || old.items.length === 0) {
      /* 没 meta = 来路不明（正在写 / 手工拷的），不动 */
      skipped.push(old.name)
      continue
    }
    try {
      fs.rmSync(old.path, { recursive: true, force: true })
      removed.push(old.name)
    } catch (error) {
      log.warn(`删旧备份失败 ${old.name}：${error instanceof Error ? error.message : error}`)
    }
  }
  if (removed.length > 0) log.warn(`清理旧备份：删了 ${removed.length} 份（保留最近 ${limit} 份）`)
  if (skipped.length > 0) log.info(`这几份没有 meta.json，不当作可清理对象：${skipped.join(', ')}`)
  return { ok: true, removed, skipped, kept: limit }
}

module.exports = { pruneBackups }

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
 * ── 哪些不删（2026-11-07 修正判据）──
 *
 * 判据是**有没有内容**，不是**有没有 meta.json**。
 *
 * 上一轮写的是「没有 `meta.json` 的一律不动」，真机一盘点就发现判错了：
 * Dev 那台 11 份备份里有 **7 份没有 meta.json**，但它们并不是「正在写」或「手工拷的」
 * —— 是**老版本创建的完整备份**（`meta.json` 是后来才加的字段），内容一项不缺
 * （sessions / changesets / tasks 全在）。按旧判据它们被永久保护，
 * 于是 `KEEP=10` 的名额被它们占着、真正参与轮换的只有 4 份，增长根本没治住。
 *
 * 现在的两条：
 *   ① **`empty === true`（一个用户项都没有）的不删** —— 空壳 / 正在写的那一份。
 *      这是「别把未完成、正在写入的备份当成可删对象」的落地。
 *   ② **最新的 `KEEP` 份**：留足回退点（`KEEP` 在 `backup-scan.cjs`）。
 *      `list()` 已按 `mtime` 倒序排，老格式新格式一视同仁。
 *
 * 名字不是时间戳形状的（如手工拷的 `hotfix-tool-history-20261021`）在 `list()`
 * 那一步就被白名单滤掉了，根本进不来 —— 这一层不需要再判一次。
 *
 * 删了什么写进主日志 —— 删用户数据这件事不能静默。
 */

const fs = require('node:fs')
const log = require('./log.cjs')
/* 清单与排序都在那边（唯一真相源）。惰性不必要：backup-scan 不 require 本文件 */
const { KEEP, list } = require('./backup-scan.cjs')
/* 存量要问过用户（判据在那边，见它的文件头） */
const guard = require('./retention-guard.cjs')

/**
 * 只算不删：哪几份进删除名单、哪几份要留着。
 *
 * @param {{ root?: string, keep?: number }} [options]
 */
function planPrune({ root, keep } = {}) {
  const limit = Number.isFinite(keep) ? Number(keep) : KEEP
  const candidates = []
  const skipped = []
  /*
   * ★ `sizes: 'cache'`（2026-11-08）：这里只需要名字、顺序、`empty`、路径。
   *   体积仅用于「预计能回收多少」的提示，有缓存就用、没有就先当 0。
   *   走默认的 `list()` 会为了算体积递归 statSync 两万多个文件 ——
   *   启动清理链上白卡 6~7 秒，而它根本不需要那个数字。
   */
  for (const old of list(root, { sizes: 'cache' }).slice(limit)) {
    /*
     * 判据是**有没有内容**，不是有没有 meta.json —— 老版本创建的备份没有 meta，
     * 但内容齐全（见文件头「2026-11-07 修正判据」）。
     * `empty` 由 `list()` 算（按 `ITEMS` 逐项查），空壳/正在写的那份才会是 true。
     */
    if (old.empty === true) {
      skipped.push(old)
      continue
    }
    candidates.push(old)
  }
  return { limit, candidates, skipped }
}

/**
 * 把超量的旧备份删掉。
 *
 * @param {{ root?: string, keep?: number }} [options]
 *   `root` / `keep` 只给测试注入；生产不传 = 真实备份目录 + `backup-scan` 的 `KEEP`。
 * @returns {{ ok: boolean, removed: string[], skipped: string[], kept: number,
 *             pending?: number, bytes?: number }}
 */
function pruneBackups(options = {}) {
  const plan = planPrune(options)
  const skipped = plan.skipped.map((old) => old.name)
  const would = plan.candidates.length
  const bytes = plan.candidates.reduce((sum, old) => sum + (Number(old.size) || 0), 0)

  if (guard.decide({ key: 'backups', would }) === 'report') {
    guard.notePending({ key: 'backups', items: plan.candidates.map((old) => old.name), bytes })
    log.warn(
      `旧备份积压 ${would} 份（约 ${Math.round(bytes / 1048576)}MB），超过一次能清的量 —— ` +
        '只记清单，一份都没删。清单在 data/retention-pending.json',
    )
    return { ok: true, removed: [], skipped, kept: plan.limit, pending: would, bytes }
  }

  const removed = []
  for (const old of plan.candidates) {
    try {
      fs.rmSync(old.path, { recursive: true, force: true })
      removed.push(old.name)
    } catch (error) {
      log.warn(`删旧备份失败 ${old.name}：${error instanceof Error ? error.message : error}`)
    }
  }
  if (removed.length > 0) log.warn(`清理旧备份：删了 ${removed.length} 份（保留最近 ${plan.limit} 份）`)
  if (skipped.length > 0) log.info(`这几份没有 meta.json，不当作可清理对象：${skipped.join(', ')}`)
  return { ok: true, removed, skipped, kept: plan.limit }
}

module.exports = { planPrune, pruneBackups }

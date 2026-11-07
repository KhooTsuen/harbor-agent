/**
 * 内核：**用户数据**侧的保留期（audit / changesets）
 *
 * ── 为什么单独一个文件 ──
 *
 * `data-retention.cjs` 管的是**诊断产物**（logs / events / crash / tool-output）——
 * 删了不影响用户能不能把活干完。这里两样不一样：
 *
 *   · `audit`      —— 审计流水，删了事后查不到「谁批准了什么」；
 *   · `changesets` —— **回滚凭据**，删了那次改动就撤不回去。
 *
 * 所以判据也不同：那边是「保留 N 天」，这边是「保留 N 个」+ **进行中的一个都不动**。
 * 混在一个文件里迟早把两种口径搅在一起，而这两样都是不可重建的东西。
 *
 * ── 这轮为什么要补（2026-11-07 真机实测）──
 *
 * 两个 `prune()` 都**只有手动 IPC 在调**（`audit:prune` / 界面上那个按钮），
 * 启动清理链里一个都没有。于是 Dev 那台机器上攒下：
 *
 *   audit       29 个文件 / 134MB，其中 3 个已过 30 天保留期（17MB）
 *   changesets  1128 个事务 / 116MB，按 `prune(50)` 该只剩 50 个
 *
 * 这是「机制写了但没人调」的典型：代码看着有，行为上等于没有。
 *
 * ── 三条纪律（照抄 `data-retention.cjs` / `error-retention.cjs`）──
 *
 *   1. **绝不抛**：清理只是省空间，不是功能；失败记一行 warn 就回去。
 *   2. **不删进行中的**：`changeset.prune` 内部跳过 `status === 'open'`。
 *   3. **删了要留痕**：数量与保留期写进主日志（两边各自会记）。
 */

const log = require('./log.cjs')

/** 已关闭的改动事务留多少个 —— 够回退最近几十轮，又不至于攒成 GB */
const CHANGESET_KEEP = 50

/**
 * 审计日志：超过保留期的那几天删掉。
 *
 * 保留期由 `audit.cjs` 自己读 `config.audit.retentionDays`（唯一真相源，别在这再读一次）。
 *
 * @returns {{ ok: boolean, removed: number, reason?: string }}
 */
function pruneAudit() {
  try {
    return require('./audit.cjs').prune()
  } catch (error) {
    log.warn(`清理审计日志失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, removed: 0, reason: String(error) }
  }
}

/**
 * 改动事务：只留最近 `keep` 个**已关闭**的，`open` 的一个都不动。
 *
 * @param {number} [keep]
 * @returns {{ ok: boolean, removed: number, names: string[], keptOpen: number, reason?: string }}
 */
function pruneChangesets(keep = CHANGESET_KEEP) {
  try {
    const r = require('./changeset.cjs').prune(keep)
    return { ok: r.ok, removed: r.removed, names: r.names ?? [], keptOpen: r.keptOpen ?? 0 }
  } catch (error) {
    log.warn(`清理改动事务失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, removed: 0, names: [], keptOpen: 0, reason: String(error) }
  }
}

/**
 * 那几步，拼成和 `data-retention.pruneAll` 里别的步骤**同形状**的 `[key, run]`。
 *
 * 为什么形状要对齐：`pruneAll` 会对每一步单独 try，并按 `{ok, removed, kept, reason}`
 * 收结果。这里返回的形状必须能直接塞进那张表 —— 否则日志里会出现两种形状，
 * 出了问题先得猜是哪一半。
 *
 * @param {{ changesetKeep?: number }} [options] 测试用口子
 * @returns {Array<[string, () => object]>}
 */
function steps({ changesetKeep } = {}) {
  return [
    [
      'audit',
      () => {
        const r = pruneAudit()
        /*
         * 形状对齐：`audit.prune()` 原本的契约是 `removed: <数字>`（`audit:prune` 那个
         * IPC 与界面照它渲染，不能改）。但 `pruneAll` 里别的步骤 `removed` 都是
         * **文件名数组** —— 两种形状混在一张表里，日志对不上、排查先得猜是哪一半。
         * 所以这里包一层：数组仍给空（它本来就不返回名字），数量另开 `count`。
         */
        return { ok: r.ok, removed: [], count: r.removed, reason: r.reason ?? '' }
      },
    ],
    [
      'changesets',
      () => {
        const r = pruneChangesets(changesetKeep)
        return {
          ok: r.ok,
          removed: r.names ?? [],
          kept: r.removed,
          /* 进行中的没动 —— 这个数字要透出来，否则「只删了 3 个」看着像没干活 */
          reason: r.keptOpen ? `${r.keptOpen} 个进行中没动` : '',
        }
      },
    ],
    /*
     * 自动备份（2026-11-07 补）：`backup.prune()` 只在 `create()` 末尾跑，
     * 而 `maybeAuto()` 每 24 小时才真备一次 —— 中间几十次启动全是「今天已经备过了」，
     * `create()` 不跑，prune 就永不执行。真机攒到 12 份 / 3556MB（KEEP=10）。
     */
    [
      'backups',
      () => {
        const r = require('./backup-prune.cjs').pruneBackups()
        return { ok: r.ok, removed: r.removed, kept: undefined, reason: r.skipped.length ? `${r.skipped.length} 份没有 meta，没动` : '' }
      },
    ],
  ]
}

module.exports = { CHANGESET_KEEP, pruneAudit, pruneChangesets, steps }


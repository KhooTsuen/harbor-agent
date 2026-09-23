/**
 * 回退到指定检查点（rollbackTo）—— 撤到「某一刻」为止
 *
 * 与 `changeset.rollback(id)` 的分工：后者是**整批**撤（一个事务里改的全撤回去，
 * 不分先后），这条是**撤到某一刻为止**：
 *
 *   事务 A（第 1 轮的改动）── 检查点 ①② ── 事务 B（第 2 轮的改动）
 *        ↑ 留着（检查点之前的）                 ↑ 撤掉（检查点之后的）
 *
 * 用户的话是「刚才那几步白改了，退回到这个检查点」—— 就是这条。
 *
 * ★ 实现方式由**现有数据结构**决定（不是设计出来的，先读了才有这两个事实）：
 *   · checkpoint = `{ at, label, note, files, commands }` —— **本来就没有 id**。
 *     所以 checkpointId 优先按 `at`（毫秒时间戳，稳定）认，其次按数组下标认；
 *     台账只留最近 50 个检查点（task-notes.cjs），下标会被截断挪位，只当兜底。
 *   · changeset 的 meta 有 `startedAt` / `finishedAt`，而且**每个文件**都带
 *     记录时刻 `files[].at`（`record()` 是「动它之前」调用的）。
 *   判据于是是：**文件快照的记录时刻晚于检查点** = 这个改动发生在检查点之后。
 *
 * 三条边界（都写在这里，别指望从代码猜）：
 *   ① 检查点之前的改动**一定不动**。若一个文件在检查点之前就改过、之后又改了
 *      一次（`record()` 去重只留第一次的快照），**这一轮不碰它**，只列进 `skipped`
 *      —— 拿旧快照回退会把检查点之前的改动也一起撤掉，那是毁约。
 *   ② 跨检查点的事务（同一事务里既有检查点之前、又有之后的改动）：只恢复后者，
 *      并且**不**把这个事务标成「已回滚」—— 否则之后想撤剩下那几个就撤不动了。
 *   ③ 单个文件恢复失败（快照丢了 / 太大没快照）→ 进 `failed`，其余照常恢复，
 *      **不许悄悄少文件**。
 */

const fs = require('node:fs')
const path = require('node:path')
const log = require('./log.cjs')

/** 失败也保持 `{ ok, restored, removed, failed }` 这个形状（界面照它渲染） */
function failure(error) {
  return { ok: false, error, restored: [], removed: [], failed: [], skipped: [], changesets: [] }
}

/**
 * 把传进来的 checkpointId 认成台账里的一个检查点。
 *
 * 先按 `at` 精确匹配（推荐写法：不受 50 条截断影响），认不出来再当下标用
 * —— 界面遍历 `task.checkpoints` 时的顺手写法，也能用，但会随截断挪位。
 */
function resolveCheckpoint(list, rawId) {
  const text = String(rawId ?? '').trim()
  if (!text) return { error: '没有给检查点 id' }
  const byAt = list.findIndex((item) => String(item?.at ?? '') === text)
  if (byAt >= 0) return { index: byAt, checkpoint: list[byAt] }
  const index = Number(text)
  if (Number.isInteger(index) && index >= 0 && index < list.length) {
    return { index, checkpoint: list[index] }
  }
  return { error: '没有找到这个检查点' }
}

/** 这个文件的改动发生在检查点之后吗（没记时刻的按「事务开始时刻」估） */
function afterCheckpoint(entry, meta, at) {
  const fileAt = Number.isFinite(entry?.at) ? entry.at : Number(meta.startedAt) || 0
  return fileAt > at
}

/** 恢复一个文件：新建的删掉、改过的写回快照；返回有没有恢复成功 */
function restoreOne(changeset, meta, entry, out) {
  try {
    if (!entry.existed) {
      if (fs.existsSync(entry.path)) fs.rmSync(entry.path, { force: true })
      out.removed.push(entry.path)
      return true
    }
    if (!entry.snapshot || !entry.snap) {
      out.failed.push({ path: entry.path, reason: entry.reason ?? '没有快照' })
      return false
    }
    const content = fs.readFileSync(
      path.join(changeset.root(), String(meta.id), 'files', entry.snap),
      'utf8',
    )
    fs.mkdirSync(path.dirname(entry.path), { recursive: true })
    fs.writeFileSync(entry.path, content, 'utf8')
    out.restored.push(entry.path)
    return true
  } catch (error) {
    out.failed.push({
      path: entry.path,
      reason: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * 回退到某个检查点：撤销该检查点**之后**的改动，之前的不动。
 *
 * @param {string} taskId 任务 id（台账里的那条）
 * @param {string|number} checkpointId 检查点的 `at`（推荐）或数组下标
 * @returns {{ ok: boolean, error?: string, restored: string[], removed: string[],
 *            failed: Array<{path: string, reason: string}>,
 *            skipped: Array<{path: string, reason: string}>,
 *            changesets: string[], checkpoint?: {at: number, label: string, index: number} }}
 */
function rollbackTo(taskId, checkpointId) {
  /*
   * 惰性 require：`changeset.cjs` 顶层 require 本文件并转出 rollbackTo，
   * 在顶层 require 回去会拿到还没赋值的 module.exports（循环加载）。
   */
  const changeset = require('./changeset.cjs')
  const tasks = require('./task.cjs')

  const id = String(taskId ?? '').trim()
  if (!id) return failure('没有给任务 id')

  const task = tasks.get(id)
  if (!task) return failure('没有这条任务')

  const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints : []
  if (checkpoints.length === 0) return failure('这条任务还没有检查点')

  const found = resolveCheckpoint(checkpoints, checkpointId)
  if (!found.checkpoint) return failure(found.error)

  const at = Number(found.checkpoint.at) || 0
  const out = { restored: [], removed: [], failed: [], skipped: [], changesets: [] }

  /* list 是「新的在前」：越靠后的改动越先撤，符合「从后往前退」的直觉 */
  for (const summary of changeset.list({ taskId: id, limit: 500 })) {
    const meta = changeset.readMeta(summary.id)
    if (!meta || !Array.isArray(meta.files)) continue
    /* 已经整批撤过的不动它（别把「已回滚」的那批数字再报一遍） */
    if (meta.status === 'rolled-back') continue

    const hits = meta.files.filter((entry) => afterCheckpoint(entry, meta, at))
    /* 整个事务都在检查点之前 → 原样留着，不必多话 */
    if (hits.length === 0) continue

    /* 跨检查点：只撤之后的那几个，之前的那几个**明说没动**（不许悄悄少文件） */
    for (const entry of meta.files) {
      if (!afterCheckpoint(entry, meta, at)) {
        out.skipped.push({
          path: entry.path,
          reason: '这个文件的改动在检查点之前（撤它会把更早的改动一起撤掉）',
        })
      }
    }

    const failedBefore = out.failed.length
    out.changesets.push(meta.id)
    for (const entry of hits) restoreOne(changeset, meta, entry, out)

    /* 整个事务都在检查点之后、而且一个都没失败 → 和 rollback(id) 一样标「已回滚」；
       跨检查点的那种只撤了一部分，状态保持原样（剩下的还撤得动） */
    if (meta.files.length === hits.length && out.failed.length === failedBefore) {
      meta.status = 'rolled-back'
      meta.rolledBackAt = Date.now()
      changeset.writeMeta(meta.id, meta)
    }
  }

  log.info(
    `回退到检查点：恢复 ${out.restored.length} 个文件，删除 ${out.removed.length} 个，` +
      `跳过 ${out.skipped.length} 个，失败 ${out.failed.length} 个`,
  )

  return {
    ok: true,
    restored: out.restored,
    removed: out.removed,
    failed: out.failed,
    skipped: out.skipped,
    changesets: out.changesets,
    checkpoint: { at, label: String(found.checkpoint.label ?? ''), index: found.index },
  }
}

module.exports = { rollbackTo, resolveCheckpoint }

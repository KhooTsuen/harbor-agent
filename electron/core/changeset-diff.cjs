/**
 * 「未提交的改动」算成 diff（AG-036 后半）
 *
 * 右栏「审查」标签一直有界面、却没有数据 —— 类型里有 `message.diffs`，
 * `RightPanel` 也把它汇总渲染，但**真实流程里没有任何地方写过它**（只有演示用的
 * `mockTurn.ts`），于是实机上永远显示「没有待审查的改动」，而那时 Agent 明明刚改过文件。
 *
 * 数据其实一直都在：`changeset` 在每个文件**改动前**存了一份快照（回滚就靠它）。
 * 这里把「快照 vs 磁盘现在的样子」比出来，交给渲染层那套 `DiffViewer`。
 *
 * ── 三种情况都要说清楚 ──
 *   · 改过的文件   → 快照 vs 现在
 *   · 新建的文件   → 没有快照（原来不存在），全是新增
 *   · 被删的文件   → 现在读不到，整篇删除
 *   · 没快照的（太大 / 超上限）→ **不算 diff，但要说一句**，不能悄悄少一个文件
 */

const fs = require('node:fs')
const path = require('node:path')
const changeset = require('./changeset.cjs')
const { diffFile } = require('./diff-text.cjs')

/** 一个文件最多比多少行；再多就按「整块替换」显示（diff-text 自己会退路） */
const MAX_FILES = 50

function snapshotOf(meta, item) {
  if (!item.snapshot || !item.snap) return null
  try {
    return fs.readFileSync(path.join(changeset.root(), meta.id, 'files', item.snap), 'utf8')
  } catch {
    return null
  }
}

function currentOf(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    /* 读不到 = 被删了（也可能是权限/占用 —— 一律按「现在没有这个文件」算并记一句） */
    return null
  }
}

/**
 * 算一个事务的 diff。
 *
 * @param {string} id 事务 id
 * @returns {{ ok: boolean, error?: string, id?: string, title?: string, taskId?: string,
 *             sessionId?: string, status?: string, at?: number, files?: object[],
 *             skipped?: string[], additions?: number, deletions?: number }}
 */
function diffOf(id) {
  const meta = changeset.readMeta(String(id ?? ''))
  if (!meta) return { ok: false, error: '事务不存在' }

  const files = []
  const skipped = []

  for (const item of (meta.files ?? []).slice(0, MAX_FILES)) {
    const before = item.existed ? snapshotOf(meta, item) : ''
    if (item.existed && before === null) {
      skipped.push(`${item.path}（快照读不到）`)
      continue
    }
    const now = currentOf(item.path)
    if (now === null && item.existed) {
      /* 改动之后文件没了 —— 整篇删除，这本身就是要看见的事 */
      files.push(diffFile({ path: item.path, before: before ?? '', after: '' }))
      continue
    }
    if (now === null && !item.existed) {
      /* 新建的又被删了：净效果为零，不用显示 */
      continue
    }
    const diff = diffFile({ path: item.path, before, after: now })
    if (diff.additions === 0 && diff.deletions === 0) continue
    files.push(diff)
  }

  if ((meta.files ?? []).length > MAX_FILES) {
    skipped.push(`另外 ${(meta.files ?? []).length - MAX_FILES} 个文件没显示（一次改太多）`)
  }

  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return {
    ok: true,
    id: meta.id,
    title: meta.title ?? '',
    taskId: meta.taskId ?? '',
    sessionId: meta.sessionId ?? '',
    status: meta.status ?? 'open',
    at: meta.finishedAt || meta.startedAt || 0,
    files,
    additions,
    deletions,
    skipped,
  }
}

/**
 * 最近一次**有改动的**事务的 diff。
 *
 * 不按 status 过滤：跑动中的事务还是 `open`，但那时用户正想看它改了什么
 * （审查标签上写着「生成中…」）。所谓「未提交」在这里就是「最近这一批改动」，
 * 回滚入口（任务中心底部）看的是同一批。
 *
 * @param {{ sessionId?: string, limit?: number }} [options]
 */
function latest({ sessionId = '', limit = 20 } = {}) {
  const list = changeset.list({ limit, sessionId })
  for (const meta of list) {
    /*
     * 「这一批有没有改动」由算出来的 diff 说了算 —— 不再额外看 `meta.files.length`。
     * 两个判断做同一件事，测试就只能证到「两个都拆掉」，而且它们并不等价
     * （记了快照但净变化为零的事务，前者会放行、后者才拦得住）。
     */
    const diff = diffOf(meta.id)
    if (diff.ok && diff.files.length > 0) return diff
  }
  return {
    ok: true,
    id: '',
    title: '',
    taskId: '',
    sessionId: '',
    status: '',
    at: 0,
    files: [],
    additions: 0,
    deletions: 0,
    skipped: [],
  }
}

module.exports = { diffOf, latest, MAX_FILES }

/**
 * 数据目录的 IPC（`dataLocation:get` / `dataLocation:migrate`）
 *
 * 状态语义与风险全在内核：`core/data-location.cjs`（指针为什么必须独立于配置）
 * 与 `core/data-migrate-plan.cjs`（哪些情况必须拒绝）。
 *
 * 这里只做三件事：**查状态 → 挡掉"正在干活时迁移" → 调内核 → 记一行日志**。
 *
 * ── 为什么迁移前要挡「有任务在跑」──────────────────────────
 *
 * 迁移会同步复制整个数据目录（几 GB，主进程被占住几秒到几十秒）。那时正在跑的
 * 任务如果恰好有未落盘的状态，复制出来的就是**半截现场**；而任务本身在复制完
 * 之后还会继续写 —— 它写的是哪个目录取决于那一刻的指针，两边都可能，说不清。
 * 所以只要还有 running 的任务就整体拒绝，让用户先停下来再迁。
 */

const path = require('node:path')
const { DIRS, rootDir, realDataDir, fallbackReason } = require('../core/paths.cjs')
const dataLocation = require('../core/data-location.cjs')
const dataMigrate = require('../core/data-migrate.cjs')
const log = require('../core/log.cjs')

/** 现在有没有东西正在往数据目录里写 */
function busyReasons() {
  const out = []
  try {
    const tasks = require('../core/task.cjs').list({ limit: 9999 }) ?? []
    const running = tasks.filter((task) => task.status === 'running')
    if (running.length > 0) out.push(`还有 ${running.length} 个任务在跑（先停掉再迁）`)
  } catch {
    /* 读不到任务台账不拦 —— 那是"不知道"，不是"正在跑" */
  }
  return out
}

function register({ ipcMain }) {
  ipcMain.handle('dataLocation:get', () => {
    let dataDir = ''
    let error = ''
    try {
      dataDir = DIRS.data
    } catch (issue) {
      error = issue instanceof Error ? issue.message : String(issue)
    }
    const pointer = dataLocation.read(rootDir())
    const isCustom = Boolean(pointer && dataDir && path.resolve(pointer.dataDir) === path.resolve(dataDir))
    return {
      ok: !error,
      error,
      dataDir,
      defaultDir: realDataDir(),
      /** 现在用的是用户指定的目录吗（而不是默认的 `<程序>/data`） */
      custom: isCustom,
      pointerFile: pointer?.file ?? '',
      /** 指针指向的目录当前不可用时的原因（空串 = 没事） */
      fallback: fallbackReason(),
      busy: busyReasons(),
    }
  })

  /*
   * 迁移数据目录。**不可逆操作里最接近"搬家"的一类**：
   * 内核那边先检查（不通过一个字都不动）→ 复制 → 校验 → **最后**才切指针，
   * 旧目录原样保留。失败时如实报是哪一步红的，绝不返回 ok:true。
   */
  ipcMain.handle('dataLocation:migrate', (_event, payload = {}) => {
    const to = String(payload?.to ?? '').trim()
    const from = DIRS.data
    const busy = busyReasons()
    if (busy.length > 0) return { ok: false, phase: 'busy', error: busy[0], blockers: [] }

    log.info(`开始迁移数据目录：${from} → ${to || '（未指定）'}`)
    const result = dataMigrate.migrate({ root: rootDir(), from, to })
    if (result.ok) {
      log.info(
        `数据目录已迁移到 ${result.to}（${result.files} 个文件 / ` +
          `${Math.round(result.bytes / 1024 / 1024)}MB / ${result.ms}ms）；旧目录保留在 ${result.keptOldDir}`,
      )
    } else {
      log.warn(`数据目录迁移失败（${result.phase}）：${result.error}`)
    }
    return result
  })
}

module.exports = { register }

/**
 * 定时任务 IPC
 *
 * 六条通道。**所有写入都过 `schedule-store.cjs`** —— 校验（名字/提示词长度、
 * 授权档枚举、像密钥的内容一律拒收）都在那一层，这里不重复判。
 *
 * ★ 通道名要同步进 `electron/ipc-channels.cjs`（那份写死的清单是自检点名用的，
 *   漏了会报 `channelsMissing`）。
 *
 * ── 这里最要紧的一条 ──
 *
 * `schedules:runNow` 和心跳走的是**同一个**执行器（`schedule-run.cjs`），所以
 * 「授权上限」对它一样成立：没人在场的确认一律是拒绝。**不许**为了让「手动点一下」
 * 更好用而给它开一条更宽的路 —— 那样两边的语义就分叉了，而用户根本分不清
 * 「我手动点的」和「它自己跑的」哪个受什么限制。
 */

const store = require('../core/schedule-store.cjs')
const next = require('../core/schedule-next.cjs')
const grant = require('../core/schedule-grant.cjs')
const log = require('../core/log.cjs')

/** 列表里每条补上「下一次什么时候跑」和「间隔怎么写成人话」 */
function withDerived(item, now = Date.now()) {
  const nextAt = item.enabled ? next.nextRunAt(item.when, now) : 0
  return {
    ...item,
    whenText: next.describeWhen(item.when),
    /* 0 = 算不出来（时间设置无效 / 已停用）—— 界面据此显示「—」而不是「1970 年」 */
    nextRunAt: nextAt,
  }
}

function register({ ipcMain }) {
  /**
   * 列定时任务。
   *
   * `running` 一起返回：界面要显示「这条正在跑」，而正在跑的状态只在
   * 执行器的内存里（不落盘 —— 进程一停，事实就是「没在跑」）。
   */
  ipcMain.handle('schedules:list', () => {
    const now = Date.now()
    return {
      ok: true,
      items: store.list().map((item) => withDerived(item, now)),
      running: require('../core/schedule-run.cjs').runningIds(),
      /* 授权档的人话说明由内核给（那里写着「实际能做什么」），界面别自己编 */
      grants: grant.GRANT_INFO,
      limits: { minIntervalMinutes: next.MIN_INTERVAL_MINUTES },
    }
  })

  ipcMain.handle('schedules:save', (_event, input = {}) => {
    const result = store.save(input)
    if (result.ok) log.info(`定时任务已保存：${result.item.name}（${result.item.grant}）`)
    return result
  })

  ipcMain.handle('schedules:remove', (_event, id) => {
    const result = store.remove(id)
    if (result.ok) log.info(`定时任务已删除 ${id}`)
    return result
  })

  ipcMain.handle('schedules:toggle', (_event, id, enabled) => {
    const result = store.setEnabled(id, enabled === true)
    if (result.ok) {
      log.info(`定时任务「${result.item.name}」${enabled === true ? '已启用' : '已停用'}`)
    }
    return result
  })

  /**
   * 立刻跑一次。
   *
   * **不 await**：一条任务的运行时间没有上限（模型要跑很多轮），把 IPC 挂在那儿
   * 等几分钟，渲染层只会看成「点了没反应」。所以立刻返回 `started`，进度去
   * 任务台账和那条专属会话里看。
   */
  ipcMain.handle('schedules:runNow', (_event, id) => {
    const item = store.get(id)
    if (!item) return { ok: false, error: '没有这条定时任务' }

    const runner = require('../core/schedule-run.cjs')
    const config = require('../core/config.cjs')
    const loop = require('../core/loop.cjs')

    void runner
      .run(item, { loop, config, store })
      .then((result) => {
        if (!result.ok) log.warn(`定时任务「${item.name}」手动运行失败：${result.error}`)
        else log.info(`定时任务「${item.name}」手动运行完成`)
      })
      .catch((error) => {
        /* run() 自己会兜住异常，这里只是最后一道 —— 绝不能无声无息 */
        log.error(`定时任务「${item.name}」手动运行抛错：${error}`)
      })

    return { ok: true, started: true }
  })
}

/**
 * 起心跳（`main.cjs` 在 app ready 之后调）。
 *
 * 依赖在这里装配，不进 `schedule-run.cjs`：那个文件**不许 require electron**，
 * 也不该知道 `loop` / `config` 从哪来 —— 它只认注进来的东西，这样自检才能直接跑它。
 *
 * 三条要留意的：
 *   · 心跳 **30 秒一跳**、**串行**跑到期的条目（同时起好几个循环会打爆模型配额）。
 *   · 心跳自己 `unref()`，不会拖住进程退出（关窗口后该退就退）。
 *   · ⚠️ 定时任务是「没人在场」的执行：`schedule-run.cjs` 给 loop 的 confirm 恒为
 *     false，授权上限由 `schedule-grant.cjs` 从 `item.grant` 算出。**别在这儿加
 *     任何「顺手放宽」的东西。**
 *
 * 起不来时**不抛**：只影响定时任务一个功能，不该把整个应用拦住 —— 但也不能
 * 一声不吭，所以记 error 日志。
 */
function start() {
  const runner = require('../core/schedule-run.cjs')
  const config = require('../core/config.cjs')
  const loop = require('../core/loop.cjs')
  try {
    const started = runner.start({ loop, config, store }, { intervalMs: 30_000 })
    log.info(`定时任务心跳已启动（每 ${started.intervalMs / 1000} 秒一跳）`)
    return started
  } catch (error) {
    log.error(`定时任务心跳启动失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

module.exports = { register, start }

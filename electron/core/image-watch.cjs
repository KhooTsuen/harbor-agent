const task = require('./image-task.cjs')
const llm = require('./llm-probe.cjs')

/* ══════════════════════════════════════════════════════════════
   生图任务的后台守望者

   ── 为什么需要它 ──

   APIMart 光**排队**就要 5 分钟左右，真正出图只要 12–15 秒
   （用户在后台看到的实测数字：提交 02:51:32 → 任务 02:56:35 创建 → 02:56:47 完成）。

   让工具**同步干等**是错的：

     · 界面卡住五六分钟，用户以为程序死了
     · 一旦超时，图就丢了 —— 用户得自己记下 task_id 再问一遍
     · 模型被逼着用 `run_shell sleep` 硬等（真机上真发生过）

   所以改成：工具提交完**立刻返回**，这里在后台盯着。出图 → 交给上层
   落盘 → 把一条带图片的消息推进对话。用户什么都不用管。

   ── 为什么不怕丢 ──

   上游图片链接保留 72 小时、任务记录保留 3 天。就算应用中途关了，
   下次也能拿 task_id 重新取（`generate_image({ taskId })` 只查不提交，不重复扣费）。
   ══════════════════════════════════════════════════════════════ */

/** 后台等待的总时长 —— 比前台宽松得多，因为它不占用户的时间 */
const WATCH_TIMEOUT_MS = 30 * 60 * 1000
/**
 * 多久问一次上游。
 *
 * APIMart 官方建议 **3–5 秒**（文档原话：「轮询务必带 sleep，不要无 sleep 死循环」）。
 * 正常情况出图只要 18 秒左右，5 分钟以上是**排队**（文档：「平均完成耗时 < 90s，
 * 偏高说明排队」）。
 *
 * 早先我设 10 秒 —— 太慢了：一出图要等最多 10 秒才反映到界面，
 * 看着就像「卡住了」。查询接口不单独计费，用官方建议值就行。
 */
const WATCH_INTERVAL_MS = 3_000

/** taskId -> 状态（timer / 开始时间 / 是否已停） */
const watchers = new Map()

/**
 * 出图之后要做什么（落盘、推进对话）—— 由 main 注入。
 *
 * 不写在 core 里是因为那需要碰会话文件和窗口，属于应用层的事；
 * 这里只管「盯住任务」这一件事。
 */
let handlers = {}
function setHandlers(next) {
  handlers = next ?? {}
}

/**
 * 盯住一个生图任务。
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} [input.sessionId]   出图后要推进哪条对话
 * @param {string} [input.prompt]      文案用
 * @param {string} input.baseUrl
 * @param {string} [input.apiKey]
 * @param {string} [input.model]
 * @param {(r: object) => void} [input.onReady]  拿到图（含 image/model）
 * @param {(e: {taskId:string, error:string}) => void} [input.onFail]
 * @param {(line: string) => void} [input.log]
 */
function watch(input) {
  const taskId = String(input?.taskId ?? '')
  if (!taskId) return { ok: false, error: '缺 taskId' }
  /* 同一条任务只盯一次（模型可能会重复注册） */
  if (watchers.has(taskId)) return { ok: true, already: true }

  const state = { taskId, startedAt: Date.now(), stopped: false, timer: null }
  watchers.set(taskId, state)

  const finish = (kind, payload) => {
    const current = watchers.get(taskId)
    if (current) {
      current.stopped = true
      clearTimeout(current.timer)
      watchers.delete(taskId)
    }
    const enriched = {
      ...payload,
      sessionId: input.sessionId,
      workdir: input.workdir,
      prompt: input.prompt,
    }
    if (kind === 'ready') (input.onReady ?? handlers.onReady)?.(enriched)
    else (input.onFail ?? handlers.onFail)?.(enriched)
  }

  const tick = async () => {
    if (state.stopped) return

    if (Date.now() - state.startedAt > WATCH_TIMEOUT_MS) {
      finish('fail', {
        taskId,
        error: `后台等了 ${Math.round(WATCH_TIMEOUT_MS / 60_000)} 分钟还没出图`,
      })
      return
    }

    let result = null
    try {
      result = await llm.generateImage({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        taskId,
        once: true,
      })
    } catch (error) {
      /* 网络抖一下不算失败，下一轮接着问 */
      input.log?.(`查任务 ${taskId} 出错：${error instanceof Error ? error.message : error}`)
    }
    if (state.stopped) return

    input.log?.(
      `[生图] ${taskId} status=${result?.status ?? '?'} raw=${result?.raw ?? '(同步站点)'}`,
    )

    if (result?.ok && result.image) {
      finish('ready', { ...result, taskId })
      return
    }
    /* 明确失败（不是「还在跑」）就收工 */
    if (result && !result.ok && !result.pending) {
      finish('fail', { taskId, error: result.error ?? '生成失败' })
      return
    }

    /*
     * 还在跑 —— 把当前状态推给界面。
     * 用户要的是「实时看见它在干什么」：排队中 / 正在画 / 已等待多久。
     * 光转圈不给信息，看着就像死了。
     */
    ;(input.onProgress ?? handlers.onProgress)?.({
      taskId,
      sessionId: input.sessionId,
      status: result?.status ?? 'unknown',
      elapsedMs: Date.now() - state.startedAt,
    })

    state.timer = setTimeout(() => void tick(), WATCH_INTERVAL_MS)
  }

  /* 先等一个间隔再问 —— 刚提交完必然是排队中 */
  state.timer = setTimeout(() => void tick(), WATCH_INTERVAL_MS)
  return { ok: true }
}

/** 停掉一个（用户在界面上取消了） */
function stop(taskId) {
  const state = watchers.get(String(taskId ?? ''))
  if (!state) return { ok: false, error: '没有这个任务' }
  state.stopped = true
  clearTimeout(state.timer)
  watchers.delete(String(taskId))
  return { ok: true }
}

/** 退出时清干净，免得挂着一堆定时器 */
function stopAll() {
  for (const state of watchers.values()) {
    state.stopped = true
    clearTimeout(state.timer)
  }
  watchers.clear()
}

/** 现在有几个在盯着（界面/自检用） */
function count() {
  return watchers.size
}

module.exports = {
  WATCH_TIMEOUT_MS,
  WATCH_INTERVAL_MS,
  watch,
  stop,
  stopAll,
  count,
  setHandlers,
  task,
}

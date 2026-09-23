/* ══════════════════════════════════════════════════════════════
   定时任务 API

   内核侧（`electron/core/schedule-*.cjs` + `handlers/schedules.cjs`）已经把
   「授权上限」这件事定死了，前端只做**搬运 + 显示**：

     · 三档的 label / detail 由内核给（`schedule-grant.cjs` 的 GRANT_INFO），
       界面**原样显示**。前端一旦自己改写，就会比实际宽（骗用户给权限）
       或比实际严（用户不敢用）。
     · `nextRunAt === 0` 的意思是「算不出来」（已停用 / 时间无效），
       界面要显示成「—」，**不能渲染成 1970 年**。
     · `runNow` 立刻返回（`started`），**不是**跑完了 —— 界面不许假装它跑完。

   为什么桥类型写在这里：`types/backend.ts` 正好 300 行（硬约束 #2），
   加不进 `schedules*` 这几个方法。做法与 `artifactApi.ts` 一致 ——
   本地声明桥类型 + 一次 `as unknown as`（不用 any / @ts-ignore），
   桥不在时**优雅降级**（返回 null / ok:false，让面板说一句人话，不崩不白屏）。
   ══════════════════════════════════════════════════════════════ */

/** 时间：每 N 分钟，或每天某个钟点 */
export type ScheduleWhen =
  | { type: 'interval'; minutes: number }
  | { type: 'daily'; at: string }

/** 授权上限三档 */
export type ScheduleGrantId = 'readonly' | 'workspace' | 'full'

/** 三档的界面顺序（内核 GRANTS 同序：从最严到最松） */
export const SCHEDULE_GRANTS: readonly ScheduleGrantId[] = ['readonly', 'workspace', 'full']

/** 台账里的一条（内核 `schedule-store.cjs` 的形状 + `schedules:list` 补的两个字段） */
export type ScheduleItem = {
  id: string
  name: string
  when: ScheduleWhen
  prompt: string
  /** 空串 = 用默认工作目录 */
  workdir: string
  grant: ScheduleGrantId
  enabled: boolean
  createdAt: number
  lastRunAt: number
  lastTaskId: string
  lastResult: string
  runCount: number
  /** 被拒次数（内核按正文认字统计，是线索不是账） */
  blockedCount: number
  /** 每次跑在哪个专属会话里 */
  sessionId: string
  /** 内核算好的中文，如 "每 30 分钟" / "每天 09:30" */
  whenText: string
  /** 0 = 算不出来（已停用或时间无效） */
  nextRunAt: number
}

/** 一档授权的人话说明（内核原文，界面别改） */
export type ScheduleGrantInfo = { label: string; detail: string }

/** 列表快照：条目 + 正在跑的 id + 三档说明 + 内核的限制值 */
export type ScheduleListSnapshot = {
  items: ScheduleItem[]
  /** 正在跑的 id（只在内存里，进程一停就没了） */
  running: string[]
  grants: Partial<Record<ScheduleGrantId, ScheduleGrantInfo>>
  minIntervalMinutes: number
}

/** 保存用的草稿：有 id = 改这一条，没 id = 新建 */
export type ScheduleDraft = {
  id?: string
  name: string
  when: ScheduleWhen
  prompt: string
  workdir: string
  grant: ScheduleGrantId
  enabled?: boolean
}

/** 保存 / 开关这类写操作的结果（失败原因以内核返回的 error 为准） */
export type ScheduleWriteResult = { ok: boolean; item?: ScheduleItem; error?: string }

/* 内核侧待暴露的那几个方法（`electron/preload.cjs` 里已经挂上了） */
type SchedulesBridge = {
  schedulesList?: () => Promise<{
    ok: boolean
    items?: ScheduleItem[]
    running?: string[]
    grants?: Partial<Record<ScheduleGrantId, ScheduleGrantInfo>>
    limits?: { minIntervalMinutes?: number }
    error?: string
  }>
  schedulesSave?: (input: ScheduleDraft) => Promise<ScheduleWriteResult>
  schedulesRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>
  schedulesToggle?: (id: string, enabled: boolean) => Promise<ScheduleWriteResult>
  schedulesRunNow?: (id: string) => Promise<{ ok: boolean; started?: boolean; error?: string }>
}

const bridge =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as SchedulesBridge | undefined)
    : undefined

/**
 * 桥接好了吗。
 *
 * 面板据此决定「显示列表」还是「显示一句人话」—— 浏览器预览里没有桥，
 * 必须能优雅降级，不能白屏。
 */
export function schedulesBridgeReady(): boolean {
  return typeof bridge?.schedulesList === 'function'
}

/** 桥不在时统一用这句（面板原样显示） */
const NO_BRIDGE = '当前环境不支持定时任务，请在桌面版里使用（浏览器预览没有内核）'

/** 只是兜底：真正的下限由内核 `limits.minIntervalMinutes` 给 */
const FALLBACK_MIN_INTERVAL = 5

/** 列定时任务；桥不在或内核报错 → null，调用方显示一句人话 */
export async function schedulesList(): Promise<ScheduleListSnapshot | null> {
  if (typeof bridge?.schedulesList !== 'function') return null
  try {
    const result = await bridge.schedulesList()
    if (!result?.ok) return null
    const min = Number(result.limits?.minIntervalMinutes)
    return {
      items: result.items ?? [],
      running: result.running ?? [],
      grants: result.grants ?? {},
      minIntervalMinutes: Number.isFinite(min) && min > 0 ? min : FALLBACK_MIN_INTERVAL,
    }
  } catch {
    return null
  }
}

export async function schedulesSave(draft: ScheduleDraft): Promise<ScheduleWriteResult> {
  if (typeof bridge?.schedulesSave !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.schedulesSave(draft)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function schedulesRemove(id: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof bridge?.schedulesRemove !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.schedulesRemove(id)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function schedulesToggle(id: string, on: boolean): Promise<ScheduleWriteResult> {
  if (typeof bridge?.schedulesToggle !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.schedulesToggle(id, on)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * 立刻跑一次。
 *
 * ★ 内核**不 await** 那条任务（一条任务能跑几分钟），所以这里返回的是
 *   「已经开始了」而不是「跑完了」。界面照这个说，不许写成「已完成」。
 */
export async function schedulesRunNow(
  id: string,
): Promise<{ ok: boolean; started?: boolean; error?: string }> {
  if (typeof bridge?.schedulesRunNow !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.schedulesRunNow(id)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * 取一档的说明文字；内核没给这一格就返回 null。
 *
 * ★ 返回 null 时界面**只显示档位 id**，绝不自己编一句人话去冒充内核文案 ——
 *   编出来的那句一定和实际行为对不上。
 */
export function scheduleGrantInfo(
  snapshot: ScheduleListSnapshot | null,
  id: ScheduleGrantId,
): ScheduleGrantInfo | null {
  const info = snapshot?.grants?.[id]
  if (!info || typeof info.label !== 'string') return null
  return info
}

/**
 * 客户端先挡一道明显白填的情况（和内核同一套规则：名字/提示词非空、间隔 ≥ 下限）。
 *
 * ★ 但**最终真相以内核返回的 error 为准** —— 内核还会拒收「看着像密钥」的提示词，
 *   那种判断前端复刻不了（也不该复刻，复刻就会漂）。所以这里只挡一眼能看出来的。
 *
 * @returns 错误文案；没问题返回 null
 */
export function scheduleDraftError(
  draft: ScheduleDraft,
  minIntervalMinutes: number,
): string | null {
  if (!draft.name.trim()) return '名字不能为空'
  if (!draft.prompt.trim()) return '提示词不能为空'

  if (draft.when.type === 'interval') {
    const minutes = Number(draft.when.minutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return '间隔要填一个数字（分钟）'
    const floor = minIntervalMinutes > 0 ? minIntervalMinutes : FALLBACK_MIN_INTERVAL
    if (minutes < floor) return `间隔不能小于 ${floor} 分钟`
    return null
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.when.at)) {
    return '时间要写成 HH:MM（24 小时制），比如 09:30'
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ══════════════════════════════════════════════════════════════
   记忆可解释的桥包装（内核 `memory:explain` → `core/memory-explain.cjs`）

   要回答的只有一个问题：**为什么是这几条进了这一轮**。
   分数和理由内核一直在算，但以前哪儿都不显示 —— 用户看到「注入了 5 条」，
   完全不知道为什么是这 5 条、另外那些为什么没进来。

   三条纪律：

   ① `injected` 是**进程内**状态、不落盘 → 刚启动时是 `null`。
      这里**保持 null**（不兜成空对象）：「没有记录」（还没跑过对话）和
      「记录了 0 条」（跑过但一条都没进来）是两件事，界面要分开说。
   ② 打分权重只在内核（`electron/core/memory-explain.cjs`）。这里**不复制**
      任何权重或公式，只搬内核给的 `score` 和中文 `reason` —— 复制就会漂。
   ③ 拿不到桥 / 内核报错返回 `null`，**不抛异常**，面板降级显示一句人话。

   类型为什么在本地声明：`src/types/backend.ts` 正好 300 行（硬约束 #2），不许再改。
   办法照 `src/lib/artifactApi.ts` —— 一次 `as unknown as` 收窄，不用 `any`。
   ══════════════════════════════════════════════════════════════ */

export type MemoryScoreEntry = {
  id: string
  content: string
  type: string
  scope: string
  score: number
  /** 内核给的中文理由，例如「约束类 + 本次会话范围，且与本次提问相关」 */
  reason: string
}

/** 上一轮注入的账（哪几条真的进了系统提示、各多少分、分是怎么来的） */
export type MemoryInjectionRecord = {
  at: number
  /** 那一轮的上限（配置里的 memory.injectLimit） */
  budget: number
  /** 当时共有多少条可用记忆 */
  total: number
  injected: MemoryScoreEntry[]
}

export type MemoryExplainView = {
  /** null = 这次启动后还没注入过（不落盘，重启就清空） */
  injected: MemoryInjectionRecord | null
  /** 当前生效记忆逐条的解释；检索关掉时内核返回空数组（那时没有排序可言） */
  items: MemoryScoreEntry[]
  retrieveEnabled: boolean
}

type RawEntry = {
  id?: unknown
  content?: unknown
  type?: unknown
  scope?: unknown
  score?: unknown
  reason?: unknown
}

type MemoryExplainBridge = {
  memoryExplain?: (options?: {
    query?: string
    projectId?: string
  }) => Promise<{
    ok?: boolean
    injected?: unknown
    items?: unknown
    retrieveEnabled?: unknown
  }>
}

const bridge =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as MemoryExplainBridge | undefined)
    : undefined

/** 桥接好了吗（没接上时面板只说一句「当前版本没接上这个桥」，其余照常） */
export function memoryExplainBridgeReady(): boolean {
  return typeof bridge?.memoryExplain === 'function'
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numOf(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 一条解释：缺 id 的丢掉（没有 id 就没法在界面上对应到任何东西） */
function entryOf(raw: unknown): MemoryScoreEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as RawEntry
  const id = textOf(entry.id)
  if (!id) return null
  return {
    id,
    content: textOf(entry.content),
    type: textOf(entry.type),
    scope: textOf(entry.scope),
    /* 脏分数按 0 算：NaN 一进排序，结果是不可预测的 */
    score: numOf(entry.score, 0),
    reason: textOf(entry.reason),
  }
}

function entriesOf(raw: unknown): MemoryScoreEntry[] {
  if (!Array.isArray(raw)) return []
  const list: MemoryScoreEntry[] = []
  for (const item of raw) {
    const entry = entryOf(item)
    if (entry) list.push(entry)
  }
  return list
}

/** 注入账。`null` 原样返回 null —— 这一点界面依赖，不许兜底 */
function injectionOf(raw: unknown): MemoryInjectionRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as { at?: unknown; budget?: unknown; total?: unknown; injected?: unknown }
  return {
    at: numOf(record.at, 0),
    budget: numOf(record.budget, 0),
    total: numOf(record.total, 0),
    injected: entriesOf(record.injected),
  }
}

/** 取一次解释数据；没桥 / 报错返回 null（面板显示「当前版本没接上」） */
export async function fetchMemoryExplain(
  options: { query?: string; projectId?: string } = {},
): Promise<MemoryExplainView | null> {
  if (typeof bridge?.memoryExplain !== 'function') return null
  try {
    const raw = await bridge.memoryExplain(options)
    return {
      injected: injectionOf(raw?.injected),
      items: entriesOf(raw?.items),
      /* 缺这个字段时按「开着」算：开着是内核默认值，也是唯一会算分的路径 */
      retrieveEnabled: raw?.retrieveEnabled !== false,
    }
  } catch {
    return null
  }
}

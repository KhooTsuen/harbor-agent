/* ══════════════════════════════════════════════════════════════
   网络策略（`config.json` 的 `security.network`）的桥包装

   · 读：桥上的 `networkPolicy()`（内核 `security:network`）。它除了三个配置值，
     还返回一段**由内核生成**的「管得到 / 管不到什么」说明
     （`net-policy.describePolicy`）。那段话是交付内容的一部分，这里只负责
     **原样搬运**，绝不改写 —— 前端重写一遍就会漂，而漂的方向通常是「说得比实际强」；
     用户拿它当防火墙用，比没有这道关更危险。

   · 写：走通用 `config:patch`。内核 `patch()` 里 `...partial` 那一层会把整个
     `security` 段换成发过去的那一份 —— 所以这里**只发 network 这一段**，
     别的配置（工作目录、供应商、工具权限…）一个字节都不动。

   类型为什么在本地声明：`src/types/backend.ts` 正好 300 行（硬约束 #2），不许再改。
   办法照 `src/lib/artifactApi.ts` —— 用一次 `as unknown as` 收窄成本地类型，
   不用 `any`、也不用 `@ts-ignore`。

   拿不到桥 / 内核报错：返回 `null` 或 `{ ok: false }`，**不抛异常**。
   面板据此显示一句人话，而不是让设置页白屏。
   ══════════════════════════════════════════════════════════════ */

export type NetworkMode = 'allow' | 'ask' | 'deny'

export type NetworkPolicy = {
  mode: NetworkMode
  /** 一律不许连的主机，支持 `*.example.com`。**禁止优先于允许** */
  denyHosts: string[]
  /** 免问的主机；必须命令里**每个**主机都在名单里才算数 */
  allowHosts: string[]
}

/** 内核回的东西：三个配置值 + 一段说明（说明必须原样显示给用户） */
export type NetworkPolicyView = NetworkPolicy & { description: string }

/** 内核侧待暴露的方法（`backend.ts` 的类型里还没有这两个） */
type NetworkPolicyBridge = {
  networkPolicy?: () => Promise<{
    ok?: boolean
    mode?: unknown
    denyHosts?: unknown
    allowHosts?: unknown
    description?: unknown
  }>
  patchConfig?: (partial: Record<string, unknown>) => Promise<{ ok?: boolean }>
}

const bridge =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as NetworkPolicyBridge | undefined)
    : undefined

/** 桥接好了吗（没接上时面板显示「当前版本没接上这个桥」，不崩、不白屏） */
export function networkPolicyBridgeReady(): boolean {
  return typeof bridge?.networkPolicy === 'function'
}

/**
 * 认不出来的模式一律当 `ask` —— 与内核 `net-policy.normalizeMode` 同一条
 * fail-closed 规矩：**绝不因为值写错就放行**。
 */
function modeOf(value: unknown): NetworkMode {
  return value === 'allow' || value === 'deny' ? value : 'ask'
}

/** 名单：只认字符串，trim + 去空 + 去重（内核还会再规范一遍，这里只是别把脏值显示出来） */
function hostsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const host = raw.trim().toLowerCase()
    if (host) seen.add(host)
  }
  return [...seen]
}

/** 读当前策略；没桥 / 报错返回 null（调用方据此说一句「没接上」） */
export async function fetchNetworkPolicy(): Promise<NetworkPolicyView | null> {
  if (typeof bridge?.networkPolicy !== 'function') return null
  try {
    const raw = await bridge.networkPolicy()
    return {
      mode: modeOf(raw?.mode),
      denyHosts: hostsOf(raw?.denyHosts),
      allowHosts: hostsOf(raw?.allowHosts),
      description: typeof raw?.description === 'string' ? raw.description : '',
    }
  } catch {
    return null
  }
}

/** 把整段 `security.network` 写回去（**只有这一段**，别的配置不动） */
export async function saveNetworkPolicy(
  policy: NetworkPolicy,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof bridge?.patchConfig !== 'function') {
    return { ok: false, error: '当前版本没接上配置写入通道' }
  }
  try {
    const result = await bridge.patchConfig({ security: { network: policy } })
    if (result?.ok === false) return { ok: false, error: '主进程拒绝了这次改动' }
    return { ok: true }
  } catch (error) {
    /* 失败原因要带给界面 —— 静默失败会让用户以为「已经禁掉了」 */
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 多行文本 → 主机名单：一行一个，trim、去空行、去重。
 * 保存时用它：用户粘进来的一堆空行不该变成名单里的空条目。
 */
export function parseHostLines(text: string): string[] {
  return hostsOf(text.split('\n'))
}

import type { ModelCapabilities, ModelProbeResult } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   能力探测（**实测**）的桥包装

   约定照 `artifactApi.ts`：**失败不抛异常**，一律返回 `{ ok:false, error }` ——
   这是设置页上的一个按钮，抛出去只会变成「整块界面出错」。

   ★ 这里只做两件事：取实测结果、把「声明」与「实测」的**不一致**算出来。
     真正的请求在内核（`electron/core/model-probe.cjs`）—— 它只影响提示、不改请求形状，
     也不替用户下结论（结论摆出来给人看）。
   ══════════════════════════════════════════════════════════════ */

/** 实测的维度（顺序 = 界面上的显示顺序） */
export const PROBE_DIMS = ['tool_call', 'vision', 'streaming', 'usage', 'listed'] as const
export type ProbeDim = (typeof PROBE_DIMS)[number]

const PROBE_LABELS: Record<ProbeDim, string> = {
  tool_call: '工具调用',
  vision: '图片',
  streaming: '流式',
  usage: '用量回传',
  listed: '在模型清单里',
}

/** 维度的人话 */
export function probeLabel(dim: ProbeDim): string {
  return PROBE_LABELS[dim]
}

/** 实测一个模型。桥不在（老版本内核）也返回一句人话，不抛 */
export async function probeProviderModel(
  providerId: string,
  model: string,
): Promise<ModelProbeResult> {
  const empty = { ok: false, at: Date.now(), providerId, model, results: {}, notes: {} }
  const bridge = window.workbench
  if (!bridge?.probeProvider) return { ...empty, error: '这个版本的内核还没有能力探测' }

  try {
    return await bridge.probeProvider(providerId, model)
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 「声明」与「实测」对不上的地方。
 *
 * ★ 只报**会真让调用失败的那两项**（工具调用 / 图片）：
 *   别的维度不一致不是「矛盾」——**流式慢一点是体验问题，不是错**，
 *   铺出来只会变噪音。这条口径和 `ModelCapabilityList` 里「只有两项值得标不支持」一致。
 *
 * 实测 `null`（没测出来）**不算不一致** —— 未知不等于不支持，别替用户猜。
 */
export function probeConflicts(
  caps: ModelCapabilities | undefined,
  probe: ModelProbeResult | undefined,
): string[] {
  if (!caps || !probe?.results) return []

  const out: string[] = []
  for (const dim of ['tool_call', 'vision'] as const) {
    const declared = caps[dim]
    const measured = probe.results[dim]
    if (measured === false && declared !== false) {
      out.push(`${PROBE_LABELS[dim]}：声明${declared === true ? '支持' : '未知'}，实测不行`)
    } else if (measured === true && declared === false) {
      out.push(`${PROBE_LABELS[dim]}：声明不支持，实测可以用`)
    }
  }
  return out
}

import type { ProviderConfig } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   模型名的输入体检

   抽成纯函数是为了能单测 —— 用户输错的方式就那么几种，
   与其让他在「发不出消息」的时候猜，不如当场说清楚。
   ══════════════════════════════════════════════════════════════ */

/**
 * 检查一个模型名有没有问题。
 *
 * @returns 有问题的说明；没问题返回 null
 */
export function diagnoseModel(value: string, providers: readonly ProviderConfig[]): string | null {
  const trimmed = value.trim()

  /* 空值：最常见的一种，直接说后果 */
  if (!trimmed) return '模型名不能为空，不然消息发不出去'

  const allModels = [...new Set(providers.flatMap((p) => p.models))]

  /* 还没配清单的时候不啰嗦 —— 这时候打什么都「不在清单里」 */
  if (allModels.length === 0) return null

  /* 名字不在任何清单里：多半是打错了，也可能是有意手输的自定义名 */
  if (!allModels.includes(trimmed)) {
    return `「${trimmed}」不在任何供应商的清单里 —— 名字对吗？`
  }

  /* 名字对，但它属于一个被停用的供应商 */
  const owner = providers.find((p) => p.models.includes(trimmed))
  if (owner && !owner.enabled) {
    return `它属于 ${owner.name}，但那家现在是停用状态`
  }

  return null
}

/**
 * 删掉某个模型后，当前选中的模型该换成什么。
 *
 * 删的如果不是当前在用的，就保持不变；如果是，顺着落到清单里的第一个；
 * 一个都不剩就清空（让用户重新选，而不是留个不存在的名字）。
 */
export function modelAfterRemoval(
  current: string,
  removed: string,
  remaining: readonly string[],
): string {
  if (current !== removed) return current
  return remaining[0] ?? ''
}

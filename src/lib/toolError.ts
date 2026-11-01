/* ══════════════════════════════════════════════════════════════
   工具失败时的「一句真话」

   ── 为什么需要它 ──────────────────────────────────────────────
   图2 验收表要求：失败项要「明显显示失败图标与颜色，并可展开查看**真实错误原因**」，
   同时「不要在界面中展示大段原始 JSON；原始信息可放在详情的次级区域」。

   工具输出经常是混杂的：前面一大段 JSON（参数回显 / 调试结构），真正的错误
   埋在中间某一行；也有整段就是 `{"error":{"message":"..."} }` 的。
   直接把 `run.output` 铺进展开区，用户要自己在一屏 JSON 里找那一行 ——
   等于「有信息但没有答案」。

   所以这里只做一件事：**从原始输出里挑出能当答案的那一行**，
   其余一律原样留在「完整输出」里（一个字都不删，不篡改）。

   ── 判据（只看结构，不猜语气）────────────────────────────────
     ① 整段能当 JSON 解析（或首尾是 { } / [ ]）→ 找 message / error / detail 之类字段
     ② 否则取**第一行非空**，长了下刀截断（加省略号，不假装完整）
     ③ 一行都取不到 → 退回「失败，但工具没给出原因」（不编）
   ══════════════════════════════════════════════════════════════ */

/** 摘要最多这么多字（再长就不是「一句」了） */
const MAX_BRIEF = 200

/** JSON 里那些「人话」字段，按优先级找 */
const MESSAGE_KEYS = ['message', 'error', 'detail', 'reason', 'stderr'] as const

/** 从任意对象里挖出一句人话（最多往下找三层，免得死循环 / 太深） */
function digMessage(value: unknown, depth = 0): string {
  if (depth > 3 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const found = digMessage(record[key], depth + 1)
    if (found) return found
  }
  return ''
}

/** 尽量解析成对象；解析不了就返回 null（不抛） */
function tryJson(text: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.search(/[[{]/)
  if (start < 0) return null
  const tail = trimmed.slice(start)
  try {
    return JSON.parse(tail)
  } catch {
    return null
  }
}

export interface ToolErrorDigest {
  /** 那一句能当答案的话（一定非空） */
  brief: string
  /** 完整输出还有别的内容 → 界面给「查看完整输出」；与 brief 相同就是 null */
  full: string | null
}

/**
 * 失败输出的摘要。
 *
 * ★ 永远返回一句非空的话：界面上「失败」后面跟一片空白比写「没给出原因」更糟。
 */
export function errorDigest(output: string): ToolErrorDigest {
  const text = output.trim()
  if (!text) return { brief: '失败，工具没有给出原因', full: null }

  const parsed = tryJson(text)
  const fromJson = parsed ? digMessage(parsed) : ''
  if (fromJson) {
    const brief = fromJson.length > MAX_BRIEF ? `${fromJson.slice(0, MAX_BRIEF)}…` : fromJson
    return { brief, full: text === brief ? null : text }
  }

  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  const line = firstLine.trim().replace(/\s+/g, ' ')
  const brief = line.length > MAX_BRIEF ? `${line.slice(0, MAX_BRIEF)}…` : line
  if (!brief) return { brief: '失败，工具没有给出原因', full: text }
  return { brief, full: text === brief ? null : text }
}

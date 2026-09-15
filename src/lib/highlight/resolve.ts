import type { LanguageSpec, ResolvedSpec } from './types'
import { SPECS } from './specs'
import { EXTRA_SPECS } from './specs-extra'

/* ══════════════════════════════════════════════════════════════
   语言查表

   放在独立文件里是为了**打断循环依赖**：
   markup.ts 处理 <script> / <style> 时也要查表，如果查表在
   index.ts 里，就变成 index → markup → index 的环。
   ══════════════════════════════════════════════════════════════ */

const REGISTRY = new Map<string, ResolvedSpec>()

function build(spec: LanguageSpec): ResolvedSpec {
  const caseInsensitive = (spec.features ?? []).includes('caseInsensitive')
  /* 大小写不敏感的语言（SQL / PowerShell）统一转小写再查，省掉每次比对时的转换 */
  const toSet = (list?: string[]): Set<string> =>
    new Set((list ?? []).map((word) => (caseInsensitive ? word.toLowerCase() : word)))

  return {
    id: spec.id,
    name: spec.name,
    keywords: toSet(spec.keywords),
    types: toSet(spec.types),
    constants: toSet(spec.constants),
    lineComment: spec.lineComment ?? [],
    blockComment: spec.blockComment,
    quotes: spec.quotes ?? '',
    features: spec.features ?? [],
    caseInsensitive,
  }
}

for (const spec of [...SPECS, ...EXTRA_SPECS]) {
  const resolved = build(spec)
  REGISTRY.set(resolved.id, resolved)
  for (const alias of spec.aliases ?? []) REGISTRY.set(alias, resolved)
}

/** 按代码块围栏上的语言名查表；认不出返回 undefined（当纯文本处理） */
export function getLanguage(name: string): ResolvedSpec | undefined {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
  if (!key) return undefined

  const direct = REGISTRY.get(key)
  if (direct) return direct

  /* 兜一层：```ts{1,3} 这种把元信息粘在语言名后面的写法 */
  const bare = key.replace(/[^a-z0-9#+.-].*$/, '')
  return bare && bare !== key ? REGISTRY.get(bare) : undefined
}

/** 显示名：代码块左上角那个标签用它（```js → JavaScript） */
export function languageName(name: string): string {
  const trimmed = String(name ?? '').trim()
  return getLanguage(trimmed)?.name ?? (trimmed || 'Text')
}

/**
 * 是不是「没什么可染」的纯文本。
 *
 * 只看 id —— 不能看 features 是否为空：Ruby / Lua / C 这些照样靠关键字染色，
 * 只是没有额外特性开关而已。
 */
export function isPlain(spec: ResolvedSpec): boolean {
  return spec.id === 'plaintext'
}

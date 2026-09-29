/**
 * 严重性 / 建议 / 位置 / 去重键 —— **转发到内核**，这里不再定义任何规则。
 *
 * 为什么改成转发（2026-09-29）：规则原来写在这个文件里，但 `scripts/` **不打包进应用**，
 * 界面（右栏「错误」标签）够不着 → 就得再写一套 → 两边必然漂（本仓库为此返工过好几次）。
 * 唯一的一份现在在 `electron/core/error-rules.cjs`：
 *
 *   · 内核（界面走的 `errors:list` 通道）直接用它
 *   · 这个文件替 `scripts/**` 把它 require 进来再转发（下面的 import 就干这个）
 *
 * 测试（`scripts/errors.test.mjs`）仍然直接测这些函数 —— 测的就是内核那份。
 */
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/* 内核是 CommonJS，且刻意不依赖 electron —— 自检就是这么直接 require 它的 */
let kernelRules = null
try {
  kernelRules = require(path.resolve(import.meta.dirname, '..', '..', 'electron', 'core', 'error-rules.cjs'))
} catch {
  kernelRules = null /* 拿不到就整套退化（见下面每个函数的兜底） */
}

export const classifierAvailable = kernelRules?.classifierAvailable === true

/* 严重性的顺序与措辞也在内核那一份里（命令行和界面用同一份词） */
export const SEVERITY_ORDER = kernelRules?.SEVERITY_ORDER ?? ['P0', 'P1', 'P2', 'P3']
export const SEVERITY_LABEL = kernelRules?.SEVERITY_LABEL ?? { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' }

export function classify(message, options) {
  if (!kernelRules) return { kind: 'unknown', retryable: false, needsUser: false, hint: '', message: String(message ?? '') }
  return kernelRules.classify(message, options)
}

export function severityOf(kind, options) {
  /* 规则拿不到时一律给最低档：宁可少报，也别把「认不出」说成「阻塞」 */
  if (!kernelRules) return 'P3'
  return kernelRules.severityOf(kind, options)
}

export function hintOf(kind, message, fallback = '') {
  if (!kernelRules) return fallback
  return kernelRules.hintOf(kind, message, fallback)
}

export function locationOf(item) {
  if (!kernelRules) return item?.location ?? item?.source ?? ''
  return kernelRules.locationOf(item)
}

export function dedupeKey(kind, item) {
  if (!kernelRules) return `${item?.source}|${kind}`
  return kernelRules.dedupeKey(kind, item)
}

export const aggregate = (list) =>
  kernelRules ? kernelRules.aggregate(list) : [...(list ?? [])].sort((a, b) => b.ts - a.ts)

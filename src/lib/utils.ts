import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/*
 * tailwind-merge 不认识 tailwind.config.js 里自定义的字号名（meta / body / title / dense），
 * 会把 `text-dense` 当成一种「颜色类」—— 后面跟着 `text-fg-primary` 时被覆盖掉。
 * 症状是「写了字号却不生效」：元素吃的是继承值（真机上量过：Row 标签写着 text-dense，
 * 实际渲染 15px 继承值）。名字必须和 tailwind.config.js 的 fontSize 保持一致。
 */
const mergeClassNames = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['meta', 'body', 'title', 'dense'] }] } },
})

/** 合并 className：clsx 处理条件，tailwind-merge 解决冲突 */
export function cn(...inputs: ClassValue[]): string {
  return mergeClassNames(clsx(inputs))
}

/** 唯一 id（不依赖 crypto，环境里没有也能跑） */
export function uid(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 9)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 相对时间：14 分 / 3 周 */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 时`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} 周`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 时钟时间，用于消息分组 */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 按扩展名判断语言（FileTree / 代码高亮用） */
export function languageFromName(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    css: 'css',
    scss: 'scss',
    html: 'html',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    sql: 'sql',
  }
  return map[ext] ?? 'text'
}

/** 夹取数值 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 毫秒延时 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 随机整数 [min, max] */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 从数组里按概率取真 */
export function chance(probability: number): boolean {
  return Math.random() < probability
}

/** 截断字符串，保留可视化宽度 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 把 "mod+k" 这种组合转成展示用的标签（按平台） */
export function eventToCombo(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase()
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return null
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('mod')
  if (event.shiftKey) parts.push('shift')
  if (event.altKey) parts.push('alt')
  const normalized: Record<string, string> = {
    ' ': 'space',
    escape: 'esc',
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
  }
  parts.push(normalized[key] ?? key)
  return parts.join('+')
}

export function formatKeys(combo: string, isMac: boolean): string {
  return combo
    .split('+')
    .map((part) => {
      const key = part.trim().toLowerCase()
      if (key === 'mod') return isMac ? '⌘' : 'Ctrl'
      if (key === 'shift') return isMac ? '⇧' : 'Shift'
      if (key === 'alt') return isMac ? '⌥' : 'Alt'
      if (key === 'enter') return '↵'
      if (key === 'esc') return 'Esc'
      if (key === 'up') return '↑'
      if (key === 'down') return '↓'
      return key.toUpperCase()
    })
    .join(isMac ? '' : '+')
}

/** 事件是否匹配某个组合，如 "mod+k" */
export function matchCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase())
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')

  const isMac = navigator.platform.toLowerCase().includes('mac')
  const modPressed = isMac ? event.metaKey : event.ctrlKey

  if (wantMod !== modPressed) return false
  if (wantShift !== event.shiftKey) return false
  if (wantAlt !== event.altKey) return false

  const key = parts.filter((p) => !['mod', 'shift', 'alt'].includes(p))[0]
  if (key === undefined) return false

  const eventKey = event.key.toLowerCase()
  if (key === 'enter') return eventKey === 'enter'
  if (key === 'esc') return eventKey === 'escape'
  if (key === ',') return eventKey === ','
  if (key === 'up') return eventKey === 'arrowup'
  if (key === 'down') return eventKey === 'arrowdown'
  return eventKey === key
}

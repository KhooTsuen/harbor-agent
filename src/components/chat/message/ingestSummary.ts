/**
 * 「扩展送进来的那条记录，一句话是什么」—— 纯函数，2026-11-04
 *
 * 从 `IngestedNote.tsx` 拆出来（那边只留渲染）：这些判据**必须能真跑**。
 * 光扫源码钉不住「摘要对不对」—— 摘要错了不会报错，只会显示成一句废话。
 *
 * ── 为什么不另存一份摘要字段 ────────────────────────────────────
 *
 * 这些记录的正文格式由**生产方**决定：网页正文是 `core/tools/_web-note.cjs`
 * 的包装，页面操作回执是扩展侧渲染出来的 Markdown。摘要只能从正文里抠 ——
 * 另存字段就是第二套格式，早晚和生产方漂开（硬约束 #9）。
 *
 * 认不出的形状退回「扩展记录」：不猜、不硬套。
 */

/** 网页正文包装的开头（`core/tools/_web-note.cjs`）—— 用它认「这是网页正文」 */
const WEB_NOTE = '【以下是通过'

/** 抽 `键：值` 那一行；空值和「（无）」都当没有 */
function field(content: string, key: string): string {
  const matched = new RegExp(`^${key}：(.*)$`, 'm').exec(content)
  const value = (matched?.[1] ?? '').trim()
  return value && value !== '（无）' ? value : ''
}

/**
 * 这条记录是什么。
 *
 * 顺序有讲究：**先认小节标题，再退回「已读取网页」** —— 页面操作 / 标签页的回执
 * 同样带网页包装，先判包装会把它们全说成「已读取网页」（等于没说）。
 */
export function headlineOf(content: string): string {
  const text = String(content ?? '')
  const op = /^##\s*页面操作：(.+)$/m.exec(text)
  if (op) {
    const name = op[1].trim()
    const result = resultOf(text)
    return result ? `页面操作：${name} · ${result}` : `页面操作：${name}`
  }
  const tab = /^##\s*标签页(?:：(.+))?$/m.exec(text)
  if (tab) return tab[1] ? `标签页：${tab[1].trim()}` : '标签页'
  if (text.includes(WEB_NOTE)) return '已读取网页'
  return '扩展记录'
}

/**
 * 回执里「结果」那一句（摘要里最要紧的：「点了」还是「没执行」）。
 *
 * ★ 取「`- 结果：`」那一行**粗体之前**的文字。为什么不直接取粗体：
 *   回执有两种写法，取错就会显示成一句解释而不是结果 ——
 *     `- 结果：已经点了（**这只是「点了」…**）` → 要「已经点了」
 *     `- 结果：**没有执行** —— 元素引用已失效`   → 要「没有执行」
 *   粗体前什么都没有时（第二种）才用粗体本身；整行都没粗体就用整行。
 */
function resultOf(text: string): string {
  const line = /^-\s*结果：(.*)$/m.exec(text)?.[1]?.trim() ?? ''
  if (!line) return ''
  const bold = /\*\*([^*]+)\*\*/.exec(line)
  const before = bold ? line.slice(0, bold.index) : line
  /* 去掉挂在句末的括号 / 破折号，剩下的就是结果本身 */
  const head = before.replace(/[（(【\s—–-]+$/, '').trim()
  if (head) return head
  return bold ? bold[1].trim() : line
}

/** 副标题：从哪来的（标题优先，其次地址；去掉协议头省宽度） */
export function originOf(content: string): string {
  const text = String(content ?? '')
  const title = field(text, '标题')
  if (title) return title
  const url = field(text, 'URL') || field(text, '当前地址')
  return url ? url.replace(/^https?:\/\//, '') : ''
}

/* ══════════════════════════════════════════════════════════════
   对话文件夹的「身份」—— 让用户一眼看出这是哪个文件夹

   为什么需要：侧栏上半栏里，两个文件夹（比如 `E:\CodexWorkbench` 和 `E:\Harbor`）
   原来长得**一模一样**（折叠箭头 + 名字 + 条数），名字又都只有最后一段 ——
   同名目录（`…/a/workspace` 与 `…/b/workspace`）更是完全分不出来。

   两层身份，缺一不可：
     · **颜色**（本文件）：稳定、点缀，用来「扫一眼就能认出」
     · **路径**：文件夹的真正身份（同名目录只能靠它分），见 `folderPathHint`
     颜色只是提示，**认身份靠路径** —— 颜色只有 4 个，本来就会撞。

   ★ 这里的颜色**只用于区分文件夹**，不表达状态：
     `--danger` / `--success` / `--warning` / `--info` 是语义色，主题文件里写明了
     「只用于状态（见 statusLanguage.ts），不做装饰」。所以只用 `--accent-blue/green/
     yellow/purple` 这四支声明在「代码高亮」下的装饰性强调色 —— 它们是**唯一来源**，
     以后要加色就改这里，别在组件里写十六进制。
   ══════════════════════════════════════════════════════════════ */

/** 文件夹身份色（值就是主题变量，别在这里写死颜色） */
export const FOLDER_ACCENTS = [
  'var(--accent-blue)',
  'var(--accent-green)',
  'var(--accent-yellow)',
  'var(--accent-purple)',
] as const

/**
 * 目录 → 身份色。
 *
 * 用**稳定哈希**（不是随机数）：同一个目录无论重启多少次、无论在列表里排第几，
 * 颜色都一样；两个不同目录尽量拿到不同的色（撞了就靠路径区分，见文件头）。
 */
export function folderAccentOf(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 99991
  }
  return FOLDER_ACCENTS[hash % FOLDER_ACCENTS.length]
}

/**
 * 目录 → 一行能放下的路径提示。
 *
 * 先把分隔符归一到 `\`、去掉末尾分隔符（Windows 上看着才顺），
 * 太长的再缩成「盘符 + 最后两段」（`E:\…\tok\Harbor`）——
 * 最后两段是用户自己认得出来的那部分。UNC 路径保留 `\\` 前缀。
 */
export function folderPathHint(path: string, max = 30): string {
  const raw = String(path ?? '').trim()
  if (!raw) return ''

  const unc = /^[\\/]{2}/.test(raw)
  const segments = raw
    .replace(/[\\/]+/g, '/')
    .split('/')
    .filter(Boolean)
  if (segments.length === 0) return ''

  const full = `${unc ? '\\\\' : ''}${segments.join('\\')}`
  if (full.length <= max || segments.length <= 2) return full

  const head = /^[a-zA-Z]:$/.test(segments[0]) ? `${segments[0]}\\` : ''
  return `${head}…\\${segments.slice(-2).join('\\')}`
}

/**
 * 文件夹行悬停时显示的文字（原生 title，两行）。
 *
 * 为什么要有它：侧栏一窄，名字就被省略号截掉（`CodexWorkbe…`），而那一行的
 * title 原来只给**路径** —— 于是名字截了就没有任何一个地方能读到全名。
 * 这里两样都给：名字在上、路径在下（原生 title 里的 `\n` 就是换行）。
 *
 * 名字和路径重复时（`name` 就是最后一段目录名）只留一份，不啰嗦。
 */
export function folderHoverTitle(name: string, path: string): string {
  const n = String(name ?? '').trim()
  const p = String(path ?? '').trim()
  if (!p) return n
  if (!n || n === p) return p
  return `${n}\n${p}`
}

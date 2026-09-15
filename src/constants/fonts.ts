import type { FontFamilyId } from '@/types'

/* ══════════════════════════════════════════════════════════════
   界面字体

   中文界面上「顺不顺滑」主要看两点：
     ① 中文回退到了哪套字 —— 系统栈里英文排在前面，中文单独回退，
        落到「宋体」那种衬线体就会显得又硬又锐
     ② `-webkit-font-smoothing: antialiased` —— 它让笔画变细，
        暗色背景上尤其明显（这个开关在 index.css 里已经关掉了）

   这几套里只有「微软雅黑」是 Windows 自带的，其它要自己装。
   装了没装检测不出来（浏览器不告诉你），所以选错就回退到雅黑。
   ══════════════════════════════════════════════════════════════ */

export interface FontOption {
  id: FontFamilyId
  label: string
  /** 完整字体栈；custom 是空串，运行时拼 */
  stack: string
  hint?: string
}

/** 兜底：中文一定落到 Windows 自带的那套上 */
const FALLBACK = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'

export const FONT_OPTIONS: readonly FontOption[] = [
  {
    id: 'system',
    label: '系统默认',
    stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif`,
  },
  {
    id: 'yahei',
    label: '微软雅黑',
    stack: `"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif`,
    hint: 'Windows 自带，中文最稳',
  },
  {
    id: 'noto',
    label: '思源黑体 / Noto Sans SC',
    stack: `"Noto Sans SC", "Source Han Sans SC", "Source Han Sans CN", ${FALLBACK}`,
    hint: '需要自己装',
  },
  {
    id: 'harmony',
    label: 'HarmonyOS Sans',
    stack: `"HarmonyOS Sans SC", "HarmonyOS Sans", ${FALLBACK}`,
    hint: '需要自己装',
  },
  {
    id: 'custom',
    label: '自定义…',
    stack: '',
    hint: '填字体名本身，不带引号',
  },
]

const DEFAULT_OPTION = FONT_OPTIONS[0] as FontOption

/**
 * 算出实际要用的字体栈。
 *
 * 自定义那项只填字体名（用户不会写完整栈），所以这里补上兜底，
 * 免得名字打错之后整个界面掉到浏览器默认衬线体上。
 */
export function fontStackFor(id: FontFamilyId, custom = ''): string {
  if (id === 'custom') {
    const name = custom.trim().replace(/^["']|["']$/g, '')
    return name ? `"${name}", ${FALLBACK}` : DEFAULT_OPTION.stack
  }
  return FONT_OPTIONS.find((option) => option.id === id)?.stack ?? DEFAULT_OPTION.stack
}

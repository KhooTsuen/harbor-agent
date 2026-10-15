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

   ★ 这里**只写字体名，不带任何字体文件**。苹果那两套（SF Pro / 苹方）的授权
     明确禁止把它们嵌入、随软件分发，也禁止用在非 Apple 系统的产品里
     （见 https://developer.apple.com/fonts/ 的 LICENSE AGREEMENT）。
     所以本应用**不分发**它们：档位只负责「你自己装了就能选上」，
     装没装、用不用得上，由你自己负责。分发产物里一个字体文件都没有。
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
    id: 'pingfang',
    label: '苹方',
    /*
     * 名字写两遍是实测出来的：GDI 只认家族名「苹方-简」，全套名
     * 「苹方-简 常规体」会**静默**回退到新宋体；而 Chromium（DirectWrite）
     * 两个名字都能命中 PingFangSC——都写上，哪条路都能落到真字面。
     * 放到雅黑**前面**：macOS 上本来就有，Windows 上没装也不会更差（下一个就是雅黑）。
     */
    stack: `"PingFang SC", "苹方-简", ${FALLBACK}`,
    hint: 'macOS 自带；Windows 要自己装（装了才生效，否则回退雅黑）',
  },
  {
    id: 'sfpro',
    label: 'SF Pro（苹果）',
    /*
     * ⚠️ 实测（Windows headless Chromium，canvas measureText 对照不存在的字体）：
     *   · 「SF Pro」**认不出来**（跟不存在完全同宽）—— 别写这个名字；
     *   · 「SF Pro Text」「SF Pro Display」**都认得出来**（两个都要写：
     *     系统按字号自动选的家族不同，小字走 Text、大字走 Display —— 见 SF 的命名）。
     *   本机实测装的是 SF-Pro-Text-* 与 SF-Pro-Display-* 两套（各 9 字重）。
     *
     * ⚠️ 授权：SF Pro 是 Apple 字体，官方许可**只允许**用于「为 Apple 平台做 UI 稿」，
     *   明禁用于非 Apple 系统的软件、禁止嵌入分发。所以这里**只写名字、不打包字体**：
     *   用的人自己装（在自己机器上个人使用），本应用分发产物里不含任何字体文件。
     *   没装就静默回退到雅黑，不会更差。
     */
    stack: `"SF Pro Text", "SF Pro Display", "SF Pro", ${FALLBACK}`,
    hint: '苹果字体，授权只允许个人自用；要自己装（装了才生效，否则回退雅黑）',
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

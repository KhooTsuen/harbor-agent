import { useEffect } from 'react'
import { fontStackFor } from '@/constants'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { ThemeName } from '@/types'

/* ══════════════════════════════════════════════════════════════
   把设置同步到 <html> 的属性 / CSS 变量上

  从 App.tsx 抽出来的：全是「读设置 → 往 documentElement 上写」，
  和布局没关系，堆在 App 里只会让那一个文件越来越长。

  走 data-* 属性和 CSS 变量（而不是给每个组件传 props），是因为
  主题、玻璃、动效这些是**全局**的，没必要让组件树知道。
   ══════════════════════════════════════════════════════════════ */

export function useApplyAppearance(): void {
  const settings = useSettingsStore((s) => s.settings)

  useEffect(() => {
    const root = document.documentElement

    /*
     * 跟随系统时：系统是亮色就用亮色主题，否则用当前基准（default）。
     * 顺手把旧版遗留的主题名迁移掉 —— 老 localStorage 里存的是产品名当主题名。
     */
    function resolveTheme(): Exclude<ThemeName, 'system'> {
      const theme = settings.theme === ('codex' as ThemeName) ? 'default' : settings.theme
      if (theme !== 'system') return theme
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'default'
    }

    function apply(): void {
      root.dataset.theme = resolveTheme()
      syncTitleBar()
    }

    /*
     * 窗口按钮（最小化/最大化/关闭）现在画在窗口级顶栏的右上角，
     * 而 overlay 只吃纯色、CSS 变量传不进去 —— 所以换主题时把当前色值推给主进程，
     * 否则亮色主题下右上角会留一块深色补丁。
     */
    function syncTitleBar(): void {
      const style = getComputedStyle(root)
      void window.workbench?.setTitleBar({
        color: style.getPropertyValue('--bg-canvas').trim() || '#101010',
        symbolColor: style.getPropertyValue('--text-primary').trim() || '#f8f8f8',
      })
    }

    apply()

    root.dataset.glass = settings.glassmorphism ? 'on' : 'off'
    root.dataset.animations = settings.animations ? 'on' : 'off'

    /* 基准字号 16px，按百分比缩放（字号全用 rem，所以这一行能带动整屏） */
    root.style.fontSize = `${(16 * settings.fontScale) / 100}px`

    /* 字体栈：--font-sans 是唯一入口，换它整屏跟着换 */
    root.style.setProperty(
      '--font-sans',
      fontStackFor(settings.fontFamily, settings.customFontFamily),
    )

    /* 「跟随系统」时要监听系统切换 */
    if (settings.theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [
    settings.theme,
    settings.glassmorphism,
    settings.animations,
    settings.fontScale,
    settings.fontFamily,
    settings.customFontFamily,
  ])
}

import { RightPanel } from './RightPanel'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
import { useRootFontScale } from '@/hooks/useRootFontScale'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   右侧面板 + 它的拖拽条 + 折叠按钮

   单独抽出来是因为「折叠」这件事有个必须写清楚的行为：
   **折叠时不能卸载 RightPanel** —— 一卸载，里面浏览器标签的 <webview>
   底下的 webContents 就跟着销毁，展开回来网页就重新加载了。
   所以折叠只是加 `hidden`，组件一直挂在那儿。

   附带好处：`useBrowseBridge` 挂在 RightPanel 上，折叠着的时候
   Agent 的浏览请求也有人接（以前是没人接，只能干等到超时报错）。

   折叠用 display:none 而不是把宽度设成 0：不占布局，所以「展开」按钮
   照旧贴在右边；而隐藏的 webview 不会把网页视口挤成 0（实测过，
   见 CHANGELOG 0.43.0），页面不会 reflow 成移动端。
   ══════════════════════════════════════════════════════════════ */

interface Props {
  visible: boolean
  width: number
  min: number
  max: number
  onToggle: () => void
  onResize: (width: number) => void
}

export function RightPanelHost({ visible, width, min, max, onToggle, onResize }: Props) {
  /*
   * P4-3：宽度随根字号等比缩放。
   *
   * 栏宽这个 px 是写死的，而标签等 rem 尺寸会随「字号缩放」长大 ——
   * 150% 时标签被挤出栏外、进而顶出文档横向滚动条。按「当前根字号 ÷ 16」
   * 放大栏宽即可（默认 100% 时倍率恰好为 1 → 与改动前逐像素一致）。
   *
   * 存的是**用户选的 px**（未缩放，落 localStorage），只在这里换算显示值；
   * 反过来把拖拽结果除以倍率再回存 —— 所以持久化数据形状不变、无需迁移。
   */
  const scale = useRootFontScale()
  const shownWidth = Math.round(width * scale)

  return (
    <>
      {visible ? (
        <ResizeHandle
          side="left"
          label="调整右侧面板宽度"
          value={shownWidth}
          min={Math.round(min * scale)}
          max={Math.round(max * scale)}
          onChange={(next) => onResize(Math.round(next / scale))}
        />
      ) : null}

      <div className={cn('shrink-0', !visible && 'hidden')} style={{ width: shownWidth }}>
        <ErrorBoundary>
          <RightPanel />
        </ErrorBoundary>
      </div>

      {visible ? null : (
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 border-l border-line-subtle px-1 text-2xs text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
          aria-label="展开右侧面板"
          title="展开右侧面板"
        >
          ‹
        </button>
      )}
    </>
  )
}

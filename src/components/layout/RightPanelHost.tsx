import { RightPanel } from './RightPanel'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ResizeHandle } from '@/components/ui/ResizeHandle'
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
  return (
    <>
      {visible ? (
        <ResizeHandle
          side="left"
          label="调整右侧面板宽度"
          value={width}
          min={min}
          max={max}
          onChange={onResize}
        />
      ) : null}

      <div className={cn('shrink-0', !visible && 'hidden')} style={{ width }}>
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
          title="展开右侧面板（Ctrl+J）"
        >
          ‹
        </button>
      )}
    </>
  )
}

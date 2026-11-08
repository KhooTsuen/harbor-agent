import { cn } from '@/lib/utils'
import { MODELS_TABS, useModelsTabStore, type ModelsTab } from '@/stores/useModelsTabStore'

/* ══════════════════════════════════════════════════════════════
    「模型与服务商」的四个主标签

    ── 为什么这一页有二级标签 ────────────────────────────────────
    模型相关的配置有四大块，摊在一页上要滚四五屏：服务商连接（十几个字段
    每张卡）、八个场景模型、七个运行开关、协作状态。用户找「temperature」
    得先滚过全部服务商。

    分成四个标签之后每页都短，且四件事的**读者不同**：
      · 服务商      配一次就不动了
      · 模型与场景  换模型时才来
      · 运行策略    调行为时才来
      · 双模型协作  用不用多模型

    ★ 和左侧 13 页导航是同一个模式（一个 roving tabindex 的 listbox），
      键盘 ↑↓ 也能走完，不用鼠标。
    ══════════════════════════════════════════════════════════════ */

const LABELS: Record<ModelsTab, string> = {
  providers: '服务商',
  scenes: '模型与场景',
  policy: '运行策略',
  collab: '双模型协作',
}

export function ModelsTabs(): React.ReactElement {
  const current = useModelsTabStore((s) => s.tab)
  const setTab = useModelsTabStore((s) => s.setTab)

  const step = (delta: number): void => {
    const at = MODELS_TABS.indexOf(current)
    const next = Math.min(MODELS_TABS.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))
    setTab(MODELS_TABS[next])
  }

  return (
    <div
      role="tablist"
      aria-label="模型与服务商的分类"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          step(1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          step(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          setTab(MODELS_TABS[0])
        } else if (event.key === 'End') {
          event.preventDefault()
          setTab(MODELS_TABS[MODELS_TABS.length - 1])
        }
      }}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-subtle pb-2"
    >
      {MODELS_TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={current === id}
          tabIndex={current === id ? 0 : -1}
          onClick={() => setTab(id)}
          className={cn(
            'shrink-0 rounded-sm px-3 py-1.5 text-dense transition-colors duration-fast',
            current === id
              ? 'bg-bg-raised text-fg-primary'
              : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
          )}
        >
          {LABELS[id]}
        </button>
      ))}
    </div>
  )
}

import { useEffect, useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConfigSaveStatus } from '@/stores/configSaveStatus'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { resetAllSettings } from '@/lib/resetAllSettings'
import { SETTINGS_NAV, type SettingsTabDef } from './settingsNav'

/* ══════════════════════════════════════════════════════════════
   设置工作区 · 一页的外框

   ── 内容宽度由这一处决定（第二阶段）────────────────────────────
   第一阶段用的是 `max-w-3xl`（768px），减去两侧 64px 后实际只有约 700px，
   在 1400px+ 的窗口里右边大片空白，说明文字被挤成四行。
   现在收到 `max-w-[1000px]`：常规页一行能放下「名称 + 说明 + 控件」，
   同时不会把输入框拉成横跨半屏的长条。

   ★ 宽度**只写在这里**，各页不许自己写像素值。内容特别宽的页用
     `wide` 道具调一档，而不是改基础宽度（改了会把 11 个页一起带偏）。

   ── 保存状态改成按需出现（第二阶段）────────────────────────────
   以前常驻一行「修改配置后自动保存 / 配置已自动保存」—— 每页都占一条
   视觉噪音，而且「已保存」长期挂着会让人以为那句话本身是个按钮。
   现在：idle 不渲染；saving / failed 立刻出现；saved 只闪 1.8 秒。
   ══════════════════════════════════════════════════════════════ */

/** 内容区最大宽度（常规页）。改这里 = 改全部 13 页 */
const CONTENT_MAX = 'max-w-[1000px]'
/** 宽表 / 双列页用这一档 */
const CONTENT_WIDE = 'max-w-[1180px]'

export interface SettingsPageProps {
  tab: SettingsTabDef
  children: ReactNode
  /** 内容特别宽（宽表、双列）时用一档更宽的容器 */
  wide?: boolean
}

/** 页头右侧的动作：重置设置（唯一实现见 lib/resetAllSettings.ts） */
export function ResetAction(): React.ReactElement {
  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<RotateCcw size={13} />}
      onClick={() => {
        askPermission({
          kind: 'clear-data',
          title: '重置所有设置？',
          description:
            '界面偏好（主题、布局宽度、开关）和后端配置（默认工作目录、权限、供应商）都会回到默认值。对话、记忆和任务记录不受影响。',
          confirmText: '重置设置',
          danger: true,
          onConfirm: () => {
            void (async () => {
              const result = await resetAllSettings()
              const level =
                result.outcome === 'ok'
                  ? 'success'
                  : result.outcome === 'partial'
                    ? 'info'
                    : 'error'
              showToast(level, result.message, result.detail)
            })()
          },
        })
      }}
    >
      重置设置
    </Button>
  )
}

/**
 * 保存状态 —— **按需出现**，不常驻。
 *
 * 三种情况才显示：正在保存 / 保存失败 / 刚保存成功（1.8 秒后自己消失）。
 * 失败必须一直挂着：用户改了东西却不知道没写进去，是最坏的体验。
 */
function SaveStatus(): React.ReactElement | null {
  const state = useConfigSaveStatus((s) => s.state)
  const [savedVisible, setSavedVisible] = useState(false)

  useEffect(() => {
    if (state !== 'saved') {
      setSavedVisible(false)
      return
    }
    setSavedVisible(true)
    const timer = window.setTimeout(() => setSavedVisible(false), 1800)
    return () => window.clearTimeout(timer)
  }, [state])

  if (state === 'saving') {
    return (
      <p role="status" className="mb-3 text-dense text-fg-secondary">
        正在保存…
      </p>
    )
  }
  if (state === 'failed') {
    return (
      <p
        role="alert"
        className="mb-3 rounded-sm border border-line-hairline bg-bg-raised/40 px-3 py-2 text-dense leading-relaxed text-danger"
      >
        保存失败 —— 这次改动没有写进配置。检查数据目录是否可写，或再改一次重试。
      </p>
    )
  }
  if (savedVisible) {
    return (
      <p role="status" className="mb-3 text-dense text-fg-secondary">
        已保存
      </p>
    )
  }
  return null
}

export function SettingsPage({ tab, children, wide }: SettingsPageProps): React.ReactElement {
  const settingsView = useSettingsStore((s) => s.settings.settingsView)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  /* 简洁视图下被收起来的页 —— 进来时仍然看得见，并告诉用户为什么它在「专业」里 */
  const hidden = settingsView !== 'detailed' && tab.detailedOnly === true
  const maxWidth = wide ? CONTENT_WIDE : CONTENT_MAX

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line-subtle px-8 py-3.5">
        <div className={`mx-auto flex w-full ${maxWidth} items-start gap-4`}>
          <div className="min-w-0 flex-1">
            <h1 className="text-body font-semibold tracking-tight text-fg-primary">{tab.label}</h1>
            <p className="mt-1 max-w-[62ch] text-dense leading-relaxed text-fg-secondary">
              {tab.blurb}
            </p>
          </div>
          <div className="shrink-0 pt-0.5">
            <ResetAction />
          </div>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-8 py-5"
        /* 页 id 落在 DOM 上：测试与「跳到某页」都靠它认页，不靠文案 */
        data-settings-page={tab.id}
      >
        <div className={`mx-auto w-full ${maxWidth}`}>
          {hidden ? (
            <p className="mb-3 rounded-sm border border-line-hairline bg-bg-raised/30 px-2.5 py-2 text-dense leading-relaxed text-fg-secondary">
              这一页的功能
              <strong className="font-semibold">始终在生效</strong>
              ，只是默认收在「详细视图」里。
              <button
                type="button"
                className="ml-1 underline hover:text-fg-primary"
                onClick={() => updateSettings({ settingsView: 'detailed' })}
              >
                切到详细视图
              </button>
              后左侧会把它标成常用。
            </p>
          ) : null}
          <SaveStatus />
          <div className="settings-body">{children}</div>
        </div>
      </div>
    </div>
  )
}

/** 给上层用：按 id 取导航项（取不到返回 undefined，调用方回落首页） */
export function navItemOf(id: string): SettingsTabDef | undefined {
  return SETTINGS_NAV.find((item) => item.id === id)
}

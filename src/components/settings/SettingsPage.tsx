import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConfigSaveStatus } from '@/stores/configSaveStatus'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { resetAllSettings } from '@/lib/resetAllSettings'
import { SETTINGS_NAV, type SettingsTabDef } from './settingsNav'

/* ══════════════════════════════════════════════════════════════
   设置工作区 · 一页的外框

   ── 统一的三段结构 ────────────────────────────────────────────
     ① 页头：标题 + 一句话说明 +（右侧）这一阶段要显眼的动作
     ② 保存状态：配置自动保存 / 失败 —— 每页都有，不是只放首页
     ③ 内容：`.settings-body` + 受控最大宽度

   ── 为什么要有最大宽度 ────────────────────────────────────────
   工作区比原来的弹窗宽得多。不限宽时输入框会被拉成一条横跨半屏的
   长条（原弹窗里靠 `Row` 的 `max-w-2xl` 挡着，但那只管控件不管整页）。
   这里按 `max-w-3xl` 收住正文，两侧留白交给居中 —— 和常见设置页一致。

   ── 保存状态为什么在两处都有 ──────────────────────────────────
   原来只在弹窗里显示一次。工作区里用户可能整场都在这一页改东西，
   看不到「保存失败」就等于不知道改动没进去。
   ══════════════════════════════════════════════════════════════ */

export interface SettingsPageProps {
  tab: SettingsTabDef
  children: ReactNode
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

/** 保存状态那一行 —— 三态各说各的话，失败要说清去哪儿查 */
function SaveStatus(): React.ReactElement {
  const state = useConfigSaveStatus((s) => s.state)
  return (
    <p
      role="status"
      className={`mb-2 text-xs ${state === 'failed' ? 'text-danger' : 'text-fg-tertiary'}`}
    >
      {state === 'saving'
        ? '配置正在保存…'
        : state === 'failed'
          ? '配置保存失败。请检查数据目录或重试修改。'
          : state === 'saved'
            ? '配置已自动保存'
            : '修改配置后自动保存'}
    </p>
  )
}

export function SettingsPage({ tab, children }: SettingsPageProps): React.ReactElement {
  const settingsView = useSettingsStore((s) => s.settings.settingsView)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  /* 简洁视图下被收起来的页 —— 进来时仍然看得见，并告诉用户为什么它在「专业」里 */
  const hidden = settingsView !== 'detailed' && tab.detailedOnly === true

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line-subtle px-8 py-4">
        <div className="mx-auto flex w-full max-w-3xl items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-fg-primary">{tab.label}</h1>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-tertiary">{tab.blurb}</p>
          </div>
          <div className="shrink-0 pt-0.5">
            <ResetAction />
          </div>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-8 py-4"
        /* 页 id 落在 DOM 上：测试与「跳到某页」都靠它认页，不靠文案 */
        data-settings-page={tab.id}
      >
        <div className="mx-auto w-full max-w-3xl">
          {hidden ? (
            <p className="mb-2 rounded-sm border border-line-hairline bg-bg-raised/30 px-2 py-1.5 text-2xs leading-relaxed text-fg-secondary">
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

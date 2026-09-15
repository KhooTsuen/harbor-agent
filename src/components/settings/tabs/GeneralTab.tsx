import { useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { quitApp } from '@/lib/appApi'
import { useRealBackend } from '@/lib/backend'
import { MODES } from '@/constants'
import { clamp } from '@/lib/utils'
import type { ThreadMode } from '@/types'
import { Button } from '@/components/ui/Button'
import { Select, Switch } from '@/components/ui/Field'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 通用

   界面语言、发送方式、默认模式和字号。
   除了重置数据，每一项都实时生效并落盘。
   ══════════════════════════════════════════════════════════════ */

export function GeneralTab() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)
  const resetAll = useAppStore((s) => s.resetAll)
  const isReal = useRealBackend
  const config = useConfigStore((s) => s.config)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)

  return (
    <>
      <>
        <Row label="回车发送" hint="关掉后 Enter 换行，用 Ctrl/Cmd+Enter 发送">
          <Switch
            checked={settings.sendOnEnter}
            onChange={(v) => updateSettings({ sendOnEnter: v })}
            label="回车发送消息"
          />
        </Row>

        <Row
          label="默认模式"
          hint="新建对话时用哪个模式。会不会弹窗问你要确认，由「工具」页的权限档位决定"
        >
          <Select
            value={settings.defaultMode}
            onChange={(v) => updateSettings({ defaultMode: v as ThreadMode })}
            options={MODES.map((m) => ({ value: m.id, label: `${m.label} —— ${m.hint}` }))}
          />
        </Row>

        <Row label="字号缩放" hint={`${settings.fontScale}%（80 - 150）`}>
          <input
            type="range"
            min={80}
            max={150}
            step={5}
            value={settings.fontScale}
            onChange={(e) => updateSettings({ fontScale: clamp(Number(e.target.value), 80, 150) })}
            aria-label="字号缩放"
            className="w-full accent-[var(--accent-blue)]"
          />
        </Row>

        {/* 桌面版没有「重置演示数据」这回事，标题也就不该空挂着 */}
        {!isReal ? (
          <>
            <SectionTitle>数据</SectionTitle>
            <Row
              label="重置本地演示数据"
              hint="仅浏览器开发预览模式可用；桌面版数据请在「数据」页管理"
            >
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  askPermission({
                    kind: 'clear-data',
                    title: '重置本地预览数据？',
                    description: '这只会清除浏览器里的预览数据，不会影响桌面版数据。',
                    confirmText: '重置',
                    danger: true,
                    onConfirm: () => {
                      resetAll()
                      showToast('success', '本地预览数据已重置')
                    },
                  })
                }
              >
                重置
              </Button>
            </Row>
          </>
        ) : null}
        {/* 窗口与托盘：只有桌面版有窗口这回事 */}
        {isReal ? (
          <>
            <SectionTitle>窗口与托盘</SectionTitle>

            <Row
              label="关闭时最小化到托盘"
              hint="点 × 只是把窗口收到托盘，任务继续跑；点托盘图标能再打开。想直接退出用下面的按钮"
            >
              <Switch
                checked={config?.general.minimizeToTray !== false}
                onChange={(v) => void patchGeneral({ minimizeToTray: v })}
                label="关闭时最小化到托盘"
              />
            </Row>

            <Row label="退出" hint="关掉窗口并结束后台进程">
              <Button variant="danger" size="sm" onClick={() => void quitApp()}>
                退出
              </Button>
            </Row>
          </>
        ) : null}
      </>
    </>
  )
}

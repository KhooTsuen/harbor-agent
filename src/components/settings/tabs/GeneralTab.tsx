import { useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { quitApp } from '@/lib/appApi'
import { useRealBackend } from '@/lib/backend'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Field'
import { Row, SectionTitle } from '../parts'
import { ShortcutsTab } from '../tabs/ShortcutsTab'

/* ══════════════════════════════════════════════════════════════
   设置 → 通用与快捷键

   ── 第二阶段：只留「应用本身怎么用」────────────────────────────
   这一页原来混了三类东西，用户要在同一屏里分辨「这条是改应用、
   还是改 Agent、还是改浏览器」。现在按真实归属拆开：

     · 回车发送            留下（输入行为，属于应用本身）
     · 关闭最小化到托盘     留下（窗口行为）
     · 退出                留下（危险操作，单独一组）
     · 快捷键              留下（应用本身）
     · 默认模式            → 「对话与任务」（新对话怎么进行）
     · 自动起标题           → 「对话与任务」（对话流程里的一步）
     · 网页里的链接         → 「工具与扩展」（Agent 访问网页的放行策略）

   ★ 迁移后这里**不再有**这几个控件 —— 两处同时能改同一份配置，
     迟早出现「改了一处另一处没变」的鬼故事。
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
      <SectionTitle hint="发送消息时的键盘行为">输入与发送</SectionTitle>

      <Row label="回车发送" hint="关掉后 Enter 换行，用 Ctrl/Cmd+Enter 发送">
        <Switch
          checked={settings.sendOnEnter}
          onChange={(v) => updateSettings({ sendOnEnter: v })}
          label="回车发送消息"
        />
      </Row>

      {/* 窗口与托盘：只有桌面版有窗口这回事 */}
      {isReal ? (
        <>
          <SectionTitle hint="点关闭按钮时应用怎么反应">窗口与托盘</SectionTitle>

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
        </>
      ) : null}

      <ShortcutsTab />

      {/* 危险操作单独成组、单独标红 —— 不和应用偏好混排 */}
      {isReal ? (
        <>
          <SectionTitle hint="会结束后台进程；正在跑的任务会停下">退出应用</SectionTitle>
          <Row
            label="退出 Harbor"
            hint="关掉窗口并结束后台进程。只是想暂时收起窗口，用上面的托盘开关"
            danger
          >
            <Button variant="danger" size="sm" onClick={() => void quitApp()}>
              退出
            </Button>
          </Row>
        </>
      ) : null}

      {/* 桌面版没有「重置演示数据」这回事，标题也就不该空挂着 */}
      {!isReal ? (
        <>
          <SectionTitle hint="仅浏览器开发预览可用">演示数据</SectionTitle>
          <Row
            label="重置本地演示数据"
            hint="仅浏览器开发预览模式可用；桌面版数据请在「数据与存储」页管理"
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
    </>
  )
}

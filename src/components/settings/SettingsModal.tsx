import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SETTINGS_TABS, type SettingsTabId } from './parts'
import { AboutTab } from './tabs/AboutTab'
import { MemoryTab } from './tabs/MemoryTab'
import { GeneralPanel } from './panels/GeneralPanel'
import { ConversationPanel } from './panels/ConversationPanel'
import { AccessPanel } from './panels/AccessPanel'
import { DataUsagePanel } from './panels/DataUsagePanel'
import { ExtensionPanel } from './panels/ExtensionPanel'
import { ModelsPanel } from './panels/ModelsPanel'
import { AppearanceTab } from './tabs/AppearanceTab'

/* ══════════════════════════════════════════════════════════════
   设置

   标签页清单在 parts.tsx 的 SETTINGS_TABS 里（现在 9 个，分「常用 / 高级」两组）
   —— 别在这里再列一遍，列了就会过期（这句注释曾经写着「五个标签」，后来写着「12 个」）。
   加新标签：改 parts.tsx 的清单 + 下面加一个分支 + 新建对应组件。
   外观里那几个开关是「有真实效果」的：
     · 主题      → 改 <html data-theme>
     · 玻璃拟态  → 改 <html data-glass>
     · 动效      → 改 <html data-animations>
     · 字号      → 改 <html style="font-size">
   ══════════════════════════════════════════════════════════════ */

export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const showToast = useUIStore((s) => s.showToast)
  const askPermission = useUIStore((s) => s.askPermission)

  const resetSettings = useSettingsStore((s) => s.resetSettings)

  const [tab, setTab] = useState<SettingsTabId>('general')
  return (
    <Modal
      open={open}
      onClose={closeSettings}
      title="设置"
      description="改完立刻生效，配置存本机"
      width="2xl"
      /*
       * 固定高度：不传的话弹窗会随标签页内容变高变矮，
       * 切来切去像在跳。内容超出由内部滚动。
       */
      height="h-[min(880px,88vh)]"
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={13} />}
            onClick={() => {
              askPermission({
                kind: 'clear-data',
                title: '恢复所有默认设置？',
                description: '主题、布局宽度、开关都会回到初始状态。对话数据不受影响。',
                confirmText: '恢复默认',
                danger: true,
                onConfirm: () => {
                  resetSettings()
                  showToast('success', '设置已恢复默认')
                },
              })
            }}
          >
            恢复默认
          </Button>
          <Button variant="primary" size="sm" onClick={closeSettings}>
            完成
          </Button>
        </>
      }
    >
      {/*
        h-full + 左右各自滚动：
        左边标签栏固定不动，只有右边的设置内容滚。
        不这么写的话（外层整体滚），滚到一半标签栏也跟着跑，很难用。
      */}
      <div className="flex h-full gap-5">
        {/* 左侧标签 */}
        <nav className="w-32 shrink-0 overflow-y-auto" aria-label="设置分类">
          <ul className="flex flex-col gap-0.5">
            {/*
              按 group 分段渲染。分组标题只是视觉分隔 —— 不分组的话
              9 个标签平铺着看还是一片，用户仍然要靠猜。
            */}
            {SETTINGS_TABS.map(({ id, label, icon: Icon, group }, index) => {
              const prev = SETTINGS_TABS[index - 1]
              const startsGroup = Boolean(group) && prev?.group !== group
              return (
                <li key={id}>
                  {startsGroup ? (
                    <p className="mb-0.5 mt-2 px-2 text-2xs text-fg-tertiary first:mt-0">{group}</p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setTab(id)}
                    aria-current={tab === id}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors duration-fast',
                      tab === id
                        ? 'bg-bg-raised text-fg-primary'
                        : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                    )}
                  >
                    <Icon size={14} className="shrink-0" />
                    {label}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* 右侧内容 */}
        <div className="settings-body min-w-0 flex-1 overflow-y-auto pr-1.5">
          {tab === 'general' ? <GeneralPanel /> : null}
          {tab === 'appearance' ? <AppearanceTab /> : null}
          {tab === 'conversation' ? <ConversationPanel /> : null}
          {tab === 'models' ? <ModelsPanel /> : null}
          {tab === 'access' ? <AccessPanel /> : null}
          {tab === 'datausage' ? <DataUsagePanel /> : null}
          {tab === 'extension' ? <ExtensionPanel /> : null}
          {tab === 'memory' ? <MemoryTab /> : null}
          {tab === 'about' ? <AboutTab /> : null}
        </div>
      </div>
    </Modal>
  )
}

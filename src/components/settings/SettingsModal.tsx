import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { cn, eventToCombo, formatKeys } from '@/lib/utils'
import { SHORTCUTS } from '@/constants'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SectionTitle, SETTINGS_TABS, type SettingsTabId } from './parts'
import { AboutTab } from './tabs/AboutTab'
import { DataTab } from './tabs/DataTab'
import { GeneralTab } from './tabs/GeneralTab'
import { SkillsTab } from './tabs/SkillsTab'
import { MemoryTab } from './tabs/MemoryTab'
import { McpTab } from './tabs/McpTab'
import { SearchPanel } from './tabs/SearchPanel'
import { UsageTab } from './tabs/UsageTab'
import { AppearanceTab } from './tabs/AppearanceTab'
import { ScenesTab } from './tabs/ScenesTab'
import { SecurityTab } from './tabs/SecurityTab'
import { ProjectContextTab } from './tabs/ProjectContextTab'
import { ThreadSettingsTab } from './tabs/ThreadSettingsTab'
import { AssistantPanel, ProviderPanel, ToolsPanel } from './ProviderPanel'

/* ══════════════════════════════════════════════════════════════
   设置

   标签页清单在 parts.tsx 的 NAV 里（现在 12 个）—— 别在这里再列一遍，
   列了就会过期（这句注释就曾经写着“五个标签”）。
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

  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const resetSettings = useSettingsStore((s) => s.resetSettings)

  const [tab, setTab] = useState<SettingsTabId>('general')
  const [recording, setRecording] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(null)
        return
      }
      const combo = eventToCombo(event)
      if (!combo) return
      const conflict = Object.entries(settings.shortcutKeys).find(
        ([id, value]) => id !== recording && value === combo,
      )
      if (conflict) {
        showToast(
          'warning',
          '快捷键冲突',
          `已经绑定给「${SHORTCUTS.find((s) => s.id === conflict[0])?.label ?? conflict[0]}」`,
        )
        return
      }
      updateSettings({ shortcutKeys: { ...settings.shortcutKeys, [recording]: combo } })
      setRecording(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, settings.shortcutKeys, showToast, updateSettings])

  const shortcutFor = (id: string, fallback: string) => settings.shortcutKeys[id] ?? fallback

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
            {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
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
            ))}
          </ul>
        </nav>

        {/* 右侧内容 */}
        <div className="min-w-0 flex-1 overflow-y-auto pr-1 divide-y divide-line-subtle">
          {tab === 'general' ? <GeneralTab /> : null}

          {tab === 'appearance' ? <AppearanceTab /> : null}

          {tab === 'shortcuts' ? (
            <>
              <p className="py-2 text-xs leading-relaxed text-fg-secondary">
                点击任意键位即可录制新的组合键；按 Esc 取消。冲突键位会被拒绝。
              </p>
              {Array.from(new Set(SHORTCUTS.map((s) => s.group))).map((group) => (
                <div key={group} className="py-2">
                  <SectionTitle>{group}</SectionTitle>
                  <ul className="mt-2 flex flex-col gap-0.5">
                    {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
                      <li
                        key={shortcut.id}
                        className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm text-fg-secondary hover:bg-bg-hover"
                      >
                        <span>{shortcut.label}</span>
                        <button
                          type="button"
                          onClick={() => setRecording(shortcut.id)}
                          className={cn(
                            'rounded-sm border px-2 py-0.5 font-mono text-2xs transition-colors',
                            recording === shortcut.id
                              ? 'border-line-focus bg-bg-hover text-fg-primary'
                              : 'border-line-subtle bg-bg-raised text-fg-primary hover:border-line-focus',
                          )}
                        >
                          {recording === shortcut.id
                            ? '请按键…'
                            : formatKeys(
                                shortcutFor(shortcut.id, shortcut.defaultKeys),
                                navigator.platform.toLowerCase().includes('mac'),
                              )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          ) : null}

          {tab === 'scenes' ? <ScenesTab /> : null}

          {tab === 'models' ? (
            <>
              <SectionTitle>供应商</SectionTitle>
              <div className="py-2">
                <ProviderPanel />
              </div>

              <SectionTitle>助手参数</SectionTitle>
              <div className="py-2">
                <AssistantPanel />
              </div>
            </>
          ) : null}

          {tab === 'tools' ? (
            <>
              <div className="py-3">
                <ToolsPanel />
              </div>
              <SectionTitle>联网搜索</SectionTitle>
              <div className="py-3">
                <SearchPanel />
              </div>
            </>
          ) : null}

          {tab === 'security' ? <SecurityTab /> : null}

          {tab === 'skills' ? <SkillsTab /> : null}

          {tab === 'memory' ? <MemoryTab /> : null}

          {tab === 'mcp' ? <McpTab /> : null}

          {tab === 'usage' ? <UsageTab /> : null}

          {tab === 'data' ? <DataTab /> : null}

          {tab === 'project' ? <ProjectContextTab /> : null}

          {tab === 'thread' ? <ThreadSettingsTab /> : null}

          {tab === 'about' ? <AboutTab /> : null}
        </div>
      </div>
    </Modal>
  )
}

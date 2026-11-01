import { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SETTINGS_TABS, hiddenTabsOf, visibleTabsOf, type SettingsTabId } from './parts'
import { AboutTab } from './tabs/AboutTab'
import { MemoryTab } from './tabs/MemoryTab'
import { ProfileTab } from './tabs/ProfileTab'
import { GeneralPanel } from './panels/GeneralPanel'
import { ConversationPanel } from './panels/ConversationPanel'
import { AccessPanel } from './panels/AccessPanel'
import { DataUsagePanel } from './panels/DataUsagePanel'
import { ExtensionPanel } from './panels/ExtensionPanel'
import { ModelsPanel } from './panels/ModelsPanel'
import { AppearanceTab } from './tabs/AppearanceTab'
import { SettingsSearchBox } from './SettingsSearchBox'
import { useConfigSaveStatus } from '@/stores/configSaveStatus'
import { resetAllSettings } from '@/lib/resetAllSettings'

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

  const configSaveState = useConfigSaveStatus((s) => s.state)
  const settingsView = useSettingsStore((s) => s.settings.settingsView)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [tab, setTab] = useState<SettingsTabId>('general')
  /*
   * 「调整权限」这类入口会指定要落在哪一页（AG-042 真机反馈：只打开设置、
   * 停在「通用」，用户以为点不开）。这里是**打开时**同步一次，
   * 之后用户自己点分类不会被它抢回去。
   */
  const wantedTab = useUIStore((s) => s.settingsTab)
  useEffect(() => {
    if (open && wantedTab) setTab(wantedTab as SettingsTabId)
  }, [open, wantedTab])

  /* P2 #1：简洁视图不列 detailedOnly 的标签；但用户被指到那一页时仍要能进去 */
  const visibleTabs = useMemo(
    () => visibleTabsOf(SETTINGS_TABS, settingsView, tab),
    [settingsView, tab],
  )
  /* 简洁视图下被收起来的那些页 —— 顶部点名，别让它们悄悄生效 */
  const hiddenTabs = useMemo(() => hiddenTabsOf(SETTINGS_TABS, settingsView), [settingsView])

  /*
   * P3 #20：设置搜索。
   *
   * `query` 只是界面状态 —— 搜什么、点哪条，都**不改任何配置**
   * （文档验收要求「搜索与视图切换不更改配置值、权限或默认模式」）。
   */
  const [query, setQuery] = useState('')
  const tabOf = useCallback((id: SettingsTabId) => SETTINGS_TABS.find((item) => item.id === id), [])

  return (
    <Modal
      open={open}
      onClose={closeSettings}
      title="设置"
      description="设置自动保存到本机；保存结果显示在下方"
      width="2xl"
      /*
       * 固定高度：不传的话弹窗会随标签页内容变高变矮，
       * 切来切去像在跳。内容超出由内部滚动。
       */
      height="h-[min(880px,88vh)]"
      footer={
        <>
          {/*
            第二阶段：这是**唯一**的重置入口实现（lib/resetAllSettings.ts）。
            它同时重置本地界面偏好**和**后端配置，并按真实结果给话 ——
            后端失败时说「只重置了一部分」，不再报「设置已恢复默认」。
            名称与「数据与用量 → 重置设置」一致，两处说的都是同一个范围。
          */}
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
            {visibleTabs.map(({ id, label, icon: Icon, group }, index) => {
              const prev = visibleTabs[index - 1]
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
          {/* P3 #20：搜索框在最上面 —— 找不到东西时第一反应就是搜 */}
          <SettingsSearchBox
            query={query}
            onQueryChange={setQuery}
            tabOf={tabOf}
            view={settingsView}
            onPick={(entry) => {
              setTab(entry.tab)
              /* 点了结果就收起结果列表（否则结果压着那一页，用户还得自己关） */
              setQuery('')
            }}
          />
          {/*
            P2 #1：简洁视图必须**点名**那些被收起、但仍在生效的专业设置 ——
            否则「看不到」会被理解成「没启用」，用户改了个行为却找不到原因。
            这里只提示 + 给一个直达入口，不复制那些设置本身。
          */}
          {hiddenTabs.length > 0 ? (
            <p className="mb-2 rounded-sm border border-line-hairline bg-bg-raised/30 px-2 py-1.5 text-2xs leading-relaxed text-fg-secondary">
              另有 {hiddenTabs.map((item) => item.label).join('、')} 等专业设置
              <strong className="font-semibold">仍在生效</strong>。
              <button
                type="button"
                className="ml-1 underline hover:text-fg-primary"
                onClick={() => updateSettings({ settingsView: 'detailed' })}
              >
                切到详细视图
              </button>
              查看或调整。
            </p>
          ) : null}
          <p
            role="status"
            className={`mb-2 text-xs ${configSaveState === 'failed' ? 'text-danger' : 'text-fg-tertiary'}`}
          >
            {configSaveState === 'saving'
              ? '配置正在保存…'
              : configSaveState === 'failed'
                ? '配置保存失败。请检查数据目录或重试修改。'
                : configSaveState === 'saved'
                  ? '配置已自动保存'
                  : '修改配置后自动保存'}
          </p>
          {tab === 'profile' ? <ProfileTab /> : null}
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

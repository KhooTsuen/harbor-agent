import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SETTINGS_TABS, hiddenTabsOf, type SettingsTabId } from './parts'
import { settingsPageOf } from './settingsPages'
import { SETTINGS_HOME, isSettingsTabId } from './settingsNav'
import { SettingsSearchBox } from './SettingsSearchBox'
import { SettingsNavRail } from './SettingsNavRail'
import { ResetAction } from './SettingsPage'
import { useConfigSaveStatus } from '@/stores/configSaveStatus'
import { experienceStats } from '@/lib/experienceApi'

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

  const configSaveState = useConfigSaveStatus((s) => s.state)
  const settingsView = useSettingsStore((s) => s.settings.settingsView)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [tab, setTab] = useState<SettingsTabId>(SETTINGS_HOME)
  /*
   * 「调整权限」这类入口会指定要落在哪一页（AG-042 真机反馈：只打开设置、
   * 停在「通用」，用户以为点不开）。这里是**打开时**同步一次，
   * 之后用户自己点分类不会被它抢回去。
   * ★ 脏值回落首页 —— 老版本可能存了已经不存在的页 id。
   */
  const wantedTab = useUIStore((s) => s.settingsTab)
  useEffect(() => {
    if (open && isSettingsTabId(wantedTab)) setTab(wantedTab)
  }, [open, wantedTab])

  /* 简洁视图下被收起来的那些页 —— 顶部点名，别让它们悄悄生效 */
  const hiddenTabs = useMemo(() => hiddenTabsOf(SETTINGS_TABS, settingsView), [settingsView])

  /*
   * 经验页被收起时，**点名「有 N 条等你处理」**。
   *
   * 为什么必须有（真机走出来的）：设置默认是简洁视图，「经验与规则」在详细视图里，
   * 于是审批入口默认是**收着**的 —— 一条候选攒在那儿等人拍板，用户根本不知道。
   * 这一行只说「有几条」并给直达按钮，**不复制那一页的内容**（同 P2 #1 的口径）。
   *
   * 数据走 `stats.byStatus`（主进程算好的分布），前端不自己数状态 ——
   * 「什么算待处理」只有 `schema` 一处口径。
   */
  const [pendingExperience, setPendingExperience] = useState(0)
  const needsExperience =
    settingsView !== 'detailed' || hiddenTabs.some((item) => item.id === 'experience')
  useEffect(() => {
    if (!open || !needsExperience) return
    let alive = true
    void (async () => {
      const stats = await experienceStats()
      if (alive) setPendingExperience(stats.byStatus.candidate ?? 0)
    })()
    return () => {
      alive = false
    }
  }, [open, needsExperience, tab])

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
          {/* 重置设置：与工作区页头那个是**同一个组件**（唯一实现，两处不漂） */}
          <ResetAction />
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
        {/* 左侧标签 —— 与工作区共用同一个导航组件（一处定义，两处不漂） */}
        <SettingsNavRail current={tab} onPick={setTab} />

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
          {/*
            待审批的经验**必须点名**（真机走出来的缺口）：「经验与规则」在详细视图里，
            而设置默认是简洁视图 —— 一条候选攒在那儿等人拍板，用户根本不知道。
            只在真的有东西等的时候出现（0 条时一个字都不显示，避免噪音）。
          */}
          {needsExperience && pendingExperience > 0 ? (
            <p className="mb-2 rounded-sm border border-line-hairline bg-bg-raised/30 px-2 py-1.5 text-2xs leading-relaxed text-fg-secondary">
              有 <strong className="font-semibold">{pendingExperience}</strong> 条经验在等你处理
              （系统学到了、但还没被确认，现在**不会**进提示）。
              <button
                type="button"
                className="ml-1 underline hover:text-fg-primary"
                aria-label="去处理待审批的经验"
                onClick={() => {
                  updateSettings({ settingsView: 'detailed' })
                  setTab('experience')
                }}
              >
                去处理
              </button>
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
          {settingsPageOf(tab)}
        </div>
      </div>
    </Modal>
  )
}

import type { FontFamilyId, ThemePreference } from '@/types'
import { FONT_OPTIONS, LAYOUT } from '@/constants'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { Field, Select, Switch } from '@/components/ui/Field'
import { clamp } from '@/lib/utils'
import { useWindowWidth } from '@/hooks/useWindowWidth'
import { rightPanelMaxShown } from '@/lib/layoutWidth'
import { Row, RowStack, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 外观与通知

   ── 第二阶段重排：五组，按「改完立刻看见什么」排 ──────────────
     ① 主题与配色  最常改，也最影响观感
     ② 字体与字号  字体预览放这里（原来它孤零零夹在两行之间）
     ③ 布局尺寸    侧栏 / 右栏宽度
     ④ 动效与材质  玻璃拟态、动效、启动页动画
     ⑤ 通知        只有一个编辑入口（见下）

   ── 通知为什么只有一个入口 ────────────────────────────────────
   每一类通知去哪儿（弹卡片 / 进右栏 / 都不要）**只有右栏「通知」标签**
   那一处能改。这一页只放一个跳转按钮 + 一句状态说明 ——
   两个独立入口改同一份配置，迟早出现「这边改了那边没变」。
   跳转不是第二份配置，它只是把用户带到唯一那个地方。

   ── 启动页动画为什么归在「动效」而不是「通用」──────────────────
   它改的是**看到的动画**，和动效开关是同一类；放通用页的话
   用户找「怎么关掉开屏」时得先猜它在哪一类。
   ══════════════════════════════════════════════════════════════ */

export function AppearanceTab() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  /*
   * 右栏的实际上限是**动态**的（窗口 − 侧栏 − 中栏保底），所以滑杆的 max
   * 与提示都按它算 —— 否则会显示成一个拖不到的 1200，误导人。
   * 算法唯一源：`lib/layoutWidth.ts`。
   */
  const windowWidth = useWindowWidth()
  const rightMax = Math.min(
    LAYOUT.rightPanel.max,
    rightPanelMaxShown({
      windowWidth,
      sidebarWidth: settings.sidebarCollapsed ? LAYOUT.sidebar.collapsed : settings.sidebarWidth,
      reserve: LAYOUT.centerReserve,
      minShown: LAYOUT.rightPanel.min,
    }),
  )

  return (
    <>
      <SectionTitle hint="改完立刻生效，不用重启">主题与配色</SectionTitle>

      <Row
        label="配色"
        hint="default 是当前基准；chatgpt 是 ChatGPT 桌面端的基准值；跟随系统会随系统深浅色切换"
      >
        <Select
          value={settings.theme}
          onChange={(v) => updateSettings({ theme: v as ThemePreference })}
          options={[
            { value: 'default', label: 'Default（基准）' },
            { value: 'chatgpt', label: 'ChatGPT 桌面端（规范基准）' },
            { value: 'spec', label: 'Spec（早期色板）' },
            { value: 'light', label: '亮色' },
            { value: 'system', label: '跟随系统' },
            /* 夜航是彩蛋解锁的 —— 没解锁就不出现，免得显得像缺了一个主题 */
            ...(settings.nightUnlocked ? [{ value: 'night', label: 'Night（夜航）' }] : []),
          ]}
        />
      </Row>

      <SectionTitle hint="改字体或字号后，下面这块会立刻跟着变">字体与字号</SectionTitle>

      <Row
        label="界面字体"
        hint="中文界面选「微软雅黑」最稳；苹方、SF Pro、思源黑体、HarmonyOS Sans 要自己装，没装会自动回退"
      >
        <Select
          value={settings.fontFamily}
          onChange={(v) => updateSettings({ fontFamily: v as FontFamilyId })}
          options={FONT_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
        />
      </Row>

      {settings.fontFamily === 'custom' ? (
        <Row label="字体名" hint="填字体名本身，不要带引号。打错会回退到微软雅黑">
          <Field
            value={settings.customFontFamily}
            onChange={(v) => updateSettings({ customFontFamily: v })}
            placeholder="比如：LXGW WenKai"
            spellCheck={false}
          />
        </Row>
      ) : null}

      {/* 预览：改字体时当场看效果，不用退出去找段文字 */}
      <Row label="预览" hint="这就是当前字体与字号下的实际效果">
        <div className="w-full rounded-base border border-line-hairline bg-bg-surface px-3 py-2">
          <p className="text-dense text-fg-primary">
            让 Agent 把这段解析逻辑重构一下 —— 汉字测试 0123456789
          </p>
          <p className="mt-0.5 text-2xs text-fg-secondary">
            The quick brown fox jumps over the lazy dog
          </p>
        </div>
      </Row>

      <Row label="字号缩放" hint={`当前 ${settings.fontScale}%；整体放大界面文字，范围 80–150`}>
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

      <SectionTitle hint="也可以直接拖分栏边缘调整">布局尺寸</SectionTitle>

      <Row
        label="侧边栏宽度"
        hint={`${settings.sidebarWidth}px（${LAYOUT.sidebar.min} - ${LAYOUT.sidebar.max}，也可以直接拖）`}
      >
        <input
          type="range"
          min={LAYOUT.sidebar.min}
          max={LAYOUT.sidebar.max}
          step={4}
          value={settings.sidebarWidth}
          onChange={(e) => updateSettings({ sidebarWidth: Number(e.target.value) })}
          aria-label="侧边栏宽度"
          className="w-full accent-[var(--accent-blue)]"
        />
      </Row>

      <Row
        label="右侧面板宽度"
        hint={`${settings.rightPanelWidth}px（${LAYOUT.rightPanel.min} - ${rightMax}，随窗口自适应）`}
      >
        <input
          type="range"
          min={LAYOUT.rightPanel.min}
          max={rightMax}
          step={4}
          value={settings.rightPanelWidth}
          onChange={(e) => updateSettings({ rightPanelWidth: Number(e.target.value) })}
          aria-label="右侧面板宽度"
          className="w-full accent-[var(--accent-blue)]"
        />
      </Row>

      <SectionTitle hint="都只影响看到的效果，不改变 Agent 行为">动效与材质</SectionTitle>

      <Row
        label="玻璃拟态"
        hint="默认关闭——实测参考实现没有毛玻璃。打开后侧边栏、菜单、弹窗会一起变半透明"
      >
        <Switch
          checked={settings.glassmorphism}
          onChange={(v) => updateSettings({ glassmorphism: v })}
          label="玻璃拟态"
        />
      </Row>

      <Row label="动效" hint="关掉后所有过渡和动画都会停，系统「减少动态效果」也等效">
        <Switch
          checked={settings.animations}
          onChange={(v) => updateSettings({ animations: v })}
          label="界面动效"
        />
      </Row>

      <Row label="打字机速度" hint="回复逐字出现；0 = 一次性显示整段">
        <Select
          value={String(settings.typewriterSpeed)}
          onChange={(v) => updateSettings({ typewriterSpeed: Number(v) })}
          options={[
            { value: '0', label: '关闭（直接显示）' },
            { value: '0.5', label: '慢' },
            { value: '1', label: '正常' },
            { value: '2', label: '快' },
            { value: '4', label: '很快' },
          ]}
        />
      </Row>

      <Row
        label="启动动画"
        hint="完整的启动页（约 10 秒）。播放中点任意处可跳过；关掉后直接进主界面"
      >
        <Switch
          checked={settings.bootAnimation}
          onChange={(v) => updateSettings({ bootAnimation: v })}
          label="启动动画"
        />
      </Row>

      {/* ASCII 质量 / 减少动态是启动动画的两个细项 —— 用展开布局，避免左侧说明被压成五行 */}
      <RowStack
        label="启动页画面质量"
        hint="只影响启动页的海面动画。静态模式不在后台计算任何东西，最省电；性能弱的机器建议选「静态」"
      >
        <Select
          value={settings.asciiQuality}
          onChange={(v) =>
            updateSettings({ asciiQuality: v as 'high' | 'medium' | 'low' | 'static' })
          }
          options={[
            { value: 'high', label: '高（60 FPS）' },
            { value: 'medium', label: '中（30 FPS）' },
            { value: 'low', label: '低（15 FPS）' },
            { value: 'static', label: '静态' },
          ]}
        />
        <label className="flex items-center gap-2 text-dense text-fg-primary">
          <input
            type="checkbox"
            checked={settings.asciiReducedMotion}
            onChange={(e) => updateSettings({ asciiReducedMotion: e.target.checked })}
            aria-label="减少 ASCII 动态"
          />
          减少动态（停掉海面计算，保留静态字符画和入场扫出）
        </label>
      </RowStack>

      <Row
        label="开屏欢迎语"
        hint="启动页的一句性格文案（可随机，可关）。工作区状态、任务和按钮始终显示，不受它影响"
      >
        <Switch
          checked={settings.persona}
          onChange={(v) => updateSettings({ persona: v })}
          label="开屏欢迎语"
        />
      </Row>

      <SectionTitle hint="逐类配置只有右栏「通知」标签这一处">通知</SectionTitle>

      <Row
        label="重要通知记录"
        hint="右下角那个可展开的历史按钮——记下本次打开期间的错误、警告和带操作按钮的提示（最多 100 条，只存在内存里）。关掉后不再记录，按钮也不再出现；错误和警告本身的提示照常弹"
      >
        <Switch
          checked={settings.noticeHistory}
          onChange={(v) => updateSettings({ noticeHistory: v })}
          label="重要通知记录"
        />
      </Row>

      <Row
        label="每一类通知去哪儿"
        hint="弹卡片（右下角几秒后消失）／只进右栏「通知」标签／都不要。默认右下角只弹「出错、要你拍板、日常确认」，任务结果、下载和过程播报只进通知标签"
      >
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveRightTab('notifications')}
          className="rounded-sm border border-line-subtle bg-bg-raised px-2.5 py-1 text-2xs text-fg-primary transition-colors duration-fast hover:bg-bg-active"
        >
          去右栏逐类设置
        </button>
      </Row>
    </>
  )
}

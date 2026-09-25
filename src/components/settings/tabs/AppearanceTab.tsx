import type { FontFamilyId, ThemePreference } from '@/types'
import { FONT_OPTIONS, LAYOUT } from '@/constants'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Field, Select, Switch } from '@/components/ui/Field'
import { clamp } from '@/lib/utils'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 外观

   配色 / 材质 / 动效 / 打字机 / 布局宽度。
   拆出来是因为 SettingsModal 本体已经太长（它只管「哪个标签显示什么」）。
   ══════════════════════════════════════════════════════════════ */

export function AppearanceTab() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  return (
    <>
      <SectionTitle>字体</SectionTitle>

      <Row
        label="界面字体"
        hint="中文界面选「微软雅黑」最稳；思源黑体、HarmonyOS Sans 要自己装，没装会自动回退"
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

      {/*
        预览：改字体时当场看效果，不用退出去找段文字。
        用 Row 包起来是为了**左侧有标签列** —— 之前它俩都没有，
        这一行就孤零零地顶到最左边，和上下几行对不齐。
      */}
      <Row label="预览" hint="立刻看到当前字体的效果">
        <div className="w-full rounded-base border border-line-hairline bg-bg-surface px-3 py-2">
          <p className="text-dense text-fg-primary">
            让 Agent 把这段解析逻辑重构一下 —— 汉字测试 0123456789
          </p>
          <p className="mt-0.5 text-2xs text-fg-tertiary">
            The quick brown fox jumps over the lazy dog
          </p>
        </div>
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

      <SectionTitle>主题</SectionTitle>

      <Row label="配色" hint="default 是当前基准；chatgpt 是规范给的 ChatGPT 桌面端基准值">
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

      <SectionTitle>开屏</SectionTitle>

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

      <Row
        label="欢迎语"
        hint="开屏的一句性格文案（可随机，可关）。工作区状态、任务和按钮始终显示，不受它影响"
      >
        <Switch
          checked={settings.persona}
          onChange={(v) => updateSettings({ persona: v })}
          label="开屏欢迎语"
        />
      </Row>

      <SectionTitle>材质</SectionTitle>

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

      <Row label="ASCII 海岛质量" hint="只影响启动页海面动画；静态模式不在后台计算">
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
      </Row>

      <Row label="减少 ASCII 动态" hint="停掉海面计算；保留静态字符画和入场扫出">
        <Switch
          checked={settings.asciiReducedMotion}
          onChange={(v) => updateSettings({ asciiReducedMotion: v })}
          label="减少 ASCII 动态"
        />
      </Row>

      <Row label="打字机速度" hint="0 = 一次性显示整段回复">
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

      <SectionTitle>布局</SectionTitle>

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
        hint={`${settings.rightPanelWidth}px（${LAYOUT.rightPanel.min} - ${LAYOUT.rightPanel.max}）`}
      >
        <input
          type="range"
          min={LAYOUT.rightPanel.min}
          max={LAYOUT.rightPanel.max}
          step={4}
          value={settings.rightPanelWidth}
          onChange={(e) => updateSettings({ rightPanelWidth: Number(e.target.value) })}
          aria-label="右侧面板宽度"
          className="w-full accent-[var(--accent-blue)]"
        />
      </Row>
    </>
  )
}

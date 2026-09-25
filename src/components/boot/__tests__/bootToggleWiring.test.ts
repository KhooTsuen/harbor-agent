import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   启动动画开关的接线钉子（2026-09-26）

   · App 读 settings.bootAnimation 并交给 useBootGate 第二个参数
   · 外观页（开屏 区）有开关，写回 settings.bootAnimation
   · BootSequence 不再有「按就绪提前收尾」的调用（动画整段播完）
   行为在真机上量（tmp/measure-boot.cjs、tmp/probe-boot-toggle.cjs），这里钉接线。
   ══════════════════════════════════════════════════════════════ */

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

describe('启动动画开关 / 接线', () => {
  it('App：读 settings.bootAnimation 并传给 useBootGate', () => {
    const src = read('src/App.tsx')
    expect(src).toContain('s.settings.bootAnimation')
    expect(src).toContain('bootAnimation,')
  })

  it('外观页：开屏区有「启动动画」开关', () => {
    const src = read('src/components/settings/tabs/AppearanceTab.tsx')
    expect(src).toContain('updateSettings({ bootAnimation: v })')
    expect(src).toContain('label="启动动画"')
  })

  it('BootSequence/bootFrames：不再有「按就绪提前收尾」的调用', () => {
    expect(read('src/components/boot/BootSequence.tsx')).not.toContain('bootExitAt')
    expect(read('src/components/boot/bootFrames.ts')).not.toContain('bootExitAt')
    expect(read('src/components/boot/bootFrames.ts')).not.toContain('BOOT_EXIT')
  })

  it('设置默认值：bootAnimation 默认开（只有显式 false 才关）', () => {
    const src = read('src/stores/useSettingsStore.ts')
    expect(src).toContain('bootAnimation: true')
    expect(src).toContain('bootAnimation: s.bootAnimation !== false')
  })
})

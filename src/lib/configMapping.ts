import type { AppConfig } from '@/types/backend'
import type { Settings } from '@/types'

/* ── 配置 ↔ 界面设置的映射 ─────────────────────────────────── */

/**
 * 主进程的 general 有哪些字段，界面设置里就有哪些。
 * 侧栏宽度、右侧面板宽度这些是**纯界面状态**，主进程不管，留在 localStorage。
 */
export function configToSettings(cfg: AppConfig, current: Settings): Settings {
  return {
    ...current,
    theme: cfg.general.theme,
    glassmorphism: cfg.general.glassmorphism,
    animations: cfg.general.animations,
    fontScale: cfg.general.fontScale,
    sendOnEnter: cfg.general.sendOnEnter,
    defaultModel: cfg.assistant.model,
  }
}

/** 反向：界面改了哪些字段，需要回写主进程 */
export function settingsToConfig(patch: Partial<Settings>): Partial<AppConfig['general']> {
  const out: Partial<AppConfig['general']> = {}
  if (patch.theme !== undefined) out.theme = patch.theme
  if (patch.glassmorphism !== undefined) out.glassmorphism = patch.glassmorphism
  if (patch.animations !== undefined) out.animations = patch.animations
  if (patch.fontScale !== undefined) out.fontScale = patch.fontScale
  if (patch.sendOnEnter !== undefined) out.sendOnEnter = patch.sendOnEnter
  return out
}

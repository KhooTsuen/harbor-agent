import { Suspense } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { PermissionDialog } from '@/components/dialogs/PermissionDialog'
import { ToastViewport } from '@/components/ui/Toast'
import { useImageLightbox } from '@/stores/useImageLightbox'
import { useUIStore } from '@/stores/useUIStore'
import { PREVIEW_CONFIG } from '@/components/onboarding/previewConfig'
import { HarborEggs } from './HarborEggs'
import {
  CommandPalette,
  HarborStatsModal,
  ImageLightbox,
  Onboarding,
  SettingsModal,
} from '@/components/layout/lazyAppParts'
import type { AppConfig } from '@/types/models'

/* ══════════════════════════════════════════════════════════════
   全局层：弹窗与覆盖层

   抽出来有两个理由：

   ① **它们必须一起被 ErrorBoundary 保护**。以前这四块只包了 Suspense 没包
      ErrorBoundary —— 破坏性测试里实测过：任意一个渲染时抛错（当时是日志面板
      读到一条字段不全的审计记录），错误冒泡到 root，React 卸载**整棵树**，
      窗口直接白屏、只能重启。比「某一块坏了」严重得多。
   ② App.tsx 贴着 300 行，这里自己从 store 读状态，那边只要一行。

   `PermissionDialog` 和 `ToastViewport` 也一起包进来：它们出错时确实会变得不可用，
   但「看不到确认框」仍然好过「整个窗口白屏」。
   ══════════════════════════════════════════════════════════════ */

export interface GlobalLayersProps {
  config: AppConfig | null
  showOnboarding: boolean
}

export function GlobalLayers({ config, showOnboarding }: GlobalLayersProps) {
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen)
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const harborStatsOpen = useUIStore((s) => s.harborStatsOpen)
  const lightboxOpen = useImageLightbox((s) => s.images.length > 0)

  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        {showOnboarding ? <Onboarding config={config ?? PREVIEW_CONFIG} /> : null}
        {commandPaletteOpen ? <CommandPalette /> : null}
        {settingsOpen ? <SettingsModal /> : null}
        {harborStatsOpen ? <HarborStatsModal /> : null}
        {lightboxOpen ? <ImageLightbox /> : null}
      </Suspense>
      <PermissionDialog />
      <ToastViewport />
      {/* 状态彩蛋（「航道畅通」）—— 监听任务结束事件，只认真实退出码 */}
      <HarborEggs />
    </ErrorBoundary>
  )
}

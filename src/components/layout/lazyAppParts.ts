import { lazy } from 'react'

const loadMessageList = () => import('@/components/chat/MessageList')
const loadRightPanelHost = () => import('@/components/layout/RightPanelHost')

export const MessageList = lazy(async () => ({
  default: (await loadMessageList()).MessageList,
}))
export const RightPanelHost = lazy(async () => ({
  default: (await loadRightPanelHost()).RightPanelHost,
}))
export const BottomPanel = lazy(async () => ({
  default: (await import('@/components/layout/BottomPanel')).BottomPanel,
}))
export const CommandPalette = lazy(async () => ({
  default: (await import('@/components/layout/CommandPalette')).CommandPalette,
}))
export const SettingsModal = lazy(async () => ({
  default: (await import('@/components/settings/SettingsModal')).SettingsModal,
}))
export const Onboarding = lazy(async () => ({
  default: (await import('@/components/onboarding/Onboarding')).Onboarding,
}))
export const ImageLightbox = lazy(async () => ({
  default: (await import('@/components/chat/ImageLightbox')).ImageLightbox,
}))

/** Essential workspace chunks load under the opaque boot layer. */
export async function preloadWorkspaceUi(): Promise<void> {
  await Promise.all([loadMessageList(), loadRightPanelHost()])
}

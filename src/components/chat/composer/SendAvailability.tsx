import { useUIStore } from '@/stores/useUIStore'
import type { SendBlock } from './sendBlock'

/**
 * 输入框下方那行「暂不能发送：…」。
 *
 * 只在**真的阻塞发送**时出现，并且按 `kind` 决定要不要给「打开模型设置」——
 * 以前是靠 `reason.includes('附件')` 猜的，文案一改按钮就会串到附件那条下面（P1 #14）。
 */
export function SendAvailability({ block }: { block: SendBlock | null }) {
  const openSettings = useUIStore((s) => s.openSettings)
  if (!block || block.kind === 'empty') return null
  return (
    <p role="status" className="px-1 pb-1 text-xs text-fg-secondary">
      暂不能发送：{block.text}
      {block.kind === 'connection' ? (
        <button type="button" className="ml-1 underline" onClick={() => openSettings('models')}>
          打开模型设置
        </button>
      ) : null}
    </p>
  )
}

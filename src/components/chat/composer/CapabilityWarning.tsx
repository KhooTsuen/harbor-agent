import { AlertTriangle, Info } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { capabilityGaps, explainGaps, infoOf, needsFor } from '@/lib/modelCapabilityWarn'
import { cn } from '@/lib/utils'
import { STATUS_CLASS } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   输入框下面的「这活这个模型干不了」提示（AG 提前警告）

   为什么放在这儿：用户贴完图、开着工具按发送的**前一秒**是他唯一能改主意的时刻。
   等请求发出去再报 400，他得自己猜是模型不支持还是参数写错了。

   ⚠️ 依据是**声明**（内置预设 + 手填），不是实测 —— 所以措辞永远是「据预设」，
   并且明确告诉他去哪儿改（设置 → 供应商，手填覆盖优先于预设）。

   只报两件事，因为只有这两件会真的让请求失败：
     · 贴了图但预设说这模型不读图
     · 开着工具但预设说这模型不支持 tool_call
   ══════════════════════════════════════════════════════════════ */

export function CapabilityWarning() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const configured = useConfigStore((s) => s.config?.assistant.model)
  const matrix = useConfigStore((s) => s.config?.capabilities)
  const hasImages = useThreadStore((s) => s.inputImages.length > 0)

  const model = (thread?.model || configured || '').trim()
  if (!matrix || !model) return null

  /* 工具默认开着，只有会话里明确关掉才算关（和 ToolsMenu 一个口径） */
  const needs = needsFor({ hasImages, toolsOn: thread?.settings?.allowTools !== false })
  if (needs.length === 0) return null

  const info = infoOf(matrix, model)
  if (!info) return null

  /*
   * 「说不准」只在**图片**那一项上报：自定义模型几乎都没有预设，工具那条
   * 天天报就没人看了；而「贴了图但不知道能不能读」是当场卡住的痛点。
   */
  const gaps = capabilityGaps(info, matrix.labels, needs).filter(
    (gap) => gap.kind === 'no' || gap.dim === 'vision',
  )
  const warning = explainGaps({ model, gaps })
  if (!warning) return null

  return (
    <div
      role="status"
      aria-live="polite"
      title={matrix.note}
      className={cn(
        'mx-1 mb-1.5 flex items-start gap-1.5 rounded-base border px-2 py-1 text-2xs leading-relaxed',
        warning.level === 'warn'
          ? cn(STATUS_CLASS.warning.border, STATUS_CLASS.warning.text)
          : 'border-line-hairline text-fg-tertiary',
      )}
    >
      {warning.level === 'warn' ? (
        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
      ) : (
        <Info size={11} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0">
        {warning.text}
        <span className="text-fg-tertiary"> · 声明不是实测，依据可在「设置 → 供应商」看到</span>
      </span>
    </div>
  )
}

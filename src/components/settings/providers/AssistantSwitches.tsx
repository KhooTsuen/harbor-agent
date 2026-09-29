import type { ReactNode } from 'react'
import { useConfigStore } from '@/stores/useConfigStore'

/* ══════════════════════════════════════════════════════════════
   助手行为开关

   从 `ProviderPanel.tsx` 搬出来的 —— 那边正好卡在 300 行上限。

   这四个开关里，以前**只有 `selfReview` 有界面**，另外三个在配置里躺了很久却
   **没有任何消费方**（搜遍 electron/ 和 src/ 只有 config-defaults + config-normalize
   两处出现）—— 也就是「有配置、没界面、也没行为」。这次一并接上：

     · `planFirst`        → 内核提示词层：要不要要求模型先出 ```plan 块
                            （`prompt-stack.cjs` 的 PLAN_RULE）
     · `verifyAfterEdit`  → 内核收尾门禁：改了文件却没跑过命令就顶回去
                            （`task-steering.cjs` 的 shouldVerify）
     · `streamOutput`     → 渲染层：关掉时正文不逐字蹦，等写完再显示
                            （`MessageRounds` 的 hideStreamingContent）

   自检钉着这三条接线（`06-prompt-state` / `44-steering`），改坏了会红。
   ══════════════════════════════════════════════════════════════ */

/** 一个开关。四个长得一样，抽出来免得抄四遍 */
function Toggle({
  checked,
  onChange,
  title,
  children,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  children: ReactNode
}) {
  return (
    <label className="flex items-center gap-2 text-dense text-fg-primary" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

export function AssistantSwitches() {
  const config = useConfigStore((s) => s.config)
  const patchAssistant = useConfigStore((s) => s.patchAssistant)
  /* 浏览器预览里没有配置 —— 整块不显示，别渲染一堆假开关 */
  if (!config) return null
  const a = config.assistant

  return (
    <>
      <Toggle
        checked={a.selfReview}
        onChange={(v) => void patchAssistant({ selfReview: v })}
        title="回答写完后让它自己复核一遍（会多花一次模型调用）"
      >
        重要回答自动复核
      </Toggle>
      <Toggle
        checked={a.planFirst !== false}
        onChange={(v) => void patchAssistant({ planFirst: v })}
        title="多步任务先给出计划块（界面据此显示计划栏与进度），关掉则直接开做"
      >
        先给计划再动手
      </Toggle>
      <Toggle
        checked={a.verifyAfterEdit !== false}
        onChange={(v) => void patchAssistant({ verifyAfterEdit: v })}
        title="改完文件、却还没跑过任何命令就想收工时，顶回去让它先验证一次"
      >
        改完自动验证
      </Toggle>
      <Toggle
        checked={a.streamOutput !== false}
        onChange={(v) => void patchAssistant({ streamOutput: v })}
        title="开着是逐字显示；关掉则等这条回答写完再一次显示（思考和工具过程照旧实时）"
      >
        流式输出
      </Toggle>
    </>
  )
}

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
     · `clarifyFirst`     → 内核提示词层 + 工具：开工前要不要先问清楚
                            （AG-053；关掉 = 回到「直接开做」的老行为，也是它的回滚开关）
     · `verifyAfterEdit`  → 内核收尾门禁：改了文件却没跑过命令就顶回去
                            （`task-steering.cjs` 的 shouldVerify）
     · `streamOutput`     → 渲染层：关掉时正文不逐字蹦，等写完再显示
                            （`MessageRounds` 的 hideStreamingContent）

   自检钉着这几条接线（`06-prompt-state` / `44-steering` / `99-clarify`），改坏了会红。
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
        checked={a.clarifyFirst !== false}
        onChange={(v) => void patchAssistant({ clarifyFirst: v })}
        title="需求含糊、有多种合理解法时，先问清你要哪种再动手；关掉就直接开做（本开关也是这一条的回滚开关）"
      >
        开工前先问清楚
      </Toggle>
      {/*
       * A2：规模确认（重操作动手前先问清代价）。
       * ★ 文案里写死一句「**不动危险度**」—— 用户点这个开关前必须知道：
       *   关掉它，危险命令该拦照拦、该问照问（自检里有一条专门钉这个语义）。
       * ★ 只暴露秒数，**不暴露** scaleMaxFiles（"文件数"预检现在算不出来 ——
       *   给一个不起作用的旋钮比不给更糟；待办在 docs/improvement-checklist.md）。
       */}
      <Toggle
        checked={a.scaleFirst !== false}
        onChange={(v) => void patchAssistant({ scaleFirst: v })}
        title="扫全盘 / 批量下载 / 递归批处理这类重操作，动手前先问清范围和代价。关掉只影响「规模」这一层：危险命令该拦还拦、该问还问（不动危险度）"
      >
        重操作先问规模
      </Toggle>
      <label className="flex items-center gap-2 text-dense text-fg-primary">
        预估超过
        <input
          type="number"
          min={10}
          max={1800}
          step={10}
          value={a.scaleHardSeconds ?? 120}
          onChange={(e) => void patchAssistant({ scaleHardSeconds: Number(e.target.value) })}
          aria-label="重操作时长阈值（秒）"
          className="w-20 rounded-sm border border-line-hairline bg-bg-base/40 px-1.5 py-0.5 text-2xs"
        />
        秒算重操作（10–1800，保存时夹取）
      </label>
      {/*
        审计问题 6：`scaleMaxFiles`（文件数上限）**当前不生效** —— 预检不数文件
        （数一遍本身就是它要拦的那种操作），所以界面上不给那个旋钮；
        但得让看到 config.json 的人知道它不是「坏了」。待办见 improvement-checklist A2 第 0 条。
      */}
      <p className="px-1 text-2xs leading-relaxed text-fg-tertiary">
        另有「文件数超过 N 个就拦」那一条（设置里的 scaleMaxFiles）暂时不生效：预检不数文件。
        界面上没给旋钮，是因为一个不起作用的开关比没有更糟。
      </p>
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

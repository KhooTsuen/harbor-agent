import type { ReactNode } from 'react'
import { useConfigStore } from '@/stores/useConfigStore'

/* ══════════════════════════════════════════════════════════════
   助手行为开关

   从 `ProviderPanel.tsx` 搬出来的 —— 那边正好卡在 300 行上限。

    这四个开关在配置里躺了很久却
**没有任何消费方**（搜遍 electron/ 和 src/ 只有 config-defaults + config-normalize
两处出现）—— 也就是「有配置、没界面、也没行为」。这次一并接上：

     · `planFirst`        → 提示词层 + **写工具入口硬闸**：已经改过文件、计划却还是空的，
                           下一次改文件就拦一次（`tools/pre-write-gate.cjs` 的 B 闸）
     · `clarifyFirst`     → 提示词层 + **写工具入口硬闸**：覆盖已有文件前必须先问过一次
                           （同上，C 闸；AG-053 的回滚开关仍是它）
     · `verifyAfterEdit`  → 内核收尾门禁：改了文件却没跑过命令就顶回去
                           （`task-steering.cjs` 的 shouldVerify）
     · `streamOutput`     → 渲染层：关掉时正文不逐字蹦，等写完再显示
                           （`MessageRounds` 的 hideStreamingContent）

每个开关下面那行小字写的是**按下去到底会发生什么**（在哪一层生效、是不是真拦）——
用户分不出哪些是按下去有牙的，2026-11-01 因此误以为全都是开关。
小字**必须和判据同源**：改了某道闸的判据，这里就得跟着改（硬约束 9）。

   ══════════════════════════════════════════════════════════════ */

/** 一个开关。几个长得一样，抽出来免得抄好几遍。
 *
 *  `hint` 是**必填**的：不允许出现一个「按下去什么也不会发生、又没人说明」的开关。
 *  文案里带「真的会拦」= 内核里有判据，不照做就执行不了；带「真的生效」= 不在内核里拦，
 *  但界面层的行为确实变了。两者都比「只改提示词」硬 —— 那种开关现在一个都不剩了，
 *  真出现了也必须在这里写清（用户 2026-11-01 原话：「我以为像真正的开关一样，
 *  按一下会改变状态」—— 长得一模一样却不标出来，就只能靠猜）。 */
function Toggle({
  checked,
  onChange,
  title,
  hint,
  children,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  hint: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-0.5 text-dense text-fg-primary" title={title}>
      <span className="flex items-center gap-2">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {children}
      </span>
      <span className="pl-5 text-2xs text-fg-tertiary">{hint}</span>
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
        checked={a.planFirst !== false}
        onChange={(v) => void patchAssistant({ planFirst: v })}
        title="多步任务先给出计划块（界面据此显示计划栏与进度）。开着时，如果在没有计划的情况下继续改文件，内核会拦一次并要求先出计划"
        hint="真的会拦：已经改过文件、却还是没给计划时，下一次改文件会被顶回去"
      >
        先给计划再动手
      </Toggle>
      <Toggle
        checked={a.clarifyFirst !== false}
        onChange={(v) => void patchAssistant({ clarifyFirst: v })}
        title="覆盖一个已经存在的文件之前，先调 ask_user 问一次（会冲掉原内容那种）。问过之后本任务内不再拦"
        hint="真的会拦：要覆盖一个已有文件、而你还没被问过，就不让它写"
      >
        开工前先问清楚
      </Toggle>
      {/*
       * A2：规模确认（重操作动手前先问清代价）。
       * ★ 文案里写死一句「**不动危险度**」—— 用户点这个开关前必须知道：
       *   关掉它，危险命令该拦照拦、该问照问（自检里有一条专门钉这个语义）。
       * ★ 只暴露秒数，**不暴露** scaleMaxFiles（文件数上限）—— 它已经生效了
       *   （2026-10-06 接上廉价的下界估算，见 electron/core/scale-files.cjs），
       *   但定位是**内部门槛**：估算只会低估、拿它当旋钮会给人「很准」的错觉。
       *
       * 小字写「先问过你才动手」而不是「一定拦」：`scale-gate.cjs` 有两档，
       * 超过硬阈值是 `blocked`，只是偏大是 `note`（先提醒一句就放行）——
       * 写成「一定拦」等于把小字说成比代码更硬的东西。
       */}
      <Toggle
        checked={a.scaleFirst !== false}
        onChange={(v) => void patchAssistant({ scaleFirst: v })}
        title="扫全盘 / 批量下载 / 递归批处理这类重操作，动手前先问清范围和代价。关掉只影响「规模」这一层：危险命令该拦还拦、该问还问（不动危险度）"
        hint="真的会拦：扫全盘、批量这类重操作，先问过你范围和代价才动手（小一点的只先提醒一句）"
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
        scaleMaxFiles（文件数上限）**已经生效**（2026-10-06 接上估算），但它定位是
        内部门槛：估算只数两层、只会低估，暴露成旋钮会让人以为它很准。
        所以这里说清「有这么一条、在管着」，不给旋钮。
      */}
      <p className="px-1 text-2xs leading-relaxed text-fg-tertiary">
        另有「递归/批量操作涉及的文件数超过 N 个就拦」那一条（config.json 里的 scaleMaxFiles，默认
        2000）—— 它已经生效，但估算偏保守（只数两层），界面上不给旋钮。
      </p>
      <Toggle
        checked={a.verifyAfterEdit !== false}
        onChange={(v) => void patchAssistant({ verifyAfterEdit: v })}
        title="改完文件、却还没跑过任何命令就想收工时，顶回去让它先验证一次"
        hint="真的会拦：改了文件、一条命令都没跑就想收尾，会被顶回去先验证"
      >
        改完自动验证
      </Toggle>
      {/* CE-008：严格模式（默认关）—— 内核按 task.steps 硬拦，不是提示词软约束 */}
      <Toggle
        checked={a.strictMode === true}
        onChange={(v) => void patchAssistant({ strictMode: v })}
        title="更严的一档：每累计 3 次写操作、或勾掉计划后没跑命令，就会被顶回去先验证；收尾时有未验证的写操作不许收工（内核硬门禁，默认关）"
        hint="真的会拦：每累计 3 次写没验证、或勾了计划没验证，就不许收工"
      >
        严格模式：每步强制验证
      </Toggle>
      <Toggle
        checked={a.streamOutput !== false}
        onChange={(v) => void patchAssistant({ streamOutput: v })}
        title="开着是逐字显示；关掉则等这条回答写完再一次显示（思考和工具过程照旧实时）"
        hint="真的生效：关掉后正文不再逐字出现，等整段写完一次显示（思考和工具过程照旧实时）"
      >
        流式输出
      </Toggle>
    </>
  )
}

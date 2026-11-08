import { useConfigStore } from '@/stores/useConfigStore'
import { Field } from '@/components/ui/Field'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
    助手人设 —— 它叫什么、答得多深、怎么说话

    ── 第三阶段：从「模型与服务商」搬进「对话与任务」 ──────────────
    这三项改的都是**它怎么跟你说话**，不是「用哪个模型」。留在模型页
    会和 temperature / 输出上限混在一起（用户分不清哪个改的是模型）。

    ★ 关键：`responseDepth` 有两级覆盖，这里说清楚，否则用户会以为
      全局改了没生效 —— 会话级那一份在「上下文与项目 → 本次会话」。

    ★ 配置键没变：`config.assistant.name / responseDepth / systemPrompt`。
    ══════════════════════════════════════════════════════════════ */

const DEPTHS = [
  { value: 'concise', label: '简洁', hint: '一两句话说完' },
  { value: 'standard', label: '标准', hint: '够用就行' },
  { value: 'detailed', label: '详细', hint: '把来龙去脉讲清' },
  { value: 'deep', label: '深入', hint: '展开分析，愿意写长' },
] as const

export function AssistantPersona(): React.ReactElement | null {
  const config = useConfigStore((s) => s.config)
  const patchAssistant = useConfigStore((s) => s.patchAssistant)
  if (!config) return null
  const a = config.assistant

  return (
    <>
      <SectionTitle hint="它怎么称呼自己、跟你说话有多细">助手人设</SectionTitle>

      <Row label="助手名字" hint="留空就用内置的 Harbor。只影响显示，不改行为。">
        <Field value={a.name} onChange={(v) => void patchAssistant({ name: v })} />
      </Row>

      <Row
        label="回答深度（全局默认）"
        hint="所有对话的默认深度。某条对话想单独设，去「上下文与项目 → 本次会话」—— 那边的设置优先，不会改这里的值。"
      >
        <select
          value={a.responseDepth}
          onChange={(e) =>
            void patchAssistant({ responseDepth: e.target.value as typeof a.responseDepth })
          }
          aria-label="回答深度（全局默认）"
          className="w-full rounded-base border border-line-hairline bg-bg-surface px-2.5 py-1.5 text-dense text-fg-primary focus:border-line-focus focus:outline-none"
        >
          {DEPTHS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label} —— {d.hint}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label="自定义人设"
        hint="留空用内置的（内置版本会带上环境信息和工具清单）。填了会替换掉内置那份，慎用。"
      >
        <textarea
          value={a.systemPrompt}
          onChange={(e) => void patchAssistant({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="留空即可"
          aria-label="自定义人设"
          className="w-full resize-y rounded-base border border-line-hairline bg-bg-surface px-2.5 py-2 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
        />
      </Row>
    </>
  )
}

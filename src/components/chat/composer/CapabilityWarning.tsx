import { useEffect, useState } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useThreadStore } from '@/stores/useThreadStore'
import {
  capabilityGaps,
  explainGaps,
  infoOf,
  needsFor,
  visionPlanFor,
  type VisionPlan,
} from '@/lib/modelCapabilityWarn'
import { cn } from '@/lib/utils'
import { STATUS_CLASS } from '@/lib/statusLanguage'
import type { CodexMcpState } from '@/types/codexMcp'

/* ══════════════════════════════════════════════════════════════
   输入框下面的「这活干得成吗」提示

   为什么放在这儿：用户贴完图、开着工具按发送的**前一秒**是他唯一能改主意的时刻。
   等请求发出去再报 400，他得自己猜是模型不支持还是参数写错了。

   ⚠️ 能力结论的依据是**声明**（内置预设 + 手填），不是实测 —— 所以措辞永远是
   「据预设」，并且明确告诉他去哪儿改（设置 → 供应商）。

   ── ★ 2026-10-18 修的真不一致 ────────────────────────────────
   以前这里对「能不能读图」只认 `scenes.ocr` 这一条辅助，而后端
   `core/collab-images.cjs` 的 `prepareRoles` 在多模型时还会拿**另一个选中角色**
   做视觉辅助。于是「A 能看图、B 不能、又没配 OCR」被误报成「无法读取图片」，
   用户照着提示去配 OCR，其实根本不需要。
   现在视觉判据收到 `lib/modelCapabilityWarn.ts` 的 `visionPlanFor`（与内核同口径），
   这里只负责把它说成人话。

   ── Codex 的工具提示要反映**运行态** ──────────────────────────
   Codex 做 A（指导/验收）时用只读沙箱自己读项目，不需要 MCP 桥；
   做 B（工作模型）时必须靠 MCP 桥才能改代码 —— 所以这里问一次
   `codexMcp:status`（主进程算出的真实生效值），缺哪一项就直说哪一项。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

/** 一个角色在界面上的样子；`key` 决定 Codex 要不要 MCP 桥 */
interface RoleView {
  key: 'planner' | 'executor' | 'single'
  label: string
  kind?: string
  model?: string
  providerId?: string
}

/** 视觉那一句：三种结局分开说，不糊成一句 */
function visionText(role: RoleView, plan: VisionPlan): string {
  if (plan.mode === 'direct') return `${role.label}直接接收图片`
  if (plan.mode === 'helper') {
    return `${role.label}的图片由${
      plan.via === 'role' ? '另一个选中模型的视觉能力' : '已配置的识图模型'
    }转成文字分析后提供`
  }
  return `${role.label}无法读取图片：当前模型和另一个选中模型都没有视觉能力，也没配置可用的识图模型`
}

/** Codex 做 B（工作模型）时必须有的桥能力 —— 只认主进程算出的运行态 */
function codexWorkText(role: RoleView, mcp: CodexMcpState | null): string {
  if (!mcp) return `${role.label}通过 MCP 工具桥改代码；桥状态暂未取到`
  if (mcp.mcp?.enabled !== true) {
    return `${role.label}用 Codex CLI；MCP 工具桥未启用，当前无法改代码（设置 → 扩展）`
  }
  if (mcp.write?.enabled !== true) {
    return `${role.label}用 Codex CLI；MCP 写入未启用，当前无法改代码（设置 → 扩展）`
  }
  if (mcp.write?.rootValid === false) {
    const where = mcp.write.rootError || mcp.write.root || '（未配置）'
    return `${role.label}的 MCP 写入根未通过校验：${where}`
  }
  const restart = mcp.needsRestart ? '；MCP 总开关改过，重启应用后生效' : ''
  return `${role.label}通过 MCP 工具桥改代码${restart}`
}

export function CapabilityWarning() {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const configured = useConfigStore((s) => s.config?.assistant.model)
  const matrix = useConfigStore((s) => s.config?.capabilities)
  const config = useConfigStore((s) => s.config)
  const hasImages = useThreadStore((s) => s.inputImages.length > 0)
  const hasImageFiles = useThreadStore((s) => s.inputFiles.some((file) => file.kind === 'image'))

  const plannerKind = thread?.collab?.planner?.kind
  const executorKind = thread?.collab?.executor?.kind
  /* 哪个位置坐着 Codex —— 只有 B 位才需要 MCP 桥 */
  const codexSlot: RoleView['key'] | '' =
    plannerKind === 'codex-cli' ? 'planner' : executorKind === 'codex-cli' ? 'executor' : ''

  const [mcp, setMcp] = useState<CodexMcpState | null>(null)
  useEffect(() => {
    if (!codexSlot) {
      setMcp(null)
      return
    }
    /* 只在这一条对话真的坐着 Codex 时问一次（不是每次按键都 IPC） */
    let alive = true
    void bridge
      ?.codexMcpStatus?.()
      .then((res) => {
        if (alive) setMcp(res?.ok ? res.state : null)
      })
      .catch(() => {
        if (alive) setMcp(null)
      })
    return () => {
      alive = false
    }
  }, [codexSlot])

  const model = (thread?.model || configured || '').trim()
  if (!matrix || !model) return null

  /* 工具默认开着，只有会话里明确关掉才算关（和 ToolsMenu 一个口径） */
  const needs = needsFor({
    hasImages: hasImages || hasImageFiles,
    toolsOn: thread?.settings?.allowTools !== false,
  })
  if (needs.length === 0) return null

  const selectedProvider =
    config?.providers?.find((provider) => model === 'codex-cli' && provider.kind === 'codex-cli') ??
    config?.providers?.find((provider) => (provider.models ?? []).includes(model))

  const roles: RoleView[] = thread?.collab
    ? [
        {
          key: 'planner',
          label: 'A 指导/验收',
          kind: thread.collab.planner?.kind,
          model: thread.collab.planner?.model,
          providerId: thread.collab.planner?.providerId,
        },
        {
          key: 'executor',
          label: 'B 执行',
          kind: thread.collab.executor?.kind,
          model: thread.collab.executor?.model,
          providerId: thread.collab.executor?.providerId,
        },
      ]
    : [
        {
          key: 'single',
          label: '当前助手',
          kind: selectedProvider?.kind ?? '',
          model,
          providerId: selectedProvider?.id,
        },
      ]

  const ocr = config?.scenes?.ocr
  const lines: string[] = []
  for (const role of roles) {
    if (needs.includes('vision')) {
      const plan = visionPlanFor({
        role,
        /* 其余选中角色 —— 单模型时为空数组（内核也不会有"另一个"） */
        others: roles.filter((item) => item.key !== role.key),
        matrix,
        providers: config?.providers,
        ocr,
      })
      lines.push(visionText(role, plan))
    }

    if (needs.includes('tool_call')) {
      if (role.kind === 'codex-cli') {
        /* A 位：只读沙箱自己读项目，不经 MCP —— 别让人误以为桥没开就用不了 */
        lines.push(
          role.key === 'executor'
            ? codexWorkText(role, mcp)
            : `${role.label}用 Codex CLI 的只读沙箱读项目，不占用 Harbor 工具`,
        )
      } else {
        const info = infoOf(matrix, role.model ?? '', role.providerId)
        if (info) {
          const gaps = capabilityGaps(info, matrix.labels, ['tool_call'])
          const warning = explainGaps({ model: role.model ?? '', gaps })
          if (warning) lines.push(`${role.label}：${warning.text}`)
        }
      }
    }
  }

  const text = lines.join('；')
  if (!text) return null
  const isWarn = /无法|未启用|未通过|不支持|很可能失败/.test(text)

  return (
    <div
      role="status"
      aria-live="polite"
      title={matrix.note}
      className={cn(
        'mx-1 mb-1.5 flex items-start gap-1.5 rounded-base border px-2 py-1 text-2xs leading-relaxed',
        isWarn
          ? cn(STATUS_CLASS.warning.border, STATUS_CLASS.warning.text)
          : 'border-line-hairline text-fg-tertiary',
      )}
    >
      {isWarn ? (
        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
      ) : (
        <Info size={11} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0">
        {text}
        <span className="text-fg-tertiary"> · 声明不是实测，依据可在「设置 → 供应商」看到</span>
      </span>
    </div>
  )
}

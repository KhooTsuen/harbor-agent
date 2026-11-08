import { useConfigStore } from '@/stores/useConfigStore'
import { Row, SectionTitle } from '../parts'
import { RiskProbe } from './SecurityParts'

/* ══════════════════════════════════════════════════════════════
   高级与危险操作 —— 平时不看，出事才来

   ── 为什么把风险试算放在这里 ──────────────────────────────────
   它**不改任何配置**，只是拿内核那条真判据跑一遍，回答「这条命令会被
   判成什么」。日常不需要；但用户遇到「为什么这条命令被拦了」时，这里
   是唯一能自己查清的地方（不用去翻日志）。

   ── 审计开关 ──────────────────────────────────────────────────
   「关掉审计」属于危险项：关掉之后，事后追查就没有依据了。它有真实
   配置通道（`config.audit.enabled`），所以是真开关 —— 但放在这一组，
   不和日常策略混排。

   ★ 这一组被收在第四个标签里**不是**为了弱化安全 —— 危险操作该有确认
     就还有确认，这里只是别让它挤在第一屏。
   ══════════════════════════════════════════════════════════════ */

export function AccessAdvancedGroup(): React.ReactElement {
  const config = useConfigStore((s) => s.config)

  return (
    <>
      <SectionTitle hint="拿内核那条真判据跑一遍，不执行任何命令">风险试算</SectionTitle>
      <RiskProbe />
      <p className="px-3 pb-1 text-2xs leading-relaxed text-fg-tertiary">
        这里显示的是**会不会被拦**（等级 + 处置 + 理由）。它和上面「Shell 风险策略」
        用的是同一份判据 —— 改了那边的策略，这里的结论会跟着变。
      </p>

      <SectionTitle hint="关掉之后，事后就没法追查它做了什么">审计开关</SectionTitle>
      <Row
        label="记录工具调用"
        hint="每次工具调用落一行：谁、什么时候、什么权限、成功没有。参数里的密钥自动打码。默认开启。"
      >
        <label className="flex items-center gap-2 text-dense text-fg-primary">
          <input
            type="checkbox"
            checked={config?.audit?.enabled !== false}
            onChange={(e) =>
              void useConfigStore.getState().patchAudit({ enabled: e.target.checked })
            }
          />
          {config?.audit?.enabled !== false ? '已开启' : '已关闭'}
        </label>
      </Row>
      {config?.audit?.enabled === false ? (
        <p className="px-3 py-1 text-2xs leading-relaxed text-fg-tertiary">
          现在审计是关的 —— 「授权与审计」里看不到新记录。安全拦截本身不受影响（那是另一层）。
        </p>
      ) : null}

      <SectionTitle hint="这些不是这一页能改的">内核硬闸（只读说明）</SectionTitle>
      <p className="px-3 py-2 text-dense leading-relaxed text-fg-tertiary">
        危急命令（格式化磁盘、关杀软、抓凭据）、敏感路径读写、凭证外发、审计脱敏 ——
        这几条写死在核心里，**不受权限档和 Shell 策略影响**。列在这里是为了让你知道
        「改设置也绕不过去」，而不是让你去找开关。
      </p>
    </>
  )
}

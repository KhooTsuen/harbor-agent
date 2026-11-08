import type { UsageQueryResult } from '@/types/usage-query'
import { formatCount } from '@/lib/format'
import { SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
    「模型用量」· 统计可信度

    ── 这里**没有**一个「可信度 98 分」──────���────────────────────
    那种分数没有统计依据，纯属看着专业。这里只给**可解释的客观量**：
    覆盖率、字段完整率、未知数、异常数、历史边界。

    ── 请求记录完整率为什么标「无法验证」────────────────────────
    要算「账本记了几条 / 实际发了几条」，分母必须来自**账本之外**的证据
    （独立的请求生命周期日志）。目前没有：
      · `trace`（req_* 运行实例 id）确实存在，但它记在同一份账本里 ——
        拿它当分母就是**自己证明自己没漏**，逻辑上无效。
    所以这一项如实显示「无法验证」，而不是编一个 100%。

    ── 覆盖率 ≠ Token 准确率 ─────────────────────────────────────
    95% 的请求有 usage，不代表记到了 95% 的 token —— 缺的那 5% 可能消耗更多。
    这句话必须写在数字旁边，否则用户一定会误读。
    ══════════════════════════════════════════════════════════════ */

interface Props {
  data: UsageQueryResult
}

/** 百分比（分母 0 → null，不显示 0%） */
function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null
  return Math.round((part / whole) * 100)
}

function Row({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line-hairline py-1.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-dense text-fg-primary">{label}</span>
        <span className="shrink-0 font-mono text-dense text-fg-primary">{value}</span>
      </div>
      {hint ? <span className="text-2xs leading-relaxed text-fg-tertiary">{hint}</span> : null}
    </div>
  )
}

export function UsageTrust({ data }: Props): React.ReactElement {
  const t = data.totals
  const a = data.anomalies

  /* 核心字段完整率：输入与输出**都有**真实数的请求占多少 */
  const promptMissing = t.fieldUnavailable.prompt ?? 0
  const completionMissing = t.fieldUnavailable.completion ?? 0
  const bothPresent = t.requests - Math.max(promptMissing, completionMissing)
  const corePct = pct(bothPresent, t.requests)
  const coverPct = pct(t.known, t.requests)

  /* 历史边界：账本里最早有记录的那天 */
  const dayKeys = Object.keys(data.byDay).sort()
  const firstDay = dayKeys[0] ?? ''
  const lastDay = dayKeys[dayKeys.length - 1] ?? ''

  const anomalyTotal = a ? a.duplicates + a.badValues + a.missingOutcome + a.cacheOverflow : 0

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle hint="覆盖多少请求、哪些字段缺、有没有异常 —— 都是可核实的量，不是评分">
        统计数据可信度
      </SectionTitle>

      <div className="flex flex-col gap-2 rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2">
        <Row
          label="有效 usage 覆盖率"
          value={coverPct === null ? '无可统计请求' : `${coverPct}%（${t.known}/${t.requests}）`}
          hint={
            coverPct === null
              ? '这段时间账本里没有请求'
              : t.unknown > 0
                ? `另有 ${t.unknown} 次未上报（含失败与中止）。★ 这是请求数的比例，不是 token 总量的准确率。`
                : '每次请求都拿到了服务商上报的 usage'
          }
        />

        <Row
          label="输入+输出核心字段完整率"
          value={corePct === null ? '无可统计请求' : `${corePct}%（${bothPresent}/${t.requests}）`}
          hint={
            t.requests === 0
              ? ''
              : `缺输入字段 ${promptMissing} 次 · 缺输出字段 ${completionMissing} 次（缺失按未上报处理，不补 0）`
          }
        />

        <Row
          label="未知用量请求"
          value={`${formatCount(t.unknown)} 次`}
          hint="这些请求的消耗**未知**。它们不计入任何 token 合计，也不被当成 0。"
        />

        <Row
          label="老格式记录"
          value={`${formatCount(t.legacy)} 条`}
          hint={
            t.legacy > 0
              ? '这批记录早于「known 标记」上线，数值照算进历史，但无法确认当时是否拿到过 usage。'
              : '没有老格式记录'
          }
        />

        <Row
          label="请求记录完整率"
          value="无法验证"
          hint="要算「账本记了几条 / 实际发了几条」，分母必须来自账本之外的独立请求日志。目前没有这份证据 —— 拿账本自己当分母等于自我验证，所以这里如实说无法验证。"
        />

        <Row
          label="历史覆盖边界"
          value={firstDay ? `${firstDay} → ${lastDay || firstDay}` : '无记录'}
          hint={
            firstDay
              ? `账本从 ${firstDay} 起有记录。更早的消耗没有逐请求数据，无法纳入本统计，也不会用估算填补。`
              : '账本里还没有任何记录'
          }
        />
      </div>

      {/* 异常：按「真跑过哪几项」显示，没跑过的不许说 0 个 */}
      <div className="rounded-sm border border-line-hairline bg-bg-raised/20 px-3 py-2">
        <p className="text-dense text-fg-primary">
          账本体检：{a ? `${a.checked.length} 项已检查，发现 ${anomalyTotal} 处可疑` : '未执行'}
        </p>
        {a ? (
          <>
            <ul className="mt-1 flex flex-col gap-0.5 text-2xs leading-relaxed text-fg-tertiary">
              <li>· 重复记录（同一次尝试被写了两遍）：{a.duplicates}</li>
              <li>· 无效数值（负数 / 非数字）：{a.badValues}</li>
              <li>· 判断不出成败的行：{a.missingOutcome}</li>
              <li>· 缓存命中超过输入（口径矛盾）：{a.cacheOverflow}</li>
            </ul>
            <p className="mt-1 text-2xs text-fg-tertiary">
              参与检查 {formatCount(a.total)} 行。只报上面四类能确证的问题；
              「总数看起来不对」这类没有外部账单做基准的判断不在此列。
            </p>
            {a.samples.length > 0 ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-2xs text-fg-secondary">
                  查看样本（{a.samples.length} 条）
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 font-mono text-2xs text-fg-tertiary">
                  {a.samples.map((s, i) => (
                    <li key={i}>
                      [{s.kind}] {s.detail}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : (
          <p className="mt-1 text-2xs text-fg-tertiary">
            内核没有返回体检结果（老版本内核没有这一项）。这不代表「0 个异常」。
          </p>
        )}
      </div>
    </div>
  )
}

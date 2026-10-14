import { useState } from 'react'
import { Wallet } from 'lucide-react'
import type { BalanceResult } from '@/types/backend'
import { providerBalance } from '@/lib/providerApi'
import { Button } from '@/components/ui/Button'
import { Row } from '../parts'

/* ══════════════════════════════════════════════════════════════
   账户余额（DeepSeek 专有）

   ★ **只由用户点击触发**：这里没有 useEffect、没有定时器、没有轮询 ——
     每次「查询」按钮 = 一次真实请求。这是硬规矩（余额接口按次计费、也会限速）。

   ★ 「上次查询时间」**只存内存**：它是瞬时提示，不值得为它动数据结构。
     组件卸载就没了（设置页一关就重置）—— 这是刻意选的，不是漏了。

   ★ **不传 providerId**：省略即内核按 `activeProvider()` 取 —— 那条路
     （config.hasKey / config.providerKey）与 provider:ping 完全同一个，
     不新增凭证读取位置，界面也不必自己维护「当前供应商是谁」。

   ★ 余额是**字符串**（官方 schema 如此）。这里只做「有没有值」的判断，
     绝不 Number() —— 接口少给字段时会变成 NaN，显示「余额 NaN」比不显示更糟。

   ★ 三个失败态都要能显示，且**都不崩**：网络不通 / Key 无效 / 接口变更。
   ══════════════════════════════════════════════════════════════ */

/** ms → 「HH:MM:SS」（只用于「上次查询」那一行，它只活在这次设置页会话里） */
function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 金额原样带出来；空串 → 「—」（别显示成 0，那是两回事） */
function amountOf(value: string): string {
  return value && value.trim() ? value : '—'
}

export function BalanceCard() {
  /* 只存内存：不落盘、不进配置 —— 见文件头 */
  const [lastQueryAt, setLastQueryAt] = useState<number | null>(null)
  const [result, setResult] = useState<BalanceResult | null>(null)
  const [loading, setLoading] = useState(false)

  async function query(): Promise<void> {
    setLoading(true)
    const next = await providerBalance()
    setResult(next)
    /* 无论成败都记时刻：用户问的是「我上次点是什么时候」 */
    setLastQueryAt(Date.now())
    setLoading(false)
  }

  const info = result?.ok ? result.infos?.[0] : undefined

  return (
    <>
      <Row label="账户余额" hint="只在你点「查询」时请求一次，不自动刷新">
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="secondary"
            size="sm"
            icon={<Wallet size={13} />}
            loading={loading}
            onClick={() => void query()}
          >
            查询
          </Button>
          <span className="text-dense text-fg-tertiary">
            {lastQueryAt === null ? '从未查询' : `上次查询：${clockOf(lastQueryAt)}`}
          </span>
        </div>
      </Row>

      {/* 结果区在卡片之外单独一行 —— Row 的右侧是横向小控件位，塞不下几行数字 */}
      {result && !result.ok ? (
        <p className="px-3.5 py-2 text-dense text-error">查询失败：{result.error ?? '未知原因'}</p>
      ) : null}

      {result?.ok && !info ? (
        <p className="px-3.5 py-2 text-dense text-fg-tertiary">
          接口没有返回余额信息（可能是接口变更）
        </p>
      ) : null}

      {info ? (
        <div className="flex flex-col gap-0.5 px-3.5 py-2">
          <span className="font-mono text-lg leading-tight text-fg-primary">
            {amountOf(info.total)}
            <span className="ml-1 font-sans text-dense text-fg-tertiary">{info.currency}</span>
          </span>
          <span className="text-dense text-fg-tertiary">
            赠金 {amountOf(info.granted)} · 充值 {amountOf(info.toppedUp)}
          </span>
          {result?.available === false ? (
            <span className="text-dense text-error">账户余额不足，API 调用可能被拒</span>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

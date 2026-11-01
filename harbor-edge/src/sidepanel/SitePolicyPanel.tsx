/* 只显示并操作 Harbor 主进程的站点策略；扩展不保存第二份授权表。 */
/* global chrome */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'

interface SiteRow {
  host: string
  active: boolean
  expiresAt: number
}

export function SitePolicyPanel({ connected }: { connected: boolean }) {
  const [url, setUrl] = useState('')
  const [rows, setRows] = useState<SiteRow[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    if (!connected) return false
    try {
      const [tabs, result] = await Promise.all([
        chrome.tabs.query({ active: true, currentWindow: true }),
        chrome.runtime.sendMessage({ type: 'site-list' }),
      ])
      setUrl(String(tabs?.[0]?.url || ''))
      if (!result?.ok) throw new Error(String(result?.error || '站点列表读取失败'))
      setRows(Array.isArray(result.sites) ? result.sites : [])
      setMessage('')
      return true
    } catch (error) {
      setMessage(String((error as Error)?.message || error))
      return false
    }
  }, [connected])

  useEffect(() => { void refresh() }, [refresh])

  const change = async (type: 'site-block-temporary' | 'site-unblock', target: string) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await chrome.runtime.sendMessage({ type, url: target, minutes: 60 })
      if (!result?.ok) throw new Error(String(result?.error || '修改站点策略失败'))
      if (await refresh()) setMessage(type === 'site-unblock' ? '已撤销拒绝' : '已临时拒绝 1 小时；到期自动放行')
    } catch (error) {
      setMessage(String((error as Error)?.message || error))
    } finally {
      setBusy(false)
    }
  }

  const currentHost = (() => { try { return new URL(url).hostname } catch { return '' } })()
  return (
    <section aria-label="站点权限" className="space-y-2">
      <div className="leading-relaxed text-fg-tertiary">站点权限由 Harbor 统一管理；默认允许，可临时拒绝并随时撤销。</div>
      {/* 与网页卡同一口径（2026-10-21）：读不到就中性陈述，不叫人去点图标 —— 受保护的页面点了也读不到 */}
      <div className="break-all text-fg-secondary">
        {currentHost ? `当前站点：${currentHost}` : '当前站点：读不到地址'}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={!connected || !currentHost || busy} onClick={() => void change('site-block-temporary', url)}>临时拒绝 1 小时</Button>
        <Button size="sm" variant="ghost" disabled={!connected || busy} onClick={() => void refresh()}>刷新</Button>
      </div>
      {message ? <div className="text-danger" role="status">{message}</div> : null}
      {rows.filter((row) => row.active).length ? (
        <ul aria-label="已拒绝站点" className="space-y-1">
          {rows.filter((row) => row.active).map((row) => (
            <li key={row.host} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={row.host}>{row.host}{row.expiresAt ? ` · 至 ${new Date(row.expiresAt).toLocaleString()}` : ' · 长期'}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change('site-unblock', row.host)}>撤销</Button>
            </li>
          ))}
        </ul>
      ) : <div className="text-fg-tertiary">当前没有拒绝的站点</div>}
    </section>
  )
}

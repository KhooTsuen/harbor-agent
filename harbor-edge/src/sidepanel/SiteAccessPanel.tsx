/**
 * M07 扩展侧：**整站读取授权**（设置抽屉里那一块，2026-10-21）
 *
 * ── 它是什么 ────────────────────────────────────────────────
 * 用户主动扩大读取范围的两个入口之一（另一个在网页卡上：「记住本页」）。
 * 打开它 = 调 `chrome.permissions.request({origins:['<all_urls>']})`，
 * Edge 会弹**原生授权框**；用户点同意之后，换标签、切页面都能直接读，
 * 不用再点图标。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────
 * ① `SettingsDrawer.tsx` 已经 126 行，且它里面**不许出现 checkbox / sendMessage**
 *    （`177-m02c-settings.mjs` 第 62–63 行钉着「不做第二套、不许自己发消息」）——
 *    这块要发消息也得先经 `site-access.ts`，不在这里各写一份。
 * ② 与 `SitePolicyPanel`（黑名单）对称：那是「不许读」，这是「够得着」，
 *    两个机制正交，各自一个组件。
 *
 * ── ★ 手势要求（真机上最容易踩的一条）──────────────────────────
 * `chrome.permissions.request` 必须在**用户点击的调用栈里**被第一次 await。
 * 所以 `enable()` 第一句就是它 —— 前面不许插任何 await（丢手势会抛
 * `This function must be called during a user gesture`）。
 */

/* global chrome */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { hasAllSites, removeAllSites, requestAllSites } from './site-access'

export function SiteAccessPanel({ connected }: { connected: boolean }) {
  const [granted, setGranted] = useState(false)
  const [busy, setBusy] = useState(false)
  /* 结果要分成功 / 失败两种语气 —— 原来一律灰字，用户看不出「开成功了」还是「被拒了」 */
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  /** 读当前状态（contains 不需要手势，可以随便调） */
  const refresh = useCallback(async () => {
    setGranted(await hasAllSites())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* 用户在 Edge 原生框里改了授权（或者从 edge://extensions 里撤了），界面要跟着变 */
  useEffect(() => {
    const naive = globalThis as unknown as {
      chrome?: { permissions?: { onAdded?: { addListener(fn: () => void): void; removeListener(fn: () => void): void }; onRemoved?: { addListener(fn: () => void): void; removeListener(fn: () => void): void } } }
    }
    const onAdded = () => void refresh()
    const onRemoved = () => void refresh()
    try {
      naive.chrome?.permissions?.onAdded?.addListener(onAdded)
      naive.chrome?.permissions?.onRemoved?.addListener(onRemoved)
    } catch {
      /* 监听不上就只在挂载时读一次 */
    }
    return () => {
      try {
        naive.chrome?.permissions?.onAdded?.removeListener(onAdded)
        naive.chrome?.permissions?.onRemoved?.removeListener(onRemoved)
      } catch {
        /* 已经没了 */
      }
    }
  }, [refresh])

  /*
   * ★ 这两个函数的**第一句**就是 request / remove —— 别往里加前置 await。
   *   `enable` 走的是用户点击，丢了手势申请就会失败（失败时给人话）。
   */
  const enable = async () => {
    setBusy(true)
    setMessage(null)
    const ok = await requestAllSites()
    setBusy(false)
    await refresh()
    setMessage(
      ok
        ? { text: '已开启整站读取：换页面不用再点图标了。站点黑名单仍然生效。', ok: true }
        : { text: '没有开启（你在授权框里点了取消，或者浏览器拒绝了请求）。仍然可以每个页面点一次图标来读。', ok: false },
    )
  }

  const disable = async () => {
    setBusy(true)
    setMessage(null)
    const ok = await removeAllSites()
    setBusy(false)
    await refresh()
    setMessage(
      ok
        ? { text: '已关闭整站读取：回到「点一次图标、读一个标签」的最小权限。', ok: true }
        : { text: '撤销没有成功，权限可能仍然存在；可以到 Edge 扩展详情页里手动撤销。', ok: false },
    )
  }

  return (
    <section aria-label="整站读取" className="mb-4">
      <div className="mb-1.5 text-dense font-semibold text-fg-secondary">整站读取（可选）</div>
      <p aria-label="整站读取状态" className={granted ? 'text-success' : 'text-fg-secondary'}>
        {granted
          ? '现在可以读任意网站：换标签后不用再点图标。'
          : '现在只能在点过图标的那个标签里读。要一劳永逸，下面打开它（Edge 会弹一次授权框）。'}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          aria-label={granted ? '关闭整站读取' : '开启整站读取'}
          disabled={busy || !connected}
          onClick={() => {
            if (granted) void disable()
            else void enable()
          }}
        >
          {granted ? '关闭整站读取' : '开启整站读取'}
        </Button>
        {connected ? null : <span className="text-fg-tertiary">（先连上 Harbor）</span>}
      </div>
      {message ? (
        <p aria-label="整站读取结果" className={`mt-1.5 ${message.ok ? 'text-fg-secondary' : 'text-danger'}`}>
          {message.text}
        </p>
      ) : null}
      <p className="mt-1.5 leading-relaxed text-fg-tertiary">
        这是浏览器层面的「够不够得着」；「这个站点许不许读」仍然由 Harbor 主应用的站点黑名单判定，两边互不替代。
      </p>
    </section>
  )
}

import { useEffect, useRef } from 'react'
import { useBrowserStore } from '@/stores/useBrowserStore'
import { sameUrl } from '@/lib/url'
import { READ_SCRIPT, SNAPSHOT_SCRIPT, clickScript, typeScript, toIndex } from './scripts'
import {
  BROWSE_BUDGET_MS,
  Budget,
  readPage,
  runScript,
  waitForDomReady,
  waitForElement,
  waitForLoad,
  type WebviewElement,
} from './browseWait'

/* ══════════════════════════════════════════════════════════════
   执行 Agent 的浏览请求（真正操作 webview 的那一半）

   `useBrowseBridge`（挂在 RightPanel）负责接请求、开标签，
   这里负责等 webview 挂上 → 导航 → 读正文 → 回话。

   分两半是因为：接请求的地方必须**一直挂着**（不然没人接），
   而操作 webview 必须等 BrowserTab 挂载（切过去才有元素）。

   ★ 全部等待共享一条总预算（见 `browseWait.ts`）：主进程等 45 秒，
     这条预算是 30 秒 —— 渲染层**必须**先回话。真机踩过：三段等待各管各的，
     相加 48 秒 > 45 秒，于是慢页面一律被判成「界面没有在 45 秒内回应」，
     而那句话是错的（界面在干活，只是还没读完）。
   ══════════════════════════════════════════════════════════════ */

/**
 * 消费 store 里的 pending 请求。
 *
 * @param webviewRef 指向 BrowserTab 里那个 webview 元素
 */
export function useBrowseDriver(webviewRef: React.RefObject<WebviewElement | null>): void {
  const pending = useBrowserStore((s) => s.pending)
  const clearPending = useBrowserStore((s) => s.clearPending)
  /* 正在处理的那一个，避免重复执行 */
  const busyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pending) return
    if (busyRef.current === pending.id) return
    busyRef.current = pending.id

    let alive = true

    async function run(): Promise<void> {
      const reply = (result: {
        ok: boolean
        text?: string
        html?: string
        title?: string
        url?: string
        snapshot?: unknown
        click?: string
        type?: string
        into?: string
        password?: boolean
        needsConfirm?: boolean
        error?: string
      }): void => {
        void window.workbench?.browserResult?.(pending!.id, result)
      }

      /* 等 webview 挂上（切到浏览器标签后才会有）—— 跟后面几步共用同一条预算 */
      const budget = new Budget()
      const view = await waitForElement(() => webviewRef.current, budget)
      if (!alive) return
      if (!view) {
        reply({
          ok: false,
          error: `等浏览器标签出来超时（已等 ${Math.round(BROWSE_BUDGET_MS / 1000)} 秒）。右侧那个「浏览器」标签手动点开一下，再让我读。`,
        })
        clearPending()
        return
      }

      try {
        /* ① 先等它可用 —— 不等的话调任何方法都会报「must be attached to the DOM」 */
        await waitForDomReady(view, budget)
        if (!alive) return

        /* snapshot：读当前页面的可交互元素，不导航 */
        if (pending!.action === 'snapshot') {
          const out = await runScript<Record<string, unknown>>(view, SNAPSHOT_SCRIPT, budget)
          if (!alive) return
          if (!out.ok) reply({ ok: false, error: out.error })
          else reply({ ok: true, snapshot: out.value })
          return
        }

        /* click：按索引点击当前页面的元素（不导航） */
        if (pending!.action === 'click') {
          const out = await runScript<{ ok?: boolean; error?: string; clicked?: string }>(
            view,
            clickScript(toIndex(pending!.index)),
            budget,
          )
          if (!alive) return
          if (!out.ok) reply({ ok: false, error: out.error })
          else if (out.value?.ok) reply({ ok: true, click: out.value.clicked ?? '' })
          else reply({ ok: false, error: String(out.value?.error ?? '点击失败') })
          return
        }

        /* type：按索引往输入框打字（不导航） */
        if (pending!.action === 'type') {
          const out = await runScript<{
            ok?: boolean
            error?: string
            typed?: string
            into?: string
            password?: boolean
            needsConfirm?: boolean
          }>(
            view,
            typeScript(
              toIndex(pending!.index),
              String(pending!.text ?? ''),
              Boolean(pending!.pressEnter),
              pending!.authorized === true,
            ),
            budget,
          )
          if (!alive) return
          const raw = out.ok ? out.value : undefined
          if (!out.ok) {
            reply({ ok: false, error: out.error })
          } else if (raw?.ok) {
            reply({
              ok: true,
              type: raw.typed ?? '',
              into: raw.into ?? '',
              password: raw.password === true,
            })
          } else if (raw?.needsConfirm) {
            /* 密码框：先不填，回去让宿主问用户 */
            reply({ ok: false, needsConfirm: true, error: '需要用户确认' })
          } else {
            reply({ ok: false, error: String(raw?.error ?? '输入失败') })
          }
          return
        }

        /*
         * ② 导航。
         * 新标签的 `src` 已经是目标地址了，webview 自己会去 —— 这种情况不用再 loadURL
         * （多调一次会白闪一下）。只有复用旧标签、地址不一致时才手动导。
         *
         * 比地址用 sameUrl：`example.com` 和 `example.com/` 是同一个页面，
         * 严格比较会判定成不一致 → 白 loadURL 一次 → 页面重新加载（表单就没了）。
         */
        const current = view.getURL?.() ?? ''
        if (current && !sameUrl(current, pending!.url)) {
          const loading = view.loadURL?.(pending!.url)
          if (loading && typeof loading.then === 'function') await loading.catch(() => undefined)
          await waitForLoad(view, budget)
        }

        /* 读正文：空会重试几次（SPA 加载完才开始填内容），失败也会重试（guest 没就绪） */
        const out = await readPage(view, READ_SCRIPT, budget)
        if (!alive) return

        if (!out.ok) {
          /*
           * ★ 一定把原因说清楚，而且**是渲染层自己说** ——
           *   不能让主进程用「界面没有在 45 秒内回应」这种猜出来的原因替它发言
           *   （真机上就是这么误导的：界面其实在干活，只是还没读完）。
           */
          reply({
            ok: false,
            error: budget.expired
              ? `等页面就绪超时（已等 ${Math.round(BROWSE_BUDGET_MS / 1000)} 秒，这个站点可能太慢或一直加载中）：${out.error}`
              : `读网页失败：${out.error}`,
          })
          return
        }

        const raw = out.value as
          { text?: string; html?: string; title?: string; url?: string } | undefined
        reply({
          ok: true,
          text: String(raw?.text ?? ''),
          /* 有 text 就不用发 html —— innerText 已经是干净的可见文本了 */
          html: raw?.text ? '' : String(raw?.html ?? ''),
          title: String(raw?.title ?? ''),
          url: String(raw?.url ?? pending!.url),
        })
      } catch (error) {
        if (!alive) return
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        clearPending()
      }
    }

    void run()

    return () => {
      alive = false
    }
  }, [pending, webviewRef, clearPending])
}

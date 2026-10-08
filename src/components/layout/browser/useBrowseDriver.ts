import { useEffect, useRef } from 'react'
import { useBrowserStore } from '@/stores/useBrowserStore'
import { sameUrl } from '@/lib/url'
import {
  BROWSE_BUDGET_MS,
  Budget,
  waitForDomReady,
  waitForElement,
  waitForLoad,
  type WebviewElement,
} from './browseWait'

/* ══════════════════════════════════════════════════════════════
   执行 Agent 的浏览请求（真正操作 webview 的那一半）

   `useBrowseBridge`（挂在 RightPanel）负责接请求、开标签，
   这里负责等 webview 挂上 → 导航 → 报就绪（读正文 / 读元素 / 点 / 打字 / 换历史
   全交**主进程**经 CDP 做，见 `electron/core/browse-*.cjs`）。

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
  /* 上一次 effect 还活着吗 —— 见下面那道闸的注释 */
  const liveRef = useRef(false)

  useEffect(() => {
    if (!pending) return
    /*
     * 同一条请求已在处理 → 不重复执行。
     * 但**只挡还活着的那一次**：React 18 StrictMode 会「挂载→立刻卸载→再挂载」，
     * 死掉的那次会一直占着 busyRef，于是唯一活着的那次被挡掉 —— 开发模式下
     * 每次浏览都静默失败（主进程一直等到 45 秒超时）。真机复现过。
     */
    if (busyRef.current === pending.id && liveRef.current) return
    busyRef.current = pending.id
    liveRef.current = true

    let alive = true
    /*
     * 这一条请求回过话没有。
     * 卸载/换请求时要靠它判断「该不该补一条失败回话」—— 见下面 cleanup 里的注释。
     */
    let replied = false

    const reply = (result: {
      ok: boolean
      /** wcid：当前 webview 的 webContents id */
      webContentsId?: number
      /** ★ 页面已就绪 —— 正文/元素/落点/历史全由主进程经 CDP 做（B2/B3/B4） */
      ready?: boolean
      error?: string
    }): void => {
      replied = true
      /* 拿 id 的这一刻就记牢：cleanup 里再读 pending 可能已经是下一条了 */
      void window.workbench?.browserResult?.(pending!.id, result)
    }

    async function run(): Promise<void> {
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

        /* wcid：单问当前 webview 的 webContents id（browse_ax 读无障碍树要用） */
        if (pending!.action === 'wcid') {
          const wcId = view.getWebContentsId?.()
          reply({ ok: true, webContentsId: typeof wcId === 'number' ? wcId : 0 })
          return
        }

        /*
         * nav（后退 / 前进）在 B4（2026-10-09）后不再由渲染层做 —— 渲染层只等
         * 「webview 就绪」并回报 wcid，历史移动由**主进程**经 CDP 完成
         * （`core/browse-history.cjs`）。所以 nav 与 snapshot/click/type/navigate
         * 一样，走到下面的通用「报 ready」即可。
         */

        if (pending!.action === 'navigate') {
          /*
           * 导航：新标签的 `src` 已经是目标地址了，webview 自己会去 —— 这种情况不用再
           * loadURL（多调一次会白闪一下）。只有复用旧标签、地址不一致时才手动导。
           * 比地址用 sameUrl：`example.com` 和 `example.com/` 是同一个页面，严格比较
           * 会判定成不一致 → 白 loadURL 一次 → 页面重新加载（表单就没了）。
           */
          const current = view.getURL?.() ?? ''
          if (current && !sameUrl(current, pending!.url)) {
            const loading = view.loadURL?.(pending!.url)
            if (loading && typeof loading.then === 'function') await loading.catch(() => undefined)
            await waitForLoad(view, budget)
          }
        }

        /*
         * snapshot / click / type / navigate / nav 走到这儿 = **页面就绪**。
         * 动作全交**主进程**经 CDP 做（B2 读正文、B3 读元素/算落点/聚焦）——
         * 渲染层只负责「开标签 + 导航 + 等就绪 + 报 webContentsId」。
         *
         * 但超时仍要**渲染层自己说**：不让主进程用「界面没有在 45 秒内回应」这种
         * 猜出来的原因替它发言（真机上就是这么误导的：界面其实在干活）。
         */
        if (budget.expired) {
          reply({
            ok: false,
            error: `等页面就绪超时（已等 ${Math.round(BROWSE_BUDGET_MS / 1000)} 秒，这个站点可能太慢或一直加载中）`,
          })
          return
        }
        reply({ ok: true, ready: true, webContentsId: view.getWebContentsId?.() ?? 0 })
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
      liveRef.current = false
      /*
       * ★ 没回过话就当场回一条（2026-10-05 真机反馈 1c）。
       *
       * 以前这里只是 `alive = false` —— 请求就这么**被丢掉**了：主进程那头
       * 一直等到 45 秒超时才回话，用户看到的是「界面没有在 45 秒内回应」，
       * 而界面早就知道这条请求做不完了。凡是界面已经知道结果的情况，
       * 就该马上说清楚，别让主进程去猜。
       *
       * 判断「是不是真被丢掉了」看 store 里当前那条请求：
       *   · cleanup 先于新 effect 跑 —— 「被新请求顶掉」时 store 里已经是新的 id → 回话 ✓
       *   · 被 closeAll 清掉 / 换成 null → 也回话 ✓
       *   · StrictMode 复挂、或单纯重渲染（还是同一条）→ **不回话**，
       *     因为马上就会有另一次执行接着把它做完
       */
      const current = useBrowserStore.getState().pending
      if (!replied && current?.id !== pending!.id) {
        reply({
          ok: false,
          error:
            '页面已切换：这条浏览请求在执行途中被打断了（浏览器标签换了、被关了，或者面板被切走）。重新发起一次，或先手动点开右侧「浏览器」再试。',
        })
      }
    }
  }, [pending, webviewRef, clearPending])
}

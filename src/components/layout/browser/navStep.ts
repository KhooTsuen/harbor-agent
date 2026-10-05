import { goInView, navStateOf } from './webviewNav'
import { runScript, waitForNavMove, type Budget, type WebviewElement } from './browseWait'

/* ══════════════════════════════════════════════════════════════
   在**同一个标签**里后退 / 前进一格

   ★ 从 `useBrowseDriver` 拆出来的（那边过 300 行了，硬约束 #2）——
     拆的时候正好把 2026-10-06 那个真机 bug 的教训留在这一段里：

     **不许拿 `canGoBack()` 当结论。**
     真机上页面自报 `hl=2`（确实有上一页，页面里 `history.back()` 一次就退回
     列表、连筛选词都恢复了），而 webview 的 `canGoBack()` 回 **false** ——
     于是我们对一条本来能成的路说了「到头了」。错报的方向最难收拾：
     它看起来像个提示，实际上把路堵死了（用户以为这功能就是残的）。

     现在按「动手 + 核实」来：
       ① 先调浏览器自己的 `goBack` / `goForward`（正路）
       ② **等一次导航事件或地址变化**；没动静再用**页面自己的** history 兜一次
          （真机证明那条路是通的 —— 它和浏览器 API 在这件事上各说各话）
       ③ 两次都没动才判「换不了页」，并且把诊断值一起带回去
   ══════════════════════════════════════════════════════════════ */

export interface NavStepOutcome {
  /** 页面真的换了没有 */
  moved: boolean
  /** 动手之前的地址 */
  before: string
  /** 诊断用：webview 自报的能不能退 / 能不能进（它可能撒谎，只用来说明现场） */
  back: boolean
  forward: boolean
}

/**
 * 依次试两步（浏览器 API → 页面自己的 history），哪一步动了就停。
 *
 * @param step   'back' | 'forward'
 * @param budget 这次浏览请求的总预算（等待共享它，别各等各的）
 */
export async function stepHistory(
  view: WebviewElement,
  step: 'back' | 'forward',
  budget: Budget,
): Promise<NavStepOutcome> {
  const before = String(view.getURL?.() ?? '')
  const state = navStateOf(view)
  const attempts: Array<() => void | Promise<void>> = [
    () => goInView(view, step),
    () => runScript(view, `history.${step}()`, budget, 1),
  ]

  let moved = false
  for (const attempt of attempts) {
    await attempt()
    moved = await waitForNavMove(view, before, budget)
    if (moved) break
  }

  return { moved, before, back: state.back, forward: state.forward }
}

/**
 * 「换不了页」时回给模型的话。
 *
 * 带诊断值是刻意的：模型把这句原样贴出来，就能定性到底是「真的到头」还是
 * 「canGoBack 又撒谎了」—— 不用再靠猜。
 */
export function navBlockedText(
  step: 'back' | 'forward',
  outcome: NavStepOutcome,
  active: string,
): string {
  const target = step === 'back' ? '上一页' : '下一页'
  return (
    `这个标签换不了页：浏览器的历史、页面里的 history.${step}() 都没能把它挪动一格。` +
    `诊断：webview 报 canGoBack=${outcome.back} / canGoForward=${outcome.forward}，` +
    `当前地址 ${outcome.before || '未知'}，标签地址 ${active || '未知'}。` +
    `如果确实有${target}，请把这句原样告诉用户。`
  )
}

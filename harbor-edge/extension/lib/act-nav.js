/**
 * M04 剩余：**滚动**的注入函数（只有这一个 —— 另两件不需要注入，见下）
 *
 * ── ★ 为什么只有 scroll 在这里 ────────────────────────────────
 *
 *   · `wait`     —— 条件检查的**唯一实现**是 `act.js` 的 `verifyPage`。若为此再写一份
 *                   条件检查，就违反硬约束 #9（同一件事两处实现，必然漂）。所以
 *                   `wait` 在**扩展侧的 `command-run.js` 里轮询**：每 300ms 注入一次
 *                   `verifyPage`，满足即停。代价是每跳一次 IPC —— 换来「条件语义只有一处」。
 *   · `navigate` —— `chrome.tabs.update(tabId, { url })` 本来就是**扩展 API**，不必注入。
 *                   注入到页面里反而绕远（而且导航会把注入的代码销毁）。
 *
 * ── ★★ 自包含铁律（M03 §8.1）──────────────────────────────────
 *
 * `executeScript({ func })` 会 `toString()` 序列化后注入 —— 函数体只能用**自己的**
 * 参数 / 局部变量 / 嵌套函数。所以这里不 import 任何东西（连 `act.js` 的辅助也不）。
 */

/* global window, document */

/**
 * 滚动页面。
 *
 * 三种用法（按优先级）：给 `ref` 就滚到那个元素；给 `to:'bottom'|'top'` 就滚到文档两端；
 * 否则按 `dy`（正数向下）滚。默认 `dy = 一屏`。
 *
 * @param {{ ref?: string, to?: string, dy?: number }} [opts]
 */
export function scrollPage(opts) {
  return (async () => {
    const o = opts && typeof opts === 'object' ? opts : {}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const pos = () => {
      try {
        return Math.round(window.scrollY || document.documentElement.scrollTop || 0)
      } catch {
        return -1
      }
    }
    const height = () => {
      try {
        return Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0,
        )
      } catch {
        return 0
      }
    }
    const viewport = () => {
      try {
        return window.innerHeight || 0
      } catch {
        return 0
      }
    }

    const before = pos()
    const total = height()
    let how = ''
    let refUsed = ''

    const target = String(o.ref || '')
    if (target) {
      /* 按引用滚到元素 —— 与 act.js 同一套版本校验（自包含，所以这里必须重写） */
      const store = window.__harborObs
      if (!store || !store.refs) {
        return { ok: false, reason: 'no-observation', message: '还没观察过这个页面 —— 先观察一次，再按引用操作' }
      }
      const version = String(store.version || '')
      const dot = target.lastIndexOf('.')
      const refVersion = dot > 0 ? target.slice(0, dot) : ''
      if (refVersion !== version) {
        return { ok: false, reason: 'page-changed', message: '页面已经变了（这个引用属于旧版本）—— 请重新观察再操作', refVersion, version }
      }
      const holder = store.refs.get(target)
      let el = null
      try {
        el = holder && typeof holder.deref === 'function' ? holder.deref() : null
      } catch {
        el = null
      }
      if (!el || el.isConnected !== true) {
        return { ok: false, reason: 'not-found', message: '这个元素已经不在页面上了 —— 请重新观察再操作', refVersion, version }
      }
      let threw = ''
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
      } catch (error) {
        threw = String((error && error.message) || error)
      }
      how = 'element'
      refUsed = target
      if (threw) return { ok: false, reason: 'scroll-failed', message: `滚到那个元素时出错：${threw}`, ref: target }
    } else if (o.to === 'bottom' || o.to === 'top') {
      let threw = ''
      try {
        window.scrollTo({ top: o.to === 'bottom' ? total : 0, behavior: 'auto' })
      } catch (error) {
        threw = String((error && error.message) || error)
      }
      how = o.to
      if (threw) return { ok: false, reason: 'scroll-failed', message: `滚动时出错：${threw}` }
    } else {
      const dy = Number.isFinite(Number(o.dy)) ? Number(o.dy) : viewport()
      let threw = ''
      try {
        window.scrollBy({ top: dy, behavior: 'auto' })
      } catch (error) {
        threw = String((error && error.message) || error)
      }
      how = 'by'
      if (threw) return { ok: false, reason: 'scroll-failed', message: `滚动时出错：${threw}` }
    }

    /* 给平滑滚动 / 懒加载一点时间（不给也行，但证据会不准） */
    await sleep(120)
    const after = pos()
    const atBottom = total > 0 && after + viewport() >= total - 4

    return {
      ok: true,
      how,
      ref: refUsed,
      evidence: {
        scrollBefore: before,
        scrollAfter: after,
        moved: before !== after,
        pageHeight: total,
        viewport,
        atBottom,
      },
      checks: [
        { name: 'moved', pass: before !== after, before: String(before), after: String(after) },
        { name: 'at-bottom', pass: atBottom, before: '', after: String(atBottom) },
      ],
    }
  })()
}

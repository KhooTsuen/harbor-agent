/* ══════════════════════════════════════════════════════════════
   动作日志（渲染层这一侧）

   用户的要求：「日志再详细点，最好把**我们没预料到的事件**也包含进去，
   比如用户点击了什么功能」。

   ★ 手工埋点做不到「没预料到」—— 只能覆盖我写代码时想到的那几个。
     所以这里走**兜底**：
       ① 捕获阶段监听一次点击，把「点到的是什么功能」按元素标签报上去
          （按钮文字 / aria-label / title，往上找 6 层）
       ② window 级 error / unhandledrejection 全部上报
       ③ 功能调用走 preload 的唯一 `call()`（那边已经在报了）

   三条纪律：
   · **不报内容**：只报元素标签（「编辑」「发送」这种），不报消息正文、
     不报输入框里的字 —— 那些是用户数据，不该进日志。
   · 找不到标签的点击干脆不报（不然满屏都是「点了 div」）。
   · 上报是 send、不等回执：记日志绝不能给界面添延迟，更不能把功能弄挂。
   ══════════════════════════════════════════════════════════════ */

type Entry = { kind: string; name: string; ok?: boolean; ms?: number; detail?: string }

interface Bridge {
  logAction?: (entry: Entry) => void
  logError?: (entry: { where?: string; message?: string }) => void
}

function bridge(): Bridge {
  return (globalThis as unknown as { workbench?: Bridge }).workbench ?? {}
}

/** 同一个标签在这个窗口内重复点 → 只报一次（连点、双击不算两件事） */
const REPEAT_MS = 300
let lastLabel = ''
let lastAt = 0

/**
 * 点到的是什么功能。纯函数，便于断言。
 *
 * 从点到的元素往上找最多 6 层：优先 `aria-label` / `title`，其次按钮文字。
 * 找不到就返回空串 —— 调用方据此不报（避免一堆「点了 div」的噪音）。
 */
export function clickLabelOf(node: Element | null): string {
  let el: Element | null = node
  for (let depth = 0; el && depth < 6; depth += 1, el = el.parentElement) {
    const named = el.getAttribute('aria-label') || el.getAttribute('title')
    if (named?.trim()) return named.trim().slice(0, 40)
    const clickable = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
    if (clickable) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) return text.slice(0, 40)
    }
  }
  return ''
}

/** 报一条动作（界面主动埋点时用；全量点击走下面的监听，不用调这个） */
export function logAction(name: string, detail?: string): void {
  if (!name) return
  bridge().logAction?.({ kind: 'action', name, ...(detail ? { detail } : {}) })
}

/** 报一个异常（ErrorBoundary / 自己 catch 到不该发生的事时用） */
export function logError(where: string, error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  bridge().logError?.({ where, message: message.slice(0, 500) })
}

/** 报一条失败的 Promise 拒绝（给 window 监听用，导出来便于测） */
export function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.message}\n${reason.stack ?? ''}`.slice(0, 500)
  if (typeof reason === 'string') return reason.slice(0, 500)
  try {
    return JSON.stringify(reason).slice(0, 500)
  } catch {
    return String(reason).slice(0, 500)
  }
}

/**
 * 装上监听。在 React 挂载**之前**调（main.tsx）—— 装晚了会漏掉启动阶段的错。
 * @returns 卸载函数（测试用；应用里不卸）
 */
export function installActionLog(doc: Document = document, win: Window = window): () => void {
  const onClick = (event: MouseEvent) => {
    const label = clickLabelOf(event.target as Element | null)
    if (!label) return
    const at = Date.now()
    if (label === lastLabel && at - lastAt < REPEAT_MS) return
    lastLabel = label
    lastAt = at
    bridge().logAction?.({ kind: 'click', name: label })
  }

  const onError = (event: ErrorEvent) => {
    bridge().logError?.({
      where: event.filename
        ? `window.onerror@${String(event.filename).slice(-40)}`
        : 'window.onerror',
      message: describeReason(event.error ?? event.message),
    })
  }

  const onRejection = (event: PromiseRejectionEvent) => {
    bridge().logError?.({ where: 'unhandledrejection', message: describeReason(event.reason) })
  }

  doc.addEventListener('click', onClick, true)
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)

  return () => {
    doc.removeEventListener('click', onClick, true)
    win.removeEventListener('error', onError)
    win.removeEventListener('unhandledrejection', onRejection)
  }
}

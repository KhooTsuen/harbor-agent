/* ══════════════════════════════════════════════════════════════
   提示类事件：不改消息，只用一条 toast 让用户看见

   从 `streamEvents.ts` 拆出来的（那边 306 行贴了上限）。挑这一块搬是因为它有个
   **清楚的边界**：下面这六个事件**都不落到消息上** —— 不追加内容、不改状态，
   只是「这件事你得知道」。剩下的那些（content / tool / confirm / done…）全都会
   真的改动消息，留在原处。

   `streamEvents.ts` 里留了一个 fallthrough 的 case 组转发过来，两边只有一处判断
   （`event.type`），加新的事件类型时改这里。
   ══════════════════════════════════════════════════════════════ */

import { useUIStore } from '@/stores/useUIStore'

/*
 * ⚠️ 这里**故意不用 `ChatEvent`** 收窄：`retry` / `fallback` / `context_overflow`
 * 这三个内核真的会发（`loop-model.cjs` 的 emit），但 `ChatEvent` 那个 union 里
 * **没有它们** —— 拿 ChatEvent 来 Extract，这三个 case 会被收成 `never`，tsc 直接红。
 * 类型补全另开一笔账（别在这儿顺手改，会牵动整个事件链）。
 * 用宽松类型的代价是丢一点类型安全，换来的是「和内核实际发的东西对得上」。
 */
type NoticeEvent = Record<string, unknown>

export function handleNoticeEvent(event: NoticeEvent): void {
  const toast = useUIStore.getState().showToast
  switch (event.type) {
    case 'boundary': {
      /*
       * ②-5：碰到了能力边界。**不拦**，只是先说一声 ——
       * 标题带上「我是从哪句看出来的」（matched），万一误报用户一眼能判断。
       * 「不做」用 warning（此路不通），「实验性」用 info（能做但别指望）。
       */
      toast(
        event.level === 'never' ? 'warning' : 'info',
        event.level === 'never' ? `这件事不做：${event.label}` : `这件事是实验性的：${event.label}`,
        `${String(event.note ?? '')}（从「${String(event.matched ?? '')}」看出来的）`,
      )
      return
    }
    case 'budget': {
      /* 拦住的情况不在这里提示 —— 那种会直接抛错，错误气泡里已经有原因了 */
      if (event.blocked !== true && event.exceeded === true) {
        toast('warning', '用量已到上限', String(event.message ?? ''))
      }
      return
    }
    case 'retry': {
      toast('warning', '正在重试', String(event.hint ?? '请求失败，稍后自动重试'))
      return
    }
    case 'fallback': {
      toast('warning', '已换用一个供应商', `原因：${String(event.reason ?? '上一个不可用')}`)
      return
    }
    case 'context_overflow': {
      toast('info', '上下文太长', '用 /compact 压一下再继续，会比现在稳')
      return
    }
    case 'review': {
      if (event.status === 'started') toast('info', '正在复核这次回答', '复核完会给出结论')
      return
    }
  }
}

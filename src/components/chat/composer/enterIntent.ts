/* ══════════════════════════════════════════════════════════════
   Enter 键该干什么（P2 #13 中文输入保护）

   为什么单独抽出来：这段判据以前埋在 `Composer.tsx` 的 `onKeyDown` 里，
   **没有任何测试**。而它一旦写错，症状是「中文还没选完字，消息就发出去了」——
   用户第一反应是「软件乱发」，不会想到是输入法。这类判据必须能单独跑。

   ── 三件事必须同时成立才算「用户想发送」────────────────────────
     ① 不在组词中（`isComposing`）
     ② 不是输入法的「组词中回车」（`keyCode === 229`，Chrome / 部分 IME 用这个）
     ③ 没按修饰键（Shift+Enter 换行是所有人的肌肉记忆，不能被当成发送）

   ① 和 ② 要**都判**：某些输入法在 `compositionend` 之后立刻补一个
   `keydown`，那时 `isComposing` 已经是 false，只剩 `keyCode === 229` 能认出它
   （这是浏览器事件顺序的老坑，两条一起判才稳）。

   ── 和「排队 / 立即发送」的关系 ────────────────────────────────
   那两个是**按钮**触发的，根本不经过键盘 —— 所以它们天然没有输入法误发问题。
   共用的是「有没有内容」这一层判据（`prepareOutgoing`），不是键盘判据。
   ══════════════════════════════════════════════════════════════ */

/** 只取判断需要的那几个字段 —— 不依赖真实的 React 事件，测试直接给对象 */
export interface EnterKeyInfo {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  /** 输入法正在组词（`nativeEvent.isComposing`） */
  isComposing: boolean
  /** 输入法的 229（组词中回车） */
  keyCode: number
}

export type EnterIntent =
  /** 发送 */
  | 'send'
  /** 让浏览器照常处理（换行 / 光标移动 / 输入法自己吃掉） */
  | 'pass'
  /** 明确什么都不做（已经被输入法消费掉的那一下） */
  | 'ignore'

/**
 * @param info 按键信息
 * @param sendOnEnter 用户的发送习惯：true = Enter 发送 / Shift+Enter 换行；
 *                    false = Ctrl(⌘)+Enter 发送 / Enter 换行
 */
export function enterIntent(info: EnterKeyInfo, sendOnEnter: boolean): EnterIntent {
  if (info.key !== 'Enter') return 'pass'

  /* 输入法还在组词：这一下属于输入法，绝不能发送，也不该被当成「用户按了回车」 */
  if (info.isComposing || info.keyCode === 229) return 'ignore'

  /* Shift+Enter 永远是换行（两种发送习惯下都一样） */
  if (info.shiftKey) return 'pass'
  if (info.altKey) return 'pass'

  const withModifier = info.ctrlKey || info.metaKey
  /* 习惯是 Enter 发送 → 直接发；习惯是 Ctrl+Enter 发送 → 光按 Enter 必须换行 */
  if (sendOnEnter) return 'send'
  return withModifier ? 'send' : 'pass'
}

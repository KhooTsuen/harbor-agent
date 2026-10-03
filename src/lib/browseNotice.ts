/* ══════════════════════════════════════════════════════════════
   「Agent 在动网页」时给用户的那句提示（收尾第一步 / 小尾巴 #8）

   两个界面上的落点，共用这一个判断：

   1. **toast** —— 窗口在前台时，右栏切到「浏览器」标签这一步用户可能没看见
      （他正在看对话、右栏可能还是收起的），所以补一句。
   2. **标签角标** —— 右栏的「浏览器」标签上点一下就行，不必再切面板。

   为什么要有「去重」这一层：一个任务里 Agent 常常连着 snapshot → click →
   type → snapshot… 每步弹一条 toast，几秒钟能糊满屏幕，用户会直接把提示关掉。
   所以**同一种动作连着来只提示一次**，动作换了才再提示一句 ——
   用户看到的是「它在读页面」「它在点」「它在打字」这三四个阶段，不是几十条流水。

   ★ 这是**纯函数**：只比「上一条提示是什么」，不碰 DOM、不碰 store ——
   真机事故两次都出在「看起来没逻辑的地方」，这种判断必须能单测。
   ══════════════════════════════════════════════════════════════ */

/** 主进程发来的四个动作（navigate 复用 `PendingBrowse` 的取值） */
export type BrowseAction = 'navigate' | 'snapshot' | 'click' | 'type'

/** 一条 toast 的内容 */
export interface BrowseNotice {
  level: 'info'
  title: string
  detail: string
}

/**
 * 这次动作该不该提示（同一种动作连着做多少次都只提示第一条）。
 *
 * @param lastKey  上一次提示的键（没有就给空串）
 * @param action   本次动作
 * @param url      navigate 时的地址
 * @returns `key` 是这次提示的键，调用方存下来给下次比；`notice` 为 `null` 表示闭嘴
 */
export function browseNotice(
  lastKey: string,
  action: BrowseAction,
  url = '',
): { key: string; notice: BrowseNotice | null } {
  /*
   * navigate 的键带上地址：Agent 连读三个**不同**页面是三个不同的进展，
   * 而同一个页面重复读（它自己也常这么干）不该重复提示。
   */
  const key = action === 'navigate' ? `navigate:${url}` : action
  if (key === lastKey) return { key, notice: null }

  switch (action) {
    case 'navigate':
      return { key, notice: { level: 'info', title: '正在用浏览器读取网页', detail: url } }
    case 'snapshot':
      return {
        key,
        notice: { level: 'info', title: 'Agent 正在读网页元素', detail: '找可点、可填的东西' },
      }
    case 'click':
      return {
        key,
        notice: { level: 'info', title: 'Agent 正在网页上点击', detail: '它在替你操作页面' },
      }
    case 'type':
      return {
        key,
        notice: { level: 'info', title: 'Agent 正在网页上输入', detail: '它在替你填内容' },
      }
    default:
      /* 将来内核加了新动作：不认识就不提示，别拿空标题糊用户 */
      return { key, notice: null }
  }
}

/**
 * 动作还是不是「在动网页」—— 用来点亮右栏「浏览器」标签上的角标。
 *
 * 四个动作都算：navigate 在开页面，snapshot/click/type 在操作页面，
 * 对用户来说都是「Agent 在用浏览器」。
 */
export function isBrowseAction(action: string): action is BrowseAction {
  return action === 'navigate' || action === 'snapshot' || action === 'click' || action === 'type'
}

/**
 * 扩展通道的 **kind / 错误码** 两张表（2026-10-16 从 `ext-protocol.cjs` 拆出）
 *
 * ── 为什么拆 ─────────────────────────────────────────────────
 *
 * `ext-protocol.cjs` 已 299 行贴红线，而 M04 剩余 + M05 要再加 4 个错误码。
 * 这两张表是**纯数据**、谁都要用（host / 主进程 / 自检），单独放一处正合适。
 * `ext-protocol.cjs` 会 require 它并**原样再导出**，所以调用点不用改
 * （与 `ext-probe-panel.cjs` 那个拆法同源）。
 *
 * ⚠️ 本模块**不 require 任何东西**（连 node 内置都不需要）—— host 进程要加载它。
 */

/** 协议版本。报文里的 `v`。将来改形状靠它分流（目前只有 1） */
const V = 1

/**
 * 消息类型（kind）—— **两侧共用的唯一一份**。
 *
 * ── ★ M04 剩余 + M05 为什么**没有**新增 kind ─────────────────
 *
 * 「让浏览器做一件事」已经有一条通用通道：`PAGE_COMMAND`（下行，带 `payload.command`）
 * + `PAGE_RESULT`（回执，带 id）。新增的 type / select / scroll / wait / navigate /
 * tabs.* **全都是这条通道上的不同 `command`** —— 所以协议层零新增 kind。
 * （这也是 M04-2 当初把下行做成「通用指令」而不是「一个动作一个 kind」的收益。）
 */
const KIND = {
  EXT_PAGE: 'ext:page', // 扩展读到的页面内容 → 落会话（Phase 2）
  SESSION_LIST: 'session:list', // 会话列表（Phase 3a）
  CHAT_SEND: 'chat:send', // 侧边栏发消息（3b）→ 主进程转给渲染层跑这一轮
  CHAT_RESUME: 'chat:resume', // 重连 / 重开后要一份流快照（3b）
  SESSION_ACTIVE: 'session:active', // Harbor 界面当前打开的是哪条会话（3b）
  CHAT_EVENT: 'chat:event', // push：一轮里的流事件（3b，**无 id**）
  SESSION_SELECT: 'session:select', // 侧边栏选了某条（3c）—— 只切它自己，主窗口不动
  SESSION_NEW: 'session:new', // 侧边栏点 ＋（3c）—— 新建一条并两侧切过去
  SESSION_SELECTED: 'session:selected', // push：侧边栏现在在看哪条（3c，**无 id**）
  PAGE_OBSERVE: 'page:observe', // 结构化页面观察（M03）：选区 / 元素列表 / iframe / 页面版本号
  PAGE_ELEMENTS: 'page:elements', // 元素列表视图（M04-1）：带 ref 解析 / 失效判定
  PAGE_COMMAND: 'page:command', // push：**下行指令**（M04）——主进程让扩展做一件事（command 区分做哪件）
  PAGE_RESULT: 'page:result', // 扩展执行完的**回执**（M04）—— 带 id，主进程按它配对
}

/**
 * 错误码 —— **唯一清单**。侧边栏文案由扩展侧渲染（它跑在浏览器里，require 不到
 * 这个模块），但**码**是契约：只有这里有定义，两侧的行为分支都按它。
 */
const ERR = {
  NO_HARBOR: 'NO_HARBOR', // Harbor 没在运行（管道不存在）
  TIMEOUT: 'TIMEOUT', // 主进程没在期限内回
  BAD_TOKEN: 'BAD_TOKEN', // token 不对
  BAD_FRAME: 'BAD_FRAME', // 帧解不开
  UNKNOWN_KIND: 'UNKNOWN_KIND', // 不认识的 kind
  INTERNAL: 'INTERNAL', // 处理时抛异常
  TOO_LARGE: 'TOO_LARGE', // 超出单帧上限
  SESSION_BUSY: 'SESSION_BUSY', // 那条会话正在别处跑（拒绝并发）
  NO_SESSION: 'NO_SESSION', // 目标会话不存在
  NO_WINDOW: 'NO_WINDOW', // 主窗口不在（C-α：渲染层是执行者，缺它跑不了）
  NO_BROWSER: 'NO_BROWSER', // 扩展不在（浏览器没开 / 没连上）—— 谈不上操作
  STALE_REF: 'STALE_REF', // 元素引用失效（页面版本变了 / 元素没了）—— 必须重新观察
  /*
   * ── M04 剩余 + M05 新增的四条 ──────────────────────────────
   * 前三条都属于「**没有执行**」这一类（与 STALE_REF 同族）：调用方据此知道
   * 页面上**什么都没发生**，而不是「执行了但结果不明」—— 这个区分对模型很关键。
   */
  SENSITIVE_FIELD: 'SENSITIVE_FIELD', // 敏感字段（密码 / 信用卡）——**拒绝写入**，页面未被改动
  DENIED: 'DENIED', // 用户在小卡片上按了「拒绝」——**没执行**
  CONFIRM_TIMEOUT: 'CONFIRM_TIMEOUT', // 等确认等到超时——按拒绝处理，**没执行**
  NO_TAB: 'NO_TAB', // 目标标签页不在（id 不存在 / 已关闭 / 不是可访问的 http(s) 页）
}

module.exports = { V, KIND, ERR }

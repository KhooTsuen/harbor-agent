/**
 * 界面选择器的**唯一真相源**（真机脚本 / 截图脚本共用）
 *
 * ── 为什么单独一个文件（2026-11-02，用户报的问题）────────────────
 * 用户原话：「你每次测试的时候都会打开选择对话文件夹」。
 *
 * 根因不是某个脚本写错，而是**12 个脚本各自抄了一份** `/^新建对话/`：
 * 那是**前缀**匹配，而侧栏里排在前面的那个按钮叫「新建对话并指定目录」
 * （`SidebarPanes.tsx` 里「对话文件夹」标题旁那个 ＋）。点它必然走
 * `workdir:choose` → 原生目录框。窗口被模态框挡住之后脚本照跑不误，
 * 只是**后面每一步都没落地**（截图上是历史会话），于是「全绿但什么都没验」。
 *
 * ── 规矩（改之前先读完）─────────────────────────────────────────
 * ① 匹配必须**完全相等**（aria-label / title / 文本），不许用前缀 ——
 *    「新建对话」和「新建对话并指定目录」共享前四个字，前缀匹配分不开它们。
 * ② 「新建一条空对话」只认 `NEW_CHAT_LABELS` 里的两个名字：
 *    「新建单独对话」（侧栏展开时那个 ＋）、「新建对话」（侧栏折叠时那张图标）。
 *    「新建对话并指定目录」**故意不在**列表里 —— 它要开原生框，脚本不该点。
 * ③ 文案与挑选规则各只有一份：`NEW_CHAT_LABELS` + `pickNewChatLabel`。
 *    页面里执行时把 `pickNewChatLabel` 的源码内联进表达式（`toString()`），
 *    不在表达式里再抄一遍文案 —— 抄两份必然漂。
 * ④ **「停止」也是同一类坑**（2026-11-02 补）：发送区里有个按钮的
 *    `aria-label` 是「立即发送（先停止当前任务）」——它**含有「停止」两个字**。
 *    老脚本用 `/停止/` 正则找「停止生成」，一旦那个按钮在 DOM 里排在前面，
 *    「按停止」就变成了「立刻发出去」，而「还在跑吗」永远为真（那个按钮本来就在）。
 *    所以停止 / 发送一律走精确名单，和新建对话同一套规则。
 *
 * ⚠️ 渲染层改了按钮文案（`aria-label`），这里要同步 —— 否则脚本会**静默失效**
 * （照跑不误、却点不到）。自检 `198-ui-selectors` 会把两头对一遍。
 */

/** 「新建一条空对话」认的可访问名字（顺序 = 优先级，不是随便排的） */
export const NEW_CHAT_LABELS = ['新建单独对话', '新建对话']

/** 「停止这一轮」认的可访问名字（**只有**发送区那个方块按钮） */
export const STOP_LABELS = ['停止生成']

/** 「发出去」认的可访问名字（发送区那个箭头上） */
export const SEND_LABELS = ['发送消息']

/**
 * 从「页面上看得见的按钮名字」里挑一个该点的。
 *
 * 纯函数、不碰 DOM —— 自检直接喂一串名字就能跑（要的正是这个：
 * 「给定现在的侧栏按钮清单，脚本会点中哪一个」能用一句话钉住）。
 *
 * @param {string[]} names 页面上按 DOM 顺序排好的可访问名字
 * @param {readonly string[]} labels 精确名单
 * @returns {string | null} 该点的那个名字；一个都不匹配就是 null（脚本会报没点到）
 */
export function pickExactLabel(names, labels) {
  for (const label of labels) if (names.includes(label)) return label
  return null
}

/**
 * 新建对话那个的专用入口 —— 语义名字比通用函数好用，
 * 而且 `NEW_CHAT` 表达式里内联的就是它（`toString()` 取源码）。
 */
export function pickNewChatLabel(names) {
  return pickExactLabel(names, NEW_CHAT_LABELS)
}

/**
 * 造一个「点一下」的页面表达式。
 *
 * 文案与挑选规则都从上面那两份定义走（`JSON.stringify` / `toString()`），
 * 表达式里**不出现第二个字面量**：改名单只改一处，三个动作一起跟上。
 */
function clickExpression(labels) {
  return `(function(){
  const LABELS = ${JSON.stringify(labels)}
  const pick = ${pickExactLabel.toString()}
  const nameOf = (x) => x.getAttribute('aria-label') || x.getAttribute('title') || (x.textContent || '').trim()
  const found = [...document.querySelectorAll('button')].map((el) => ({ el, name: nameOf(el) }))
  const hit = pick(found.map((b) => b.name), LABELS)
  if (!hit) return false
  found.find((b) => b.name === hit).el.click()
  return true
})()`
}

/** 造一个「在不在」的页面表达式（同一套挑选规则，只判断不点） */
function presentExpression(labels) {
  return `(function(){
  const LABELS = ${JSON.stringify(labels)}
  const pick = ${pickExactLabel.toString()}
  const nameOf = (x) => x.getAttribute('aria-label') || x.getAttribute('title') || (x.textContent || '').trim()
  return pick([...document.querySelectorAll('button')].map(nameOf), LABELS) !== null
})()`
}

/**
 * 在页面里执行：新建一条空对话。
 *
 * 返回 `true` 表示点到了 —— 但**「点到了」不等于「新对话建出来了」**：
 * 要证明这一点得看新会话真的出现（真机脚本里各自有那条判据）。
 */
export const NEW_CHAT = clickExpression(NEW_CHAT_LABELS)

/** 在页面里执行：点「停止生成」。返回 `true` = 点到了 */
export const STOP = clickExpression(STOP_LABELS)

/** 在页面里执行：现在是不是有一轮在跑（发送区那个停止按钮在不在） */
export const RUNNING = presentExpression(STOP_LABELS)

/** 在页面里执行：点「发送消息」。返回 `true` = 点到了 */
export const SEND = clickExpression(SEND_LABELS)

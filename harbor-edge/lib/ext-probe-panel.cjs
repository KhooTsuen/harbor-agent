/**
 * 侧边栏面板的 **DOM 锚点**（从 `ext-probe.cjs` 拆出来的，那边已 300 行）
 *
 * ── 这里放什么 ───────────────────────────────────────────────
 *
 * 「按可访问名字找侧边栏里的元素」的那些表达式与判据 —— 验收脚本靠它们点按钮、
 * 读文案。拆出来的理由和 `lib/driver.cjs` 一样：**只有一份定义**（硬约束 #9），
 * 各脚本自己抄一份迟早漂。ext-probe 会把这边的导出**原样再导出**，所以
 * `P.STATUS_TEXT_EXPR` 这类调用点不用改。
 *
 * ── ★ 一条必须记住的规矩（Phase 3b 布局返工踩到）──────────────
 *
 *   **能带文字的按钮，优先按文字找；没有文字的（图标按钮），必须按 `aria-label`
 *   找。** 布局返工把「读当前页」压成了图标按钮 —— 当时按 `textContent` 找的
 *   表达式会永远找不到（`no-button`），而脚本**照跑不误**，只是判据静默失效。
 *   渲染层改文案 / 改 aria-label 时，**这里必须同步**（与 `tools/shot/cards.mjs`
 *   那条规矩同源）。
 *
 * ── 锚点归属表（Phase 3b 布局返工 v2 = ☰ / 状态区 / 设置+新建）──
 *
 *   | 渲染层元素                    | aria-label       | 哪个表达式用它 |
 *   |-------------------------------|------------------|----------------|
 *   | 顶栏 ☰（抽屉开关，**图标**）   | `选择对话`       | CLICK_TITLE_EXPR |
 *   | 顶栏状态区的**当前会话名**     | `当前对话`       | TITLE_EXPR |
 *   | 抽屉本身                       | `会话抽屉`       | DRAWER_OPEN_EXPR / CLICK_OUTSIDE_EXPR |
 *   | 抽屉里的列表容器               | `Harbor 会话列表`| SESSION_LIST_EXPR |
 *   | 输入框上方那行状态             | `发送提示`       | STATUS_TEXT_EXPR / NOTICE_TEXT |
 *
 *   ⚠️ ☰ 与抽屉**不能同名**：同名会让 `CLICK_TITLE_EXPR` 点到抽屉自身
 *   （点自己 = 没反应，判据还照过 —— 最难查的那种假绿）。
 *
 * ── 另一个必须守的不变量 ─────────────────────────────────────
 *
 *   `STATUS_TEXT_EXPR` 取的是**文档里第一个** `[role=status][aria-live=polite]`。
 *   所以侧边栏里**只允许有一个**这样的元素 —— 顶栏的连接文字是纯文本、
 *   抽屉里的提示用 `role=alert`，唯一那个就是对话区输入框上方那行。
 */

/** 侧边栏上那句状态文案（读页面的结果 / 发送提示，共用一个元素） */
const STATUS_TEXT_EXPR = `(document.querySelector('[role=status][aria-live=polite]') || {}).innerText || ''`

/**
 * 状态区是不是「已经出结果」了。
 *
 * ★ 要排掉**过程态**文案：那种也有文字，不排除就会在结果出来之前命中
 *   —— 第一版真这么假过了一次（那时排的是默认文案「读取当前标签页的正文」）。
 *   Phase 3b 后初始状态**不渲染**这个元素（空串），过程态是中「读取中…」。
 */
function isResultText(v) {
  return typeof v === 'string' && v.length > 0 && !v.includes('读取中') && !v.includes('正在读取')
}

/** 点侧边栏那个「读当前页」按钮 —— **图标按钮，没有文字**，只能按 aria-label 找 */
const CLICK_READ_EXPR = `(function(){
  const b = document.querySelector('[aria-label="读当前页"]')
    || [...document.querySelectorAll('button')].find(x => /读当前页|读取中/.test(x.textContent));
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`

/** 点「重试」 */
const CLICK_RETRY_EXPR = `(function(){
  const b = [...document.querySelectorAll('button')].find(x => /重试/.test(x.textContent));
  if (b) b.click();
  return 'ok';
})()`

/* ── 顶栏的「☰ / 当前对话」（Phase 3b 布局返工 v2）────────── */

/**
 * 顶栏那个 **☰ 开关**（也是抽屉的开关）。
 *
 * ⚠️ 它是**图标按钮**（没有可见文字），只能按 `aria-label` 找 —— 点它开抽屉。
 */
const CLICK_TITLE_EXPR = `(function(){
  const b = document.querySelector('[aria-label="选择对话"]');
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`

/** 状态区里那条**当前会话名**（顶栏中间；☰ 是图标没有文字，读标题要读它） */
const TITLE_EXPR = `(function(){
  const b = document.querySelector('[aria-label="当前对话"]');
  return b ? b.innerText : '';
})()`

/** 抽屉开着没有（它在 DOM 里 = 开着；默认不挂载） */
const DRAWER_OPEN_EXPR = `!!document.querySelector('[aria-label="会话抽屉"]')`

/** 点抽屉**外面**（点背板 → 收起）—— 背板是抽屉的父节点 */
const CLICK_OUTSIDE_EXPR = `(function(){
  const d = document.querySelector('[aria-label="会话抽屉"]');
  if (!d || !d.parentElement) return 'no-drawer';
  d.parentElement.click();
  return 'clicked';
})()`

/* ── 会话列表（Phase 3a）────────────────────────────────────── */

/**
 * 读会话列表区块当前渲染出来的东西（条数 + 每条的标题/时间）。
 *
 * ⚠️ **Phase 3b 后它在抽屉里**（默认不挂载）→ 读之前先 `CLICK_TITLE_EXPR`
 *    点开顶栏 ☰，否则拿到 `found:false`。
 */
const SESSION_LIST_EXPR = `(function(){
  const sec = document.querySelector('[aria-label="Harbor 会话列表"]');
  if (!sec) return JSON.stringify({ found: false });
  const items = [...sec.querySelectorAll('li')].map(li => li.innerText.split('\\n'));
  return JSON.stringify({ found: true, text: sec.innerText, count: items.length, items });
})()`

/** 点「刷新」按钮（按它自己的 aria-label 找） */
const CLICK_REFRESH_EXPR = `(function(){
  const b = document.querySelector('[aria-label="刷新会话列表"]')
    || [...document.querySelectorAll('button')].find(x => /刷新/.test(x.textContent));
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`

module.exports = {
  STATUS_TEXT_EXPR,
  isResultText,
  CLICK_READ_EXPR,
  CLICK_RETRY_EXPR,
  TITLE_EXPR,
  CLICK_TITLE_EXPR,
  DRAWER_OPEN_EXPR,
  CLICK_OUTSIDE_EXPR,
  SESSION_LIST_EXPR,
  CLICK_REFRESH_EXPR,
}

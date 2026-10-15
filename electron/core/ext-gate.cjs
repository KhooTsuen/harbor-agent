/**
 * M04-3：**敏感操作判定**（唯一一处）
 *
 * ── 为什么单列一个模块 ────────────────────────────────────────
 *
 * 用户定的硬要求：「点击可能提交 / 删除 / 发布的按钮前，弹确认卡」，而且要
 * **做得扎实，不是「点一下过」**。那么第一个问题就是「**哪些算敏感**」——
 * 这件事必须**只有一处**判定（硬约束 #9），否则「界面拦了但扩展没拦」
 * 这种漂移必然发生。
 *
 * 所以：判定是**纯函数**（输入元素记录 → 输出该不该确认），自检直接喂假元素跑，
 * 不碰 DOM、不碰 IPC。`ext-command.cjs` 只调它，自己不做判断。
 *
 * ── ★★ 一个 HTML 的坑：`<button>` 的 type **默认就是 submit** ──
 *
 * 所以**不能**用「type === 'submit'」当敏感判据 —— 那会把页面上每一个普通按钮
 * 都当成提交按钮（真机上 `<button>点我</button>` 实测 `el.type === 'submit'`）。
 * 判定因此以**文本语义**为主、表单上下文为辅：
 *
 *   · 主判据：按钮文本 / 提示语命中**危险词表**（提交、发送、删除…）
 *   · 辅判据：在 `method=post` 的表单里 ← 「会往外发东西」这一类的强信号
 *   · 反向：命中**安全词表**（取消、关闭、返回、搜索…）且不含危险词 → 不拦
 */

/**
 * 危险词表 —— 命中即需要确认。
 *
 * ⚠️ 只放**会对外产生后果**的词。像「确定」「好的」这种不成词的太宽，会把
 *    「确定」类的小按钮全拦下来（那是噪声，不是保护），所以不收。
 */
const RISKY_WORDS = [
  // 提交 / 发送类
  '提交', '发送', '发出', '递交', '上报',
  // 金钱类
  '购买', '支付', '付款', '下单', '结算', '充值', '提现', '转账', '缴费', '订阅', '开通会员',
  // 破坏 / 不可逆类
  '删除', '移除', '清除', '注销', '销户', '解绑', '退订', '取消订阅', '撤销', '作废',
  // 对外发布类
  '发布', '上传', '推送', '群发', '公开',
  // 授权 / 许可类
  '授权', '同意并', '允许访问', '确认授权', '接受条款', '同意条款',
  // 英文（不少站点是英文界面）
  'submit', 'send', 'buy', 'purchase', 'pay', 'checkout', 'delete', 'remove', 'publish',
  'upload', 'unsubscribe', 'confirm order', 'place order', 'sign out', 'deactivate',
]

/**
 * 安全词表 —— 命中**且不含危险词**时不拦。
 *
 * 为什么需要：很多危险词的**否定形式**或**导航性质**的按钮会误伤，比如
 * 「取消提交」「返回上一步」「搜索」。
 */
const SAFE_WORDS = [
  '取消', '关闭', '返回', '上一页', '下一页', '上一步', '下一步', '搜索', '查找', '筛选',
  '详情', '更多', '查看', '展开', '收起', '刷新', '重试', '编辑', '复制', '分享', '预览',
  'cancel', 'close', 'back', 'next', 'search', 'filter', 'more', 'view', 'refresh', 'edit',
]

/**
 * 提交类元素：`<button>`（**显式排除 `type=button` / `reset`**）或 `<input type=submit|image>`。
 *
 * ── ★★ 这里踩过一次（2026-10-16 真机，m04d ⑪）────────────────
 *
 * HTML 里 `<button>` **不写 type 时 `el.type` 就是 `submit`** —— 所以既不能
 * 「凡 button 皆算提交」（那会把「看详情」这种只读按钮也拦下来，只要它在某个
 * `method=post` 的表单里），也不能「只认 type===submit」（那样每一个 button 都命中）。
 *
 * 可用的判据是**显式否定的那一边**：作者**写了** `type="button"` / `type="reset"`，
 * 那就是明确表态「这不是提交」→ 排除。没写（读出来是 submit）→ 按提交处理。
 */
function isSubmitLike(el) {
  const tag = String(el?.tag || '').toUpperCase()
  const btnType = String(el?.btnType || '').toLowerCase()
  if (tag === 'BUTTON') return btnType !== 'button' && btnType !== 'reset'
  if (tag === 'INPUT' && (btnType === 'submit' || btnType === 'image')) return true
  return false
}

/** 这条元素的「语义文本」：可见文本 + placeholder（两者都可能带按钮用途） */
function semanticText(el) {
  return `${String(el?.text ?? '')} ${String(el?.placeholder ?? '')}`.toLowerCase()
}

/**
 * 这条元素点下去要不要**先确认**。
 *
 * @param {object} el M03 采集的元素记录（`ref` / `tag` / `role` / `text` / `btnType` / `formMethod` …）
 * @returns {{ needsConfirm: boolean, level: 'normal'|'risky', reasons: string[], why: string }}
 *   `reasons` 原样进确认卡（让用户看见**为什么**要问），`why` 一句话摘要。
 */
function judge(el) {
  const e = el && typeof el === 'object' ? el : {}
  const text = semanticText(e)
  const tag = String(e.tag || '').toUpperCase()
  const method = String(e.formMethod || '').toLowerCase()

  const hitRisky = RISKY_WORDS.filter((w) => text.includes(w))
  const hitSafe = SAFE_WORDS.filter((w) => text.includes(w))
  const postForm = method === 'post' && isSubmitLike(e)

  /*
   * ★ 安全词**优先**：文本里明显是在导航 / 取消时放过 —— 但只在**没命中危险词**
   *   的情况下生效。「取消提交」这种同时含两边的，仍按危险处理（宁可多问一次）。
   *   ⚠️ 而且只在**不是 POST 表单提交按钮**时——那是「会往外发东西」的硬信号。
   */
  if (postForm) {
    return {
      needsConfirm: true,
      level: 'risky',
      reasons: [`它会提交一个 method=post 的表单（这通常意味着把数据**发出去**）`],
      why: '提交表单',
    }
  }
  if (hitRisky.length > 0 && !(hitSafe.length > 0 && hitRisky.length === 0)) {
    return {
      needsConfirm: true,
      level: 'risky',
      reasons: [`按钮文字里有「${hitRisky[0]}」这类动作 —— 点下去可能有不可撤销的后果`],
      why: `点击「${String(e.text || '').slice(0, 30) || '该按钮'}」`,
    }
  }
  if (tag === 'A' && String(e.href || '').length > 0) {
    return { needsConfirm: false, level: 'normal', reasons: [], why: '普通链接' }
  }
  return { needsConfirm: false, level: 'normal', reasons: [], why: '普通操作' }
}

/**
 * 给确认卡准备**给人看的内容**（不写空话 —— 用户要一眼看懂「点下去会怎样」）。
 *
 * @param {object} el 元素记录
 * @param {{ url?: string, title?: string }} page 当前页面
 */
function describe(el, page) {
  const e = el && typeof el === 'object' ? el : {}
  const p = page && typeof page === 'object' ? page : {}
  const j = judge(e)
  const where = `${String(p.title || '').slice(0, 60) || '(无标题)'}（${String(p.url || '').slice(0, 80)}）`
  const what = String(e.text || '').slice(0, 60) || String(e.role || e.tag || '元素')
  return {
    name: 'browser.click',
    summary: `${j.why} —— 这属于**对外操作**，先跟你确认一下`,
    kind: 'browser-action',
    impact: [
      `页面：${where}`,
      `元素：${what}（${String(e.role || e.tag || '未知')}${e.btnType ? ` · type=${e.btnType}` : ''}）`,
      ...j.reasons,
      '点下去之后**可能不可撤销**（提交 / 支付 / 删除这一类）。',
    ],
  }
}

module.exports = { judge, describe, RISKY_WORDS, SAFE_WORDS, isSubmitLike }

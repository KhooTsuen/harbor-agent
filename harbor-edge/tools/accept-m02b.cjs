/**
 * M02-B 真机验收：**当前网页卡 + 上下文开关 + 任务卡**（在真侧栏里）。
 *
 * 环境搭建（起服务器 / 桥 / 隔离 Edge / 真侧栏）在 `lib/ext-m02b-stage.cjs` ——
 * 本文件只剩**验什么**。走用户路径，不是新开扩展页标签。
 * 任务卡靠真推 `chat:event` 验后半段（侧栏收没收到、画没画出来）。
 */
const M = require('../lib/ext-m02b-stage.cjs')

const { sleep, inPanel, hasCard, countIn } = M

let pass = 0
const failures = []
function rec(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}  -- ${String(detail ?? '').slice(0, 170)}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}  -- ${String(detail ?? '').slice(0, 300)}`)
  }
}

const regSnap = M.regSnapOf()

/**
 * 设置抽屉里**不该**出现站点开关（M02-C 的硬要求：不提前做第二套）。
 * 用「有没有 checkbox」当判据 —— 抽屉里本来一个勾选框都没有。
 */
async function hasNoSiteToggle(panel) {
  const n = await inPanel(panel, `document.querySelectorAll('[aria-label="设置抽屉"] input[type=checkbox]').length`)
  return n === 0
}
/** setup 的返回（收尾要它来清会话） */
let ENV = null

async function main() {
  const env = await M.setup(rec)
  ENV = env
  if (!env.ok) return
  const { panel, bridge, Proto, sess, readCtx, chatRelay, sent } = env

  /*
   * ★ 两处都要设，少一处就会静默落错地方（本轮真机逮到）：
   *   · `chatRelay.handleSelect` → **主进程侧**的 selectedSessionId（决定内容落哪条）
   *   · `bridge.push(SESSION_SELECTED)` → 让**侧栏 UI** 知道自己在看哪条
   * 只推 push 不调 handleSelect 时，主进程的 selected 仍是空 → 走 active（也空）
   * → 兜底**新建一条**会话 → 「计数没变」的判据全部变成假通过。
   */
  chatRelay.handleSelect({ sessionId: sess.id })
  bridge.push(Proto.KIND.SESSION_SELECTED, { sessionId: sess.id })
  await sleep(1000)

  /* ════════ 第一组：当前网页卡 ════════ */
  rec('⑧ ★★★ 当前网页卡出现了', (await inPanel(panel, hasCard('当前网页卡'))) === true)

  const info = await inPanel(
    panel,
    `({title: document.querySelector('[aria-label="当前网页"]')?.innerText||'', host: document.querySelector('[aria-label="当前网页域名"]')?.innerText||'', cant: !!document.querySelector('[aria-label="读不了原因"]')})`,
  )
  rec('⑨ ★★★ 卡片显示的是**用户那一页**（不是侧栏自己）', String(info.title || '').includes('M02B 验收页'), `标题='${info.title}' · 域名='${info.host}'`)
  rec('⑩ ★★ 拿得到地址 → 不显示「点图标才能读」', info.cant === false, `cant=${info.cant}`)

  /* ════════ 第二组：上下文开关 ════════ */
  const clickCtx = () => inPanel(panel, `(document.querySelector('[aria-label="上下文开关"]').click(), true)`)

  rec('⑪ ★★ 上下文开关默认开（没存过 = 开）', (await readCtx())?.harborContextEnabled === undefined)
  await clickCtx()
  await sleep(900)
  rec('⑫ ★★★ 关掉之后真落进 chrome.storage.local', (await readCtx())?.harborContextEnabled === false)

  const statusText = await inPanel(panel, `document.querySelector('[aria-label="发送提示"]')?.innerText||''`)
  rec('⑬ ★ 关掉时状态行给了人话', String(statusText).includes('不会自动带上'), `'${String(statusText).slice(0, 60)}'`)

  await clickCtx()
  await sleep(700)
  rec('⑭ ★★ 再点一下能开回来', (await readCtx())?.harborContextEnabled === true)

  /*
   * ★★★ 开关不是摆设：先把「开着能读」立成基线，否则「关掉没读」证明不了任何事。
   * ⑭b 基线（计数增加）→ ⑭c 关掉（计数不变 + 人话）→ ⑭e 开回来（又增加）。
   */
  const clickRead = () => inPanel(panel, `(document.querySelector('[aria-label="读当前页"]').click(), true)`)
  const n0 = countIn(sess.id, 'M02B 验收页')
  await clickRead()
  await sleep(4000)
  const n1 = countIn(sess.id, 'M02B 验收页')
  rec('⑭b ★★★ 基线：开关开着时「读当前页」真的读进这条会话', n1 > n0, `计数 ${n0}→${n1}`)

  await clickCtx() /* 关掉 */
  await sleep(900)
  const n2 = countIn(sess.id, 'M02B 验收页')
  await clickRead()
  await sleep(3500)
  const n3 = countIn(sess.id, 'M02B 验收页')
  rec('⑭c ★★★ 关掉之后同样的操作 → 一个字都没进会话', n3 === n2, `计数 ${n2}→${n3}`)

  const gateMsg = await inPanel(panel, `document.querySelector('[aria-label="发送提示"]')?.innerText||''`)
  rec('⑭d ★★★ 并且给的是「上下文已关闭」的人话（不是含糊的失败）', String(gateMsg).includes('上下文已关闭'), `'${String(gateMsg).slice(0, 80)}'`)

  await clickCtx() /* 开回来 */
  await sleep(900)
  const n4 = countIn(sess.id, 'M02B 验收页')
  await clickRead()
  await sleep(4000)
  const n5 = countIn(sess.id, 'M02B 验收页')
  rec('⑭e ★★★ 开回来之后又能读了（排除「本来就读不了」）', n5 > n4, `计数 ${n4}→${n5}`)

  /* ════════ 第三组：任务卡（真推 chat:event）════════ */
  rec('⑮ ★★★ 没在跑时任务卡不占位置', (await inPanel(panel, hasCard('任务卡'))) === false)

  let seq = 0
  const push = (type, extra = {}) => {
    seq += 1
    bridge.push('chat:event', { requestId: 'req_m02b', sessionId: sess.id, seq, type, text: '', done: false, ...extra })
  }
  const taskText = () => inPanel(panel, `document.querySelector('[aria-label="任务状态"]')?.innerText||''`)
  const taskDetail = () => inPanel(panel, `document.querySelector('[aria-label="任务详情"]')?.innerText||''`)

  push('turn_start', { turn: 1 })
  await sleep(1200)
  rec('⑯ ★★★ 收到 turn_start → 任务卡出现，显示「正在回复…」', (await inPanel(panel, hasCard('任务卡'))) === true && String(await taskText()).includes('正在回复'))
  rec('⑰ ★★ 卡片上标了第几轮', String(await taskDetail()).includes('第 1 轮'))

  push('plan', { plan: ['a', 'b', 'c'] })
  await sleep(900)
  rec('⑱ ★★ 收到 plan → 计划步数显示出来', String(await taskDetail()).includes('计划 3 步'))

  push('agent.tool.started', { name: 'read_file' })
  await sleep(1000)
  rec('⑲ ★★★ 收到 agent.tool.started → 显示当前工具（真名对齐）', String(await taskText()).includes('read_file'))

  push('agent.tool.completed')
  await sleep(900)
  rec('⑳ ★★ 工具完成 → 退回「正在回复…」', String(await taskText()).includes('正在回复'))

  push('confirm_request')
  await sleep(900)
  rec('㉑ ★★★ 收到 confirm_request → 「等你确认」显眼提示', String(await taskText()).includes('等你确认'))

  push('done', { text: '好了', done: true })
  await sleep(1200)
  rec('㉒ ★★★ done → 任务卡收掉（确认态一起清）', (await inPanel(panel, hasCard('任务卡'))) === false)
  rec('㉒a 回复结束后出现重新生成入口', (await inPanel(panel, `Array.from(document.querySelectorAll('button')).some(b => b.textContent === '重新生成')`)) === true)
  await inPanel(panel, `(Array.from(document.querySelectorAll('button')).find(b => b.textContent === '重新生成')?.click(), true)`)
  await sleep(500)
  rec('㉒b 真侧栏重新生成请求传给目标会话', sent.some((row) => row.channel === 'chat:event' && row.payload?.type === 'ext:regenerate' && row.payload.sessionId === sess.id))
  const beforeDraft = countIn(sess.id, 'P0选区草稿')
  await panel.evalIn(`chrome.runtime.sendMessage({type:'selection-draft',text:'P0选区草稿',url:'http://127.0.0.1:8911/'})`)
  await sleep(500)
  rec('㉒c 选中文字进入当前对话草稿，不自动发送', (await inPanel(panel, `document.querySelector('[aria-label="消息输入框"]')?.value.includes('P0选区草稿')`)) === true && countIn(sess.id, 'P0选区草稿') === beforeDraft)

  /* ════════ 第四组：设置抽屉（M02-C）════════ */
  rec('㉓ ★★★ 点顶栏「设置」→ 抽屉真的打开', (await inPanel(panel, `(document.querySelector('[aria-label="设置"]').click(), true)`)) === true)
  await sleep(900)
  rec('㉔ ★★★ 抽屉出现了（不再是「扩展设置还没做」那句）', (await inPanel(panel, hasCard('设置抽屉'))) === true)

  const d = await inPanel(
    panel,
    `({host: document.querySelector('[aria-label="host 名"]')?.innerText||'', conn: document.querySelector('[aria-label="连接状态详情"]')?.innerText||'', perms: Array.from(document.querySelectorAll('[aria-label="权限列表"] li')).map(function(li){return li.innerText}), site: document.querySelector('[aria-label="站点权限说明"]')?.innerText||''})`,
  )
  rec('㉕ ★★★ 连接信息印的是真 host 名', String(d.host).includes('com.harbor.agent'), `host='${d.host}'`)
  const manifestPermissions = require('../extension/manifest.json').permissions
  rec('㉖ ★★★ 能力清单从 manifest 现算', Array.isArray(d.perms) && d.perms.length === manifestPermissions.length, JSON.stringify(d.perms).slice(0, 160))
  rec('㉗ ★★★ 能力清单是人话（不是把权限名直接糊上去）', String(d.perms.join(' ')).includes('唯一的数据通道'), String(d.perms.join(' | ')).slice(0, 120))
  rec('㉘ ★★★ 站点权限只指路（说清归主应用管，没有开关）', String(d.site).includes('主应用统一管'), `'${String(d.site).slice(0, 70)}'`)
  rec('㉙ ★★ 抽屉里**没有**站点开关（不提前做第二套）', (await hasNoSiteToggle(panel)) === true)

  const siteButton = (label) => `Array.from(document.querySelectorAll('[aria-label="站点权限"] button')).find(b => b.textContent.includes('${label}'))`
  rec('㉙a 当前站点能临时拒绝', (await inPanel(panel, `(${siteButton('临时拒绝 1 小时')}?.click(), true)`)) === true)
  await sleep(700)
  rec('㉙b 已拒绝站点出现在主进程策略列表', Boolean(await inPanel(panel, `document.querySelector('[aria-label="已拒绝站点"]')?.textContent.includes('127.0.0.1')`)))
  const deniedRaw = await panel.evalIn(`(async()=>JSON.stringify(await chrome.runtime.sendMessage({type:'read-page',sessionId:'${sess.id}'})))()`)
  const denied = JSON.parse(String(deniedRaw || '{}'))
  rec('㉙b2 临时拒绝后页面读取确实被阻断', denied.ok === false && /拉黑|拒绝/.test(String(denied.error || '')), String(denied.error || ''))
  rec('㉙c 用户可以撤销临时拒绝', (await inPanel(panel, `(${siteButton('撤销')}?.click(), true)`)) === true)
  await sleep(700)
  rec('㉙d 撤销后列表不再显示该站点', (await inPanel(panel, `!document.querySelector('[aria-label="已拒绝站点"]')`)) === true)

  await inPanel(panel, `(document.querySelector('[aria-label="收起设置"]').click(), true)`)
  await sleep(700)
  rec('㉚ ★★ 收起之后抽屉消失', (await inPanel(panel, hasCard('设置抽屉'))) === false)

  panel.close()
  env.server.close()
}

main()
  .catch((e) => {
    console.log('ERROR:', e && e.message)
    failures.push('异常：' + (e && e.message))
  })
  .finally(() => {
    M.teardown(ENV, regSnap)
    console.log(`\n════ 通过 ${pass} 项，失败 ${failures.length} 项 ════`)
    for (const f of failures) console.log('   ✗ ' + f)
    process.exit(failures.length === 0 ? 0 : 1)
  })

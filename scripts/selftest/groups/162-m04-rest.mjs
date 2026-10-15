/**
 * 自检 / M04 剩余 + M05：填表 / 滚动 / 等待 / 导航 / 敏感确认 / 标签页
 *
 * 四块：
 *   ① **注入函数自包含**（`act-form.js` / `act-nav.js`）—— 引用了模块级东西，
 *      注入后必 ReferenceError，而单测抓不到（M03 §8.1 那条铁律）。
 *   ② **敏感判定**（`core/ext-gate.cjs`）—— 纯函数，喂假元素真跑。
 *   ③ **渲染**（type 拒密码要说「页面没被改动」；选项找不到要列可选值）。
 *   ④ **接线**（协议 / 分派 / SW / 模块边界）—— 少一处就是「指令没人接」。
 */

import { readFileSync, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

export async function run() {
  const G = require(join(ROOT, 'electron/core/ext-gate.cjs'))
  const P = require(join(ROOT, 'electron/core/ext-protocol.cjs'))
  const formSrc = R('harbor-edge/extension/lib/act-form.js')
  const navSrc = R('harbor-edge/extension/lib/act-nav.js')
  const runSrc = R('harbor-edge/extension/lib/act-run.js')
  const tabsSrc = R('harbor-edge/extension/lib/tabs-run.js')
  const cmdRunSrc = R('harbor-edge/extension/lib/command-run.js')
  const opsSrc = R('electron/core/ext-ops.cjs')
  const cmdSrc = R('electron/core/ext-command.cjs')
  const regSrc = R('electron/register-handlers.cjs')
  const obsSrc = R('electron/core/ext-observe.cjs')
  const actionsSrc = R('electron/core/ext-actions.cjs')
  const tabsMainSrc = R('electron/core/ext-tabs.cjs')
  const confirmSrc = R('electron/handlers/ext-confirm.cjs')
  const kindsSrc = R('electron/core/ext-kinds.cjs')

  /* ── ① 协议：这批的能力**没有**新增 kind（全走既有 PAGE_COMMAND）── */
  group('M04 剩余 · 协议（不新增 kind —— 全走既有下行指令）')
  check('★ PAGE_COMMAND / PAGE_RESULT 仍在（复用它）', P.KIND.PAGE_COMMAND === 'page:command' && P.KIND.PAGE_RESULT === 'page:result')
  check('★ kind 表拆到 ext-kinds.cjs（ext-protocol 再导出，调用点不变）', /PAGE_COMMAND/.test(kindsSrc) && /require\('\.\/ext-kinds\.cjs'\)/.test(R('electron/core/ext-protocol.cjs')))
  check('★ 新增四条错误码', ['SENSITIVE_FIELD', 'DENIED', 'CONFIRM_TIMEOUT', 'NO_TAB'].every((k) => P.ERR[k] === k))

  /* ── ② 注入函数必须自包含 ── */
  group('M04 剩余 · 注入函数必须自包含（executeScript 会 toString 后注入）')
  const injectors = [
    ['typeText', formSrc],
    ['selectOption', formSrc],
    ['scrollPage', navSrc],
  ]
  for (const [name, src] of injectors) {
    check(`★ ${name} 是具名导出函数`, new RegExp(`export function ${name}\\(`).test(src))
  }
  check('★ 三个注入函数体里都没有 require / import', !/\brequire\(|^\s*import\s/m.test(formSrc.replace(/^import[\s\S]*?\n\n/m, '')) && !/\brequire\(/.test(navSrc))
  /* 自包含：函数体内不能出现模块级常量名（这几个文件顶层只有注释与 import） */
  const topConsts = [...`${formSrc}\n${navSrc}`.matchAll(/^const ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  check('★ 顶层没有常量会被泄漏进函数体', topConsts.length === 0, topConsts.join(','))

  /* ── ③ 敏感判定（纯函数真跑）── */
  group('M04 剩余 · 敏感操作判定（ext-gate，唯一一处）')
  check('★ 危险词「提交」→ 要确认', G.judge({ tag: 'BUTTON', text: '提交订单', btnType: 'button' }).needsConfirm === true)
  check('★ 危险词「删除」→ 要确认', G.judge({ tag: 'BUTTON', text: '删除', btnType: 'button' }).needsConfirm === true)
  check('★ 危险词「支付 / 购买 / 发布」都要确认', ['支付', '购买', '发布', '上传', '注销'].every((w) => G.judge({ tag: 'BUTTON', text: w, btnType: 'button' }).needsConfirm === true))
  check('★ POST 表单的提交按钮 → 要确认', G.judge({ tag: 'INPUT', text: 'Go', btnType: 'submit', formMethod: 'post' }).needsConfirm === true)
  check('★ 英文界面也认（submit / delete / pay）', ['submit', 'delete', 'checkout'].every((w) => G.judge({ tag: 'BUTTON', text: w, btnType: 'button' }).needsConfirm === true))
  check('★★ 普通按钮**不该**问（否则满屏确认卡 = 噪声不是保护）', G.judge({ tag: 'BUTTON', text: '看详情', btnType: 'button' }).needsConfirm === false)
  check('★★ 安全词优先（「取消」「返回」不拦）', G.judge({ tag: 'BUTTON', text: '取消', btnType: 'button' }).needsConfirm === false && G.judge({ tag: 'BUTTON', text: '返回上一页', btnType: 'button' }).needsConfirm === false)
  check('★ 普通链接不拦', G.judge({ tag: 'A', text: '详情', href: '/d' }).needsConfirm === false)
  /*
   * ★★ 这条是 m04d ⑪ 真机逮到的（我引入的缺陷）：`<button>` 不写 type 时 `el.type`
   *   读出来就是 `submit`，于是「在 POST 表单里的只读按钮」会被当成提交而弹卡。
   *   判据要用**显式否定的那一边**：作者写了 `type="button"` 就是「不是提交」。
   */
  check('★★ 显式 type=button 的按钮（即使在 POST 表单里）→ **不问**', G.judge({ tag: 'BUTTON', text: '看详情', btnType: 'button', formMethod: 'post' }).needsConfirm === false)
  check('★ 没写 type 的 button（读出来 submit）→ 仍按提交处理', G.judge({ tag: 'BUTTON', text: '确定', btnType: 'submit', formMethod: 'post' }).needsConfirm === true)
  check('★ 判定要给出**理由**（不写空话）', G.judge({ tag: 'BUTTON', text: '提交', btnType: 'button' }).reasons.length > 0)
  const card = G.describe({ tag: 'BUTTON', text: '提交订单', btnType: 'submit', formMethod: 'post', role: 'button' }, { url: 'http://x/', title: 'P' })
  check('★ 确认卡内容带页面 + 元素 + 后果', /http:\/\/x\//.test(card.impact.join(' ')) && /提交订单/.test(card.impact.join(' ')) && /不可撤销/.test(card.impact.join(' ')))
  check('★ 元素记录里采了 btnType / formMethod（判定靠它们）', /btnType:/.test(R('harbor-edge/extension/lib/observe.js')) && /formMethod:/.test(R('harbor-edge/extension/lib/observe.js')))

  /* ── ④ 渲染 ── */
  group('M04 剩余 · 渲染（拒绝 / 找不到 / 等待要说清楚）')
  check('★★ 敏感字段被拒 → 明写「页面没有被改动」', /页面没有被改动/.test(actionsSrc) && /一个字节都没有写进去/.test(actionsSrc))
  check('★ 拒绝那行要说「自己输入」', /你自己输入/.test(actionsSrc))
  check('★ 选项找不到 → 把可选值列出来（不然只能瞎猜）', /没找到这个选项/.test(actionsSrc) && /显示文本/.test(actionsSrc))
  check('★ 等待分「等到了」与「等不到」两种写法', /条件满足了/.test(actionsSrc) && /条件一直没满足/.test(actionsSrc))
  check('★ 等不到时明确说「不是报错，是还没/没有」', /不是报错/.test(actionsSrc))
  check('★ 渲染按 kind 转发（ext-observe 不再长大）', /kind === 'wait'/.test(obsSrc) && /renderWait/.test(actionsSrc))
  check('★ tabs 渲染标出「看不到 —— 没被授权」（如实，不编）', /看不到 —— 没被授权/.test(tabsMainSrc))

  /* ── ⑤ 接线 ── */
  group('M04 剩余 + M05 · 接线（少一处就是「点了没反应」）')
  check('★ ext-command 转调动作层', /createActions\(\{ call, getElements, landAction \}\)/.test(cmdSrc))
  check('★ ext-command 转调标签页层', /createTabs\(\{ call, landAction \}\)/.test(cmdSrc))
  check('★ 八个新动作都挂上了', /type: \(payload\)/.test(cmdSrc) && /navigate: \(payload\)/.test(cmdSrc) && /tabsList/.test(cmdSrc) && /tabsActivate/.test(cmdSrc))
  check('★★ 敏感确认由装配处注入（内核不 require handlers）', /confirm: require\('\.\/handlers\/ext-confirm\.cjs'\)/.test(regSrc))
  check('★★ 确认卡复用 chat-confirm.askUser（不另造一套）', /chatConfirm\.askUser\(/.test(confirmSrc) && /require\('\.\/chat-confirm\.cjs'\)/.test(confirmSrc))
  check('★★ 没接线时**保守拒绝**（fail-closed，不能绕闸）', /typeof confirm !== 'function'/.test(cmdSrc) && /P\.ERR\.DENIED/.test(cmdSrc))
  check('★ SW 把 5 个页面动作交给 act-run', /runPageAction/.test(cmdRunSrc) && /export async function runPageAction/.test(runSrc))
  check('★★ tabs 三件**不依赖前台标签**（放 resolveActiveTab 之前）', cmdRunSrc.indexOf("command === 'tabs-list'") < cmdRunSrc.indexOf('await resolveActiveTab()'))
  check('★ wait 复用 verifyPage 轮询（条件语义只一处）', /verifyPage/.test(runSrc) && /while \(Date.now\(\) - t0 < budget\)/.test(runSrc))
  check('★ navigate 用 chrome.tabs.update（不注入）', /chrome\.tabs\.update\(tabId, \{ url: want \}\)/.test(runSrc))
  check('★★ tabs.activate 的 id 必须在 list 里出现过（防编 id）', /not-in-list/.test(tabsSrc) && /const found = \(all\.tabs \|\| \[\]\)\.find/.test(tabsSrc))
  check('★ tabs.activate 是**回读确认**（不是「调用了就算成功」）', /回读确认/.test(tabsMainSrc))
  check('★ type 用原生 setter + 派发 input/change（不然 React 控件不更新）', /getOwnPropertyDescriptor\(proto, 'value'\)/.test(formSrc) && /new Event\('input'/.test(formSrc))
  check('★★ 敏感字段在**页面里**判、先拒（不靠主进程猜）', /inputType === 'password'/.test(formSrc) && /indexOf\('cc-'\) === 0/.test(formSrc))
  check('★ 拒绝时**不写任何字符**（在赋值之前返回）', formSrc.indexOf('sensitive-field') < formSrc.indexOf('nativeSet(el'))
  check('★ ops 的落盘仍走唯一那份 ingest', /ingestAction/.test(opsSrc))
}

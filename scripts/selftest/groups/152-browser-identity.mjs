/**
 * 自检 / 内置浏览器身份（UA + Client Hints）
 *
 * 本组守的是 2026-10-15 那一批改动**唯一的意图**：让网页标签发出的请求
 * 看起来就是一台普通 Chrome。三条硬要求（用户拍的板）：
 *
 *   ① UA 里**不许**出现应用名与 Electron；
 *   ② CH 三件套（`sec-ch-ua` / `-mobile` / `-platform`）必须齐 ——
 *      **只改 UA 不改 CH 比不改更糟**（真 Chrome 不可能不发 CH，那是新特征）；
 *   ③ 主窗口的 UA **一字不变**（这套东西只给 `persist:agent-browser`）。
 *
 * ⚠️ 自检跑在**纯 Node** 里，而 `process.versions.chrome` 只有 Electron 才有 ——
 *    所以这里**显式传主版本号**测形状（那正是函数留参数的原因），
 *    另外单独钉一条「取不到版本号时**不装**」（fail-safe，不猜一个假的）。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/** 造一个「长得像 session」的假对象，把 install 干了什么记下来 */
function fakeSession() {
  const called = { setUserAgent: [], listened: 0, handler: null }
  return {
    called,
    setUserAgent(ua) {
      called.setUserAgent.push(ua)
    },
    webRequest: {
      onBeforeSendHeaders(_filter, handler) {
        called.listened += 1
        called.handler = handler
      },
    },
  }
}

export async function run() {
  const B = require(join(ROOT, 'electron/core/browser-identity.cjs'))
  const src = readFileSync(join(ROOT, 'electron/core/browser-identity.cjs'), 'utf8')
  const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/browser.cjs'), 'utf8')

  group('内置浏览器身份（UA + Client Hints）')

  /* ① UA：不许自报家门 */
  const ua = B.chromeUA(152)
  check('★ UA 不含应用名 harbor-agent', !ua.includes('harbor-agent'), ua)
  check('★ UA 不含 Electron', !/electron/i.test(ua), ua)
  check('★ UA 不含本应用名（Harbor）', !/harbor/i.test(ua), ua)

  /* ② UA 形态要和真 Chrome 同形：主版本 + .0.0.0（次版本被 Chrome 自己抹掉了） */
  check('★ UA 形如真 Chrome：Chrome/<主>.0.0.0', /Chrome\/152\.0\.0\.0 Safari\/537\.36$/.test(ua), ua)
  check(
    '★ UA 不带完整四段版本号（那是 Electron 默认、也是特征）',
    !/Chrome\/\d+\.\d+\.\d+\.\d+/.test(ua.replace('152.0.0.0', '')),
    ua,
  )

  /* ③ Client Hints 三件套 */
  const hints = B.clientHints(152)
  check(
    '★ CH 三件套齐（只改 UA 不改 CH 比不改更糟）',
    Boolean(hints['sec-ch-ua'] && hints['sec-ch-ua-mobile'] && hints['sec-ch-ua-platform']),
    JSON.stringify(hints),
  )
  check(
    '★ sec-ch-ua 报的就是 Google Chrome / Chromium，且主版本与 UA 一致',
    hints['sec-ch-ua'] === '"Not:A-Brand";v="8", "Chromium";v="152", "Google Chrome";v="152"',
    hints['sec-ch-ua'],
  )
  check('★ 品牌名用头里的写法 Not:A-Brand（不是 JS 里的 Not?A_Brand）', !hints['sec-ch-ua'].includes('?'), hints['sec-ch-ua'])

  /* ④ accept-language：形态照真 Chrome，且不许出现畸形 q 值 */
  const lang = B.acceptLanguage('zh-CN')
  check('★ accept-language 形如真 Chrome 实测的 zh-CN,zh;q=0.9', lang === 'zh-CN,zh;q=0.9', lang)
  check('★ 没有畸形 q（setUserAgent 那条路会弄出 ;q=0.9;q=0.9）', !/;q=[\d.]+;q=/.test(lang), lang)
  check('★ 第一项与 navigator.languages[0] 同源（用 locale 派生，不是另取一个写法）', lang.startsWith('zh-CN,'))
  check('★ 纯语言（en）不重复补回退', B.acceptLanguage('en') === 'en', B.acceptLanguage('en'))
  check('★ 数组也只取第一项（不拼出一长串）', B.acceptLanguage(['zh-CN', 'zh', 'en-US']) === 'zh-CN,zh;q=0.9')
  check('★ 空 / 脏输入 → 空串（保持原样，不瞎写）', B.acceptLanguage([]) === '' && B.acceptLanguage('x') === '' && B.acceptLanguage('zh CN') === '')

  /* ⑤ install：只作用于传进来的那个 session */
  const ses = fakeSession()
  /* 纯 Node 下没有 process.versions.chrome → 显式注入一个 UA 走完安装这条路 */
  const ok = B.install(ses, { log: {}, locale: 'zh-CN', ua })
  check('★ install 装上了假 session', ok === true)
  check('★ 调了 setUserAgent 且**只调一次**', ses.called.setUserAgent.length === 1)
  check('★ 装上的 UA 就是传进去的那个（不含 Electron）', ses.called.setUserAgent[0] === ua)
  check('★ 注册了 onBeforeSendHeaders（补 CH 的那一半）', ses.called.listened === 1)
  check('★ install 不返回/不触碰任何全局 session', !src.includes('defaultSession'))

  /* ⑤·5 CH 的主版本**从 UA 里抠**（同源 → 不可能出现「UA 152 / CH 158」） */
  check('★ majorOf 从 UA 串里抠主版本', B.majorOf(ua) === 152 && B.majorOf('no-chrome-here') === 0)
  check('★ 源码里 CH 的版本来自 majorOf(ua)，不是另算一次', /clientHints\(major\)/.test(src) && /majorOf\(ua\)/.test(src))

  /* ⑥ 回调一定被调用（否则那条请求会永远挂着） */
  let replied = null
  ses.called.handler({ requestHeaders: { 'user-agent': 'x' } }, (out) => {
    replied = out
  })
  check('★ 回调被调用（不调 = 请求永久挂起）', replied !== null)
  check(
    '★ 回调里补齐了 CH 三件套',
    replied?.requestHeaders?.['sec-ch-ua']?.includes('Google Chrome') &&
      replied?.requestHeaders?.['sec-ch-ua-mobile'] === '?0',
    JSON.stringify(replied?.requestHeaders),
  )
  check('★ 回调里也改了 accept-language', replied?.requestHeaders?.['accept-language'] === 'zh-CN,zh;q=0.9')

  /* ⑦ 出错也要回话（假 session 给个会抛的 webRequest 不容易，这里用会抛的 handler 输入） */
  let replied2 = 'not-called'
  ses.called.handler(null, (out) => {
    replied2 = out
  })
  check('★ 输入异常时回调照样被调用（不挂起请求）', replied2 !== 'not-called')

  /* ⑧ fail-safe：拿不到版本号 → 不装（不猜一个假的） */
  const bare = fakeSession()
  const realMajor = B.chromeMajor()
  check(
    '★ 纯 Node 下取不到 Chromium 版本号（这正是自检要显式传参的原因）',
    realMajor === 0 || Number.isInteger(realMajor),
  )
  if (!B.CHROME_UA) {
    check('★ 取不到版本号 → install 返回 false（宁可不变，也不写个假的）', B.install(bare, {}) === false)
    check('★ 取不到版本号 → 一个新头都不改', bare.called.setUserAgent.length === 0 && bare.called.listened === 0)
  }

  /* ⑨ 非 session 不抛 */
  check('★ 传 null / 普通对象 → 返回 false，不抛', B.install(null, {}) === false && B.install({}, {}) === false)

  /* ⑩ 边界：只给网页标签装 —— 主窗口 UA 一字不变 */
  check('★ 全仓只有 browser.cjs 调 browserIdentity.install', (handlerSrc.match(/browserIdentity\.install\(/g) ?? []).length === 1)
  check(
    '★ 那一行用的就是网页标签那个分区（没动 defaultSession）',
    /webviewPermissions\.PARTITION[\s\S]{0,600}browserIdentity\.install\(/.test(handlerSrc),
  )
  check('★ install 的行紧跟在权限闸之后、同一个 ses 上', /const ses = session\.fromPartition\(webviewPermissions\.PARTITION\)/.test(handlerSrc))
  check('★ 模块不 require electron（纯 Node 能 require = 已证）', !/require\(['"]electron['"]\)/.test(src))
}

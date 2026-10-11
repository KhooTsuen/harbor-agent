/**
 * security:browser —— 浏览器 / CDP / 网络隔离（SEC-037 ~ 046）
 *
 * 本轮实现首批里的：040（SSRF：回环 / 内网 / 元数据地址不绕过网络策略）。
 * 037（CDP 非授权标签）需要真 Electron 实例才能落地，本轮如实标 NOT_RUN。
 */

import { sec, mark } from '../harness.mjs'
import { require, ROOT } from '../sandbox.mjs'
import { CASES } from '../cases.mjs'
import path from 'node:path'

const join = path.join

/** SEC-040：不可信 URL 不能绕过明确的网络策略（回环 / 内网 / 元数据） */
function ssrf(net) {
  const dec = (target, mode) => net.decide({ kind: 'webview', target, ctx: { mode } }).action
  const loopback = 'http://127.0.0.1:8080/admin'
  const privateIp = 'http://10.0.0.5/secret'
  const metadata = 'http://169.254.169.254/latest/meta-data/'

  /* deny 是「禁止就是禁止」：任何目标都不许 */
  sec('SEC-040', dec(loopback, 'deny') === 'deny', 'deny 档：回环被拒')
  sec('SEC-040', dec(privateIp, 'deny') === 'deny', 'deny 档：内网被拒')
  sec('SEC-040', dec(metadata, 'deny') === 'deny', 'deny 档：元数据地址被拒')

  /* ask 档：不静默放行（要么问、要么拒，绝不能是 allow） */
  sec('SEC-040', dec(loopback, 'ask') !== 'allow', 'ask 档：回环不静默放行')
  sec('SEC-040', dec(metadata, 'ask') !== 'allow', 'ask 档：元数据地址不静默放行')

  /* deny 名单命中优先级高于 allow 档 */
  const denied = net.decide({
    kind: 'webview',
    target: 'http://evil.example.com/x',
    ctx: { mode: 'allow', denyHosts: ['evil.example.com'] },
  }).action
  sec('SEC-040', denied === 'deny', '禁止名单优先级高于 allow 档')

  /*
   * SSRF 纵深：**即使在 allow 档**，云元数据地址（169.254.169.254）也不该被放行。
   * 这一条是「不可信 URL 不能绕过明确的网络策略」的加强版 ——
   * 若当前实现只按「用户开的档」放行，这里会红，如实记。
   */
  const metaAllow = dec(metadata, 'allow')
  sec('SEC-040', metaAllow !== 'allow', `allow 档下元数据地址仍被拦（实际 action=${metaAllow}）`)
}

export async function run() {
  const net = require(join(ROOT, 'electron/core/net-policy.cjs'))
  console.log('\n· SEC-040 SSRF（回环 / 内网 / 元数据）')
  try {
    ssrf(net)
  } catch (error) {
    sec('SEC-040', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }
  for (const c of CASES.filter((c) => c.suite === 'browser' && c.id !== 'SEC-040')) {
    mark(c.id, c.id === 'SEC-037' ? 'NOT_RUN' : 'NOT_RUN', '待实现（下一批；037 需真 Electron 实例）')
  }
}

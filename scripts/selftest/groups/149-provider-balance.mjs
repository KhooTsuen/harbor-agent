/**
 * 自检 / 账户余额（provider:balance）
 *
 * 症结：余额是个**账户级**信息，端点不在 `/v1` 下（供应商 baseUrl 是 `.../v1`），
 * 而且它是唯一一条「用户点一次 = 一次真实请求」的通道 —— 轮询就会持续产生请求。
 *
 * 要钉死的事实（每条都对应一次真实事故类型）：
 *   · **三处同步** —— EXPECTED_CHANNELS + preload.cjs + core 的 getBalance，
 *     少一处就是「点按钮没反应」，而且**不报错**（项目踩过：通道漏登记）；
 *   · **端点拼对** —— 用 origin 而不是 baseUrl（`.../v1/user/balance` 是 404）；
 *   · **不 Number()** —— 余额是字符串，转数字会在缺字段时变成 NaN；
 *   · **失败不抛** —— 网络不通 / Key 无效 / 接口变更，都回 `{ok:false,error}`；
 *   · **不轮询** —— 渲染层那两个文件里不许出现 setInterval / useEffect 自动调。
 */

import { check, group } from '../harness.mjs'
import { join, readFileSync, require, ROOT } from '../env.mjs'

const probe = require(join(ROOT, 'electron/core/llm-probe.cjs'))
const { EXPECTED_CHANNELS } = require(join(ROOT, 'electron/ipc-channels.cjs'))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('账户余额 / provider:balance')

  /* ── ① 三处同步：清单 + preload + core ── */
  check('★ 通道登记进 EXPECTED_CHANNELS', EXPECTED_CHANNELS.includes('provider:balance'))
  check('★ preload 暴露了 providerBalance', read('electron/preload.cjs').includes("call('provider:balance'"))
  check('★ core 导出了 getBalance', typeof probe.getBalance === 'function')
  check('★ llm.cjs 转发了 getBalance（handler 从它拿）', read('electron/core/llm.cjs').includes('getBalance: probe.getBalance'))
  check('★ handler 注册了 provider:balance', read('electron/handlers/provider.cjs').includes("ipcMain.handle('provider:balance'"))

  /* ── ② 端点拼法：取 origin，不是 baseUrl ── */
  const src = read('electron/core/llm-probe.cjs')
  check('★ 余额路径是 /user/balance', src.includes("'/user/balance'"))
  check(
    '★ 用 origin 拼（baseUrl 带 /v1，直接拼会 404）',
    src.includes('parsed.origin') && !src.includes('buildUrl(baseUrl, BALANCE_PATH)'),
  )

  /* ── ③ parseBalance：认不出 → null；不缺字段 → 空串（不是 undefined）── */
  const ok = probe.parseBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  })
  check('★ 正常响应解析出 available + infos', ok?.available === true && ok.infos.length === 1)
  check('★ 余额保持**字符串**（转数字会在缺字段时变 NaN）', typeof ok.infos[0].total === 'string')
  check('★ total 原样带出', ok.infos[0].total === '110.00')

  const missing = probe.parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY' }] })
  check('★ 字段缺失 → 空串（不是 undefined，界面才不会拼出 NaN）', missing.infos[0].total === '')

  check('★ 认不出的响应 → null（不硬凑一个全 null 的对象）', probe.parseBalance({ foo: 1 }) === null)
  check('★ null / 非对象 → null', probe.parseBalance(null) === null && probe.parseBalance('x') === null)

  /* ── ④ 失败不抛：三条路都回 {ok:false,error} ── */
  const noBase = await probe.getBalance({ baseUrl: '', apiKey: 'k' })
  check('★ 没填 baseUrl → ok:false，不抛', noBase.ok === false && Boolean(noBase.error))

  const noKey = await probe.getBalance({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '' })
  check('★ 没填 key → ok:false，不抛', noKey.ok === false && Boolean(noKey.error))

  const otherProvider = await probe.getBalance({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k' })
  check(
    '★ 非 DeepSeek 供应商 → 明说不支持（不发那个必然 404 的请求）',
    otherProvider.ok === false && otherProvider.error.includes('余额查询'),
    otherProvider.error,
  )

  const badUrl = await probe.getBalance({ baseUrl: 'not-a-url', apiKey: 'k' })
  check('★ 非法 URL → ok:false，不抛', badUrl.ok === false)

  /* ── ⑤ 不轮询：渲染层不许自动调 ── */
  const card = read('src/components/settings/parts/BalanceCard.tsx')
  check('★ 余额卡片里没有定时器（只由点击触发）', !card.includes('setInterval') && !card.includes('setTimeout'))
  check(
    '★ 余额卡片没有 useEffect **调用**（不会自动请求）',
    !/\buseEffect\s*\(/.test(card) && !/import\s*\{[^}]*\buseEffect\b/.test(card),
  )
  check(
    '★ 查询是由 onClick 触发的',
    /onClick=\{\(\) => void query\(\)\}/.test(card),
  )
}

import { check, group } from '../harness.mjs'
import { ROOT, join, readFileSync, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   浏览器：`browse_nav`（AI 用浏览器历史后退 / 前进）

   从 `09-browser.mjs` 拆出来的（那边过 300 行了，硬约束 #2）。
   这里全是「不用开浏览器、也不用联网」的检查：工具的参数校验 +
   几条**源码级守卫** —— 那些线（只用历史、防注入文案只有一份、
   渲染层真的认这个动作）删掉了不能还是全绿。

   为什么后两条要在自检里守：它们违反时的表现都是**静默**的 ——
   文案漂了没有人报错，渲染层不认这个动作则会让主进程白等 45 秒。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('浏览器 / browse_nav 工具')

  const nav = require(join(ROOT, 'electron/core/tools/browse-nav.cjs'))
  check('工具注册名是 browse_nav', nav.name === 'browse_nav')
  check('★ 归到写操作里（会换页面、占着用户的浏览器标签）', nav.network === true)
  check('参数只要求 direction', JSON.stringify(nav.parameters.required) === '["direction"]')
  check(
    '★ 只认 back / forward（不给模型自己拼地址的余地）',
    JSON.stringify(nav.parameters.properties.direction.enum) === '["back","forward"]',
  )

  let badDir = null
  try {
    await nav.run({ direction: 'left' })
  } catch (error) {
    badDir = error
  }
  check('拒绝非法方向', badDir !== null, String(badDir?.message))

  let noDir = null
  try {
    await nav.run({})
  } catch (error) {
    noDir = error
  }
  check('没给 direction 也拦下', noDir !== null, String(noDir?.message))

  /*
   * ★ 它是「用浏览器的历史」，不是「模型自己导航」。
   *   一旦有人在里面调 loadURL，这个工具就变成了「模型能去任意地址」的旁路 ——
   *   那件事只能由 browse 做（它还带着网络策略与地址校验）。
   */
  const navSrc = readFileSync(join(ROOT, 'electron/core/tools/browse-nav.cjs'), 'utf8')
  check('★ 不自己导航（源码里没有 loadURL）', !/loadURL/.test(navSrc))
  check('★ 走的是 browser.request("nav")', /request\(\s*'nav'/.test(navSrc))

  /* ★ 防注入文案只有一份：两处各写一遍，改了这边忘了那边 = 留一扇没上锁的门 */
  const browseSrc = readFileSync(join(ROOT, 'electron/core/tools/browse.cjs'), 'utf8')
  check(
    '★ 正文包装共用一份（browse / browse_nav 都走 _web-note）',
    /wrapWebText/.test(browseSrc) && /wrapWebText/.test(navSrc),
  )

  group('浏览器 / browse_nav 的渲染层接线')

  /*
   * 光有工具、渲染层不认这个动作的话，请求会被**静默丢掉**：
   * AI 等到 45 秒超时，用户什么也看不到（这类错最难查）。
   */
  const driverSrc = readFileSync(
    join(ROOT, 'src/components/layout/browser/useBrowseDriver.ts'),
    'utf8',
  )
  check('★ 驱动层认识 nav 动作', /action === 'nav'/.test(driverSrc))
  check(
    '★ nav 先问「能不能退」再动手（goBack 在没历史时是空操作，会回假成功）',
    /navStateOf\(view\)/.test(driverSrc),
  )

  const storeSrc = readFileSync(join(ROOT, 'src/stores/useBrowserStore.ts'), 'utf8')
  check('★ nav 归到「不开新标签」那一类', /request\.action === 'nav'/.test(storeSrc))

  const bridgeSrc = readFileSync(
    join(ROOT, 'src/components/layout/browser/useBrowseBridge.ts'),
    'utf8',
  )
  check('★ 桥把方向一路带下去', /direction: req\.direction/.test(bridgeSrc))
}

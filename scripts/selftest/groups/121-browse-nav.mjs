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

  group('浏览器 / browse_nav 的接线（B4：换历史搬到主进程）')

  /*
   * 光有工具、主进程不认这个动作的话，请求会被**静默丢掉**：
   * AI 等到 45 秒超时，用户什么也看不到（这类错最难查）。
   * B4 之后 nav 由**主进程**经 CDP 做（`core/browse-history.cjs`）；B5 之后
   * 主进程经 `core/browse-act.cjs` 直连，渲染层只推 webContentsId。
   */
  const driverSrc = readFileSync(
    join(ROOT, 'src/components/layout/browser/useBrowseDriver.ts'),
    'utf8',
  )
  check('★ 驱动层不再自己挪历史（nav 交主进程）', !/stepHistory|goInView/.test(driverSrc))

  const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/browser.cjs'), 'utf8')
  const actSrc = readFileSync(join(ROOT, 'electron/core/browse-act.cjs'), 'utf8')
  check(
    '★ 主进程认领 nav：handler 交 browse-act，那边处理 nav',
    /action === 'navigate' \? navigateRequest/.test(handlerSrc) && /action === 'nav'/.test(actSrc),
  )

  const storeSrc = readFileSync(join(ROOT, 'src/stores/useBrowserStore.ts'), 'utf8')
  check(
    '★ B5：操作类动作不再进 store（只有 navigate 走 requestBrowse）',
    !/request\.action === 'nav'/.test(storeSrc) && storeSrc.includes('selectAgentTab'),
  )

  const bridgeSrc = readFileSync(
    join(ROOT, 'src/components/layout/browser/useBrowseBridge.ts'),
    'utf8',
  )
  check(
    '★ 方向一路带到主进程动作层（工具发 direction、browse-act 读 payload.direction）',
    /direction/.test(navSrc) && /payload\.direction/.test(actSrc),
  )

  /* ══════════════════════════════════════════════════════════════
     `sameTab`：Agent 自己决定「开新标签」还是「在当前标签里打开」（2026-10-07）

     在这之前工具只有 browse（必然开新标签）和 browse_nav（只能挪历史）——
     提示词里那句「中转页在当前标签里走完」是**空头支票**，模型只能堆标签。
     这一组钉的是**字段名的形状对齐**（AGENT.md #9）：工具写出去的键、
     事件类型里的键、桥透传的键、store 读的键，四处必须是同一个名字；
     行为本身（不重建 webview、不碰用户标签）由单测
     `src/stores/__tests__/browserTabPolicy.test.ts` 验。
     ══════════════════════════════════════════════════════════════ */
  group('浏览器 / sameTab 的形状对齐')

  const browseSrc2 = readFileSync(join(ROOT, 'electron/core/tools/browse.cjs'), 'utf8')
  check('★ 工具声明了 sameTab 参数（boolean）', /sameTab:\s*\{[\s\S]{0,200}?'boolean'/.test(browseSrc2))
  check('★ 工具把 sameTab 发给了 handler', /sameTab:\s*args\?\.sameTab === true/.test(browseSrc2))

  const typesSrc = readFileSync(join(ROOT, 'src/types/browser.ts'), 'utf8')
  check('★ 事件类型里有 sameTab', /sameTab\?:\s*boolean/.test(typesSrc))
  check('★ 桥透传的是 req.sameTab（不另起名字）', /sameTab:\s*req\.sameTab === true/.test(bridgeSrc))

  /* storeSrc / bridgeSrc 在上面那两组已经读过了（同一个文件，别重复声明） */
  check('★ store 读的是 request.sameTab（还是同一个名字）', /if \(request\.sameTab\)/.test(storeSrc))

  const tabsSrc = readFileSync(join(ROOT, 'src/stores/browserTabs.ts'), 'utf8')
  check('★ owner 真的被读了（agentTabOf —— 以前是个死字段）', /owner === 'agent'/.test(tabsSrc))
  check(
    '★ Agent 的操作按 agentTabOf 挑标签（不落在用户自己开的标签上）',
    /agentTabOf\(state\.tabs, sid, state\.activeId\)/.test(storeSrc),
  )
}

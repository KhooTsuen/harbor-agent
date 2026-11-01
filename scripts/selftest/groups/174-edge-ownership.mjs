/**
 * 自检 / Edge 扩展：**会话归属 + 站点黑名单 + 去重 + 真侧栏**
 *
 *   ① **归属**：侧边栏选 A、主窗口开 B 时「读当前页」必须落 A（串线根因是
 *      `ingest` 只认 `getActiveSession`）；**明确指定但已失效则拒绝**，不许回退。
 *   ② **站点黑名单**：拉黑的站点读不了也点不动；**核实不了策略时一律拒绝**
 *      （fail-closed —— `activeTab` 会持续，Harbor 关掉后扩展仍读得到页面）。
 *   ③ **去重**：动作 + 目标 + 载荷 2 秒内只执行一次；载荷不同的操作不算重复，
 *      失败后可立刻重试，标签页操作同样覆盖。
 *   ④ **真侧栏**：验收必须走「开页面 → 点侧栏入口」，不许新开扩展页冒充。
 *
 * ⚠️ 判据用「读源码钉接线 + 真跑纯模块」，不起真 Edge（真机那一段另在
 *   `harbor-edge/tools/accept-*.cjs`）。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

export async function run() {
  const route = require(join(ROOT, 'electron/core/ext-route.cjs'))

  /* ══════════════════════════════════════════════════════════════
     ① 会话归属：侧边栏选的那条才是归属
     ══════════════════════════════════════════════════════════════ */
  group('Edge 归属 · 侧边栏选中优先于主窗口（串线的根因）')

  const alive = (id) => ['sess_a', 'sess_b'].includes(id)
  const decide = (inp) => route.decideSessionId({ ...inp, alive })

  check(
    '★★★ 侧边栏选 A、主窗口开 B → 落 A（不是 B）',
    decide({ selected: 'sess_a', active: 'sess_b' }).sessionId === 'sess_a',
    JSON.stringify(decide({ selected: 'sess_a', active: 'sess_b' })),
  )
  check(
    '★★★ 扩展明确指定 A（即使侧边栏选了 B）→ 落 A',
    decide({ explicit: 'sess_a', selected: 'sess_b', active: 'sess_b' }).sessionId === 'sess_a',
  )
  check(
    '★★ 侧边栏没选 → 退回主窗口那条（老行为：不制造多余会话）',
    decide({ selected: '', active: 'sess_b' }).sessionId === 'sess_b',
  )
  check(
    '★★ 侧边栏选的会话已不存在 → 退回主窗口那条（不抛、不瞎新建）',
    decide({ selected: 'sess_gone', active: 'sess_b' }).sessionId === 'sess_b',
  )
  check('★★ 都不活 → 空 id（由调用方新建专用会话）', decide({ selected: 'sess_x', active: 'sess_y' }).sessionId === '')
  check('★ 全空 → 空 id', decide({}).sessionId === '')

  /* 接线：ingest 必须真的用这个判定，而不是退回 getActiveSession */
  const opsSrc = R('electron/core/ext-ops.cjs')
  check('★★★ ext-ops 的 ingest 用了 decideSessionId（不是只认 getActiveSession）', /decideSessionId\s*\(/.test(opsSrc))
  check(
    '★★★ ingest 同时传了 selected 与 active（少一个就退回串线）',
    /selected:\s*getSelectedSession\(\)/.test(opsSrc) && /active:\s*getActiveSession\(\)/.test(opsSrc),
  )
  check(
    '★★★ 三条上行链路都带上了 payload.sessionId',
    (opsSrc.match(/payload\?\.sessionId/g) ?? []).length >= 3,
    `实际 ${(opsSrc.match(/payload\?\.sessionId/g) ?? []).length} 处`,
  )

  const bridgeSrc = R('electron/core/ext-bridge.cjs')
  check(
    '★★★ 桥装配时把「侧边栏选中」注进去了（否则 getSelectedSession 恒为空）',
    /getSelectedSession:\s*\(\)\s*=>\s*String\(deps\.chat\?\.selectedOf/.test(bridgeSrc),
  )

  /*
   * ★★★ 行为判据（比上面那条接线判据强得多）：
   *   真造一个 createOps，喂假 session，让 getActiveSession=B、getSelectedSession=A，
   *   然后看 ext:page 那条实际 append 到哪条会话。只钉接线的话，有人把
   *   `selected: getSelectedSession()` 改成 `selected: ''` 时判据会红 —— 但换成
   *   「传了却没用」这类改法就漏了。这里直接看落到哪个 id。
   */
  const { createOps } = require(join(ROOT, 'electron/core/ext-ops.cjs'))
  const appendedTo = []
  const ops = createOps({
    session: {
      list: () => [],
      load: (id) => ({ meta: ['sess_a', 'sess_b'].includes(id) ? { id } : null }),
      create: () => ({ id: 'sess_new' }),
      append: (id) => {
        appendedTo.push(id)
        return { ok: true }
      },
    },
    audit: { record: () => {} },
    wrap: (x) => String(x.text ?? ''),
    send: () => {},
    getActiveSession: () => 'sess_b',
    getSelectedSession: () => 'sess_a',
  })
  ops.handle('ext:page', { url: 'https://x.test', title: 't', text: 'hello' })
  check(
    '★★★ 真跑 ingest：主窗口开 B、侧边栏选 A → 内容 append 到 A',
    appendedTo.length === 1 && appendedTo[0] === 'sess_a',
    `实际落进 ${appendedTo.join(',') || '(无)'}`,
  )

  appendedTo.length = 0
  ops.handle('ext:page', { url: 'https://x.test', title: 't', text: 'hi', sessionId: 'sess_b' })
  check('★★★ 真跑 ingest：扩展明确指定 B → 落 B（explicit 优先）', appendedTo[0] === 'sess_b', `实际 ${appendedTo[0]}`)

  const opsNoSel = createOps({
    session: {
      list: () => [],
      load: (id) => ({ meta: id === 'sess_b' ? { id } : null }),
      create: () => ({ id: 'sess_new' }),
      append: (id) => {
        appendedTo.push(id)
        return { ok: true }
      },
    },
    audit: { record: () => {} },
    wrap: (x) => String(x.text ?? ''),
    send: () => {},
    getActiveSession: () => 'sess_b',
  })
  appendedTo.length = 0
  opsNoSel.handle('ext:page', { url: 'https://x.test', title: 't', text: 'hi' })
  check('★★ 真跑 ingest：侧边栏没选 → 退回主窗口那条（老行为不变）', appendedTo[0] === 'sess_b', `实际 ${appendedTo[0]}`)

  /*
   * ★★★ 修正③：明确指定但会话已失效 → **拒绝写入**，不许回退。
   *    回退是一种「换个条件再串一次线」：侧边栏选着 A、A 被删了、主窗口开着 B，
   *    以前内容会静默落进 B —— 用户以为落进了 A。
   */
  appendedTo.length = 0
  const goneRes = ops.handle('ext:page', { url: 'https://x.test', title: 't', text: 'hi', sessionId: 'sess_deleted' })
  check('★★★ 明确指定但已失效 → 一个字都不写', appendedTo.length === 0, `实际写了 ${appendedTo.join(',') || '(无)'}`)
  check('★★★ 明确指定但已失效 → 回 ok:false + 人话让用户重选', goneRes && goneRes.ok === false && /已经不在|重新选/.test(String(goneRes.error && goneRes.error.message)), JSON.stringify(goneRes && goneRes.error))
  appendedTo.length = 0
  const goneObs = ops.handle('page:observe', { observation: { url: 'https://x.test', title: 't', pageVersion: 'v1', elements: [], stats: { elements: 0 } }, sessionId: 'sess_deleted' })
  check('★★ 观察页面那条路同样拒绝（三条链路口径一致）', appendedTo.length === 0 && goneObs && goneObs.ok === false)
  appendedTo.length = 0
  ops.handle('ext:page', { url: 'https://x.test', title: 't', text: 'hi', sessionId: 'sess_b' })
  check('★★ 明确指定且活着 → 照常写（别把正常请求也拒了）', appendedTo[0] === 'sess_b')

  /* 扩展侧：面板按钮必须把 sessionId 传下去，否则主进程只能靠猜 */
  const chatSrc = R('harbor-edge/src/sidepanel/ChatPanel.tsx')
  check('★★ 读当前页按钮带 sessionId', /<ReadPageButton[^>]*sessionId=\{sessionId\}/.test(chatSrc))
  check('★★ 观察页面按钮带 sessionId', /<ObserveButton[^>]*sessionId=\{sessionId\}/.test(chatSrc))
  const swSrc = R('harbor-edge/extension/service-worker.js')
  /*
   * ★ 2026-10-21：读当前页改送 `page-context`（写上下文槽，不落会话）。
   *   但「必须带 sessionId」这条判据不变 —— 不带的话主进程只能靠猜，
   *   侧边栏选 A、主窗口开 B 时还是会串（用户 2026-10-20 报过的那条）。
   */
  check('★★ page-context 请求里带了 sessionId', /requestHost\('page-context',\s*\{[^}]*sessionId/.test(swSrc))
  const hostSrc = R('electron/core/ext-host-loop.cjs')
  check(
    '★★★ host 转发 observe-page / get-elements 时保留了 sessionId',
    /'observe-page':\s*\[[^\]]*sessionId/.test(hostSrc) && /ask\s*=\s*\{[^}]*sessionId/.test(hostSrc),
  )

  /* ══════════════════════════════════════════════════════════════
     ② 真侧栏（2026-10-20 用户逮到的错：拿「新开扩展页」冒充侧边栏）
     ⚠️ 站点策略与去重在 `175-edge-sites-dedupe.mjs`（本文件只管归属 + 验收口径）
     ══════════════════════════════════════════════════════════════ */
  group('Edge 真机验收 · 必须走真侧栏，不许新开扩展页冒充')

  /*
   * 这一组钉的是**验收脚本本身**的口径，不是产品行为。
   *
   * 用户原话：「测试应该先打开一个页面，然后在『插件』功能里点击侧栏插件，
   * 不是让你新开一个插件页面」。在那之前 14 个 accept 脚本全都用
   * `/json/new?chrome-extension://<id>/index.html` 冒充侧栏 —— 那不是用户
   * 看到的东西（真侧栏不占标签位、不在 chrome.tabs 里），验出来的绿没有意义。
   */
  const panelLib = R('harbor-edge/lib/ext-panel.cjs')
  check(
    '★★★ 有「开真侧栏」的共用实现（sidePanel.open + 真实鼠标事件）',
    /chrome\.sidePanel\.open/.test(panelLib) && /Input\.dispatchMouseEvent/.test(panelLib),
  )
  check(
    '★★★ 不靠 URL 认侧栏（标记 + 逐 target 求值）',
    /__harborTrigger/.test(panelLib) && /mark:\s*window\.\$\{MARK\}/.test(panelLib),
  )
  check(
    '★★ 记录「Runtime.evaluate 的 userGesture 骗不过 sidePanel.open」这一事实',
    /userGesture[\s\S]{0,200}(骗不过|may only be called)/.test(panelLib),
  )

  const ownAccept = R('harbor-edge/tools/accept-ownership.cjs')
  check('★★★ 归属验收走真侧栏（用 openRealSidePanel）', /openRealSidePanel\(/.test(ownAccept))
  check(
    '★★★ 归属验收**没有**用「新开扩展页」当侧栏',
    /*
     * ★ 2026-10-20 修：原来写 `/json\/new\?[^`]*index\.html/` —— 一遇模板字符串里
     *   那个反引号就断掉，于是「把真侧栏换回新开扩展页」时它**不变红**（假判据）。
     *   改成允许跨任意字符（含反引号 / 换行），并限制在 300 字符内避免误伤远处的代码。
     */
    !/json\/new\?[\s\S]{0,300}?index\.html/.test(ownAccept),
  )
  check('★★ 触发页收尾有复核（看 remaining，不看 closed）', /remaining === 0/.test(ownAccept))

  const permLib = R('harbor-edge/lib/ext-stage-perms.cjs')
  check(
    '★★ 测试副本加 host_permissions 是**独立一处**（不再 6 个脚本各写一遍）',
    /LOOPBACK_HOST_PERMS/.test(permLib) && /productManifestUntouched/.test(permLib),
  )
  check(
    '★★★ 复核「产品 manifest 未被改动」也在同一处（不是各脚本自己声明带权限）',
    /productUntouched/.test(permLib),
  )
}

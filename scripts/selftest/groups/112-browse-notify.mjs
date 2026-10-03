import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   收尾第一步（小尾巴 #8）：Agent 在动网页，而你没在看 → 说一声

   为什么单开一组（而不是并进 32-notify.mjs）：那边正贴着 300 行上限
   （硬约束 #2），而且这是**另一件事** —— 同一套通知机制，但：
     · 触发时机不同（任务收尾 / 一张卡 vs. 每一次浏览请求）
     · 去重粒度不同（32 组按任务、111 组按卡片，这里按**会话**）
     · 分流不同（点通知去浏览器标签，不是任务中心也不是卡片）

   盯四件事：
     ① 四种动作各说一句人话，地址带上
     ② 什么时候发：不在前台才发 / **一条对话只发一次** / 前台不发
     ③ 点通知：带上会话 id 和 kind=browse
     ④ 接线：装配线接了、唯一漏斗 request() 真的会调、四个工具真传了 sessionId、
        渲染层按 kind 分流到了浏览器标签
   ══════════════════════════════════════════════════════════════ */

const browseNotify = require(join(ROOT, 'electron/handlers/browse-notify.cjs'))
const notifierModule = require(join(ROOT, 'electron/handlers/notify.cjs'))

/** 假 Notification：记录弹了什么，点击回调留着测试触发（和前两组同款） */
function fakeNotification() {
  const shown = []
  class FakeNotification {
    static isSupported() {
      return true
    }
    constructor(options) {
      this.options = options
    }
    on(event, cb) {
      if (event === 'click') this.clickHandler = cb
    }
    show() {
      shown.push(this)
    }
  }
  return { FakeNotification, shown }
}

function fakeWindow({ visible = true, focused = true, minimized = false } = {}) {
  const sent = []
  return {
    sent,
    win: {
      isVisible: () => visible,
      isFocused: () => focused,
      isMinimized: () => minimized,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    },
  }
}

function notifierFor(win, shown) {
  return notifierModule.createTaskNotifier({
    Notification: shown.FakeNotification,
    app: {},
    showWindow: () => {},
    getMainWindow: () => win,
  })
}

export async function run() {
  group('Agent 动网页 / 文案')
  const nav = browseNotify.browseNotice('navigate', 'https://example.com/a')
  check('打开网页时说清是「打开网页」', nav.title.includes('打开网页'), nav.title)
  check('地址带上 —— 用户要一眼看出在读哪个页面', nav.body.includes('https://example.com/a'), nav.body)

  for (const action of ['snapshot', 'click', 'type']) {
    const notice = browseNotify.browseNotice(action, '')
    check(
      `${action} 有一句人话（不是把动作名甩给用户）`,
      notice.title.length > 0 && !notice.title.includes(action),
      notice.title,
    )
  }
  check(
    '不认识的动作用「不弹」兜底，而不是弹一条空标题',
    browseNotify.browseNotice('launch-missile', '').title.length > 0 &&
      browseNotify.ACTION_TEXT['launch-missile'] === undefined,
  )
  check('超长地址会被裁（通知正文放不下）', browseNotify.browseNotice('navigate', 'x'.repeat(500)).body.length <= 200)

  group('Agent 动网页 / 什么时候发')
  const copy = browseNotify.browseNotice('click', '')

  /* 窗口不在前台：发；点开要知道「跳哪条对话 + 这是浏览类」 */
  const hidden = fakeWindow({ visible: false, focused: false })
  const hiddenShown = fakeNotification()
  const hiddenNotifier = notifierFor(hidden.win, hiddenShown)
  const sentOne = hiddenNotifier.notifyBrowse({ id: 'sess-browse', key: 'sess-browse', ...copy })
  check(
    '★ 窗口不在前台 → 发系统通知',
    sentOne.ok === true && hiddenShown.shown.length === 1,
    JSON.stringify(sentOne),
  )
  hiddenShown.shown[0]?.clickHandler?.()
  check(
    '★ 点通知 → 带上会话 id 和 kind=browse（渲染层据此跳对话 + 落到浏览器标签）',
    hidden.sent.some(
      (m) =>
        m.channel === 'app:notificationClick' &&
        m.payload.id === 'sess-browse' &&
        m.payload.kind === 'browse',
    ),
    JSON.stringify(hidden.sent.map((m) => m.payload)),
  )

  /*
   * ★ 去重粒度是**会话**，不是「一次请求」。
   *   一个任务里 browse 十几次是常态（读元素 → 点 → 打字 → 再读……），
   *   每次都弹会进 Windows 通知中心堆成一串，用户只能把通知整个关掉。
   */
  const again = hiddenNotifier.notifyBrowse({ id: 'sess-browse', key: 'sess-browse', ...copy })
  check(
    '★ 同一条对话只发一次（browse 十几次 = 一条通知）',
    again.ok === false && hiddenShown.shown.length === 1,
    JSON.stringify(again),
  )
  hiddenNotifier.notifyBrowse({ id: 'sess-other', key: 'sess-other', ...copy })
  check('换一条对话照发（去重按会话，不是全局只发一条）', hiddenShown.shown.length === 2)

  /* 前台：一条都不发 —— 界面已有 toast 和面板切换，再弹就是打扰 */
  const front = fakeWindow({ visible: true, focused: true })
  const frontShown = fakeNotification()
  const frontResult = notifierFor(front.win, frontShown).notifyBrowse({
    id: 'sess-front',
    key: 'sess-front',
    ...copy,
  })
  check(
    '★ 窗口在前台 → 不发（不打扰）',
    frontShown.shown.length === 0 && frontResult.ok === false,
    JSON.stringify(frontResult),
  )

  /* 最小化：Windows 上 isVisible / isFocused 可能还说「正常」，得显式判 */
  const min = fakeWindow({ visible: true, focused: true, minimized: true })
  const minShown = fakeNotification()
  notifierFor(min.win, minShown).notifyBrowse({ id: 'sess-min', key: 'sess-min', ...copy })
  check('★ 最小化 → 也算不在前台（发）', minShown.shown.length === 1)

  group('Agent 动网页 / 接线')
  check('browse-notify 提供 setNotifier（装配线接得进来）', typeof browseNotify.setNotifier === 'function')
  check(
    '★ 装配线把通知器接给了 browse-notify（不是建了不用）',
    /browse-notify\.cjs'\)\s*\.setNotifier\(notifier\)/.test(
      readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8'),
    ),
  )

  /*
   * ★ 调用点放在 browser.cjs 的 request()：navigate / snapshot / click / type
   *   四路**都过这一个漏斗**。挂在四个 core/tools/browse*.cjs 里写四遍，
   *   迟早漏一个 —— 而漏掉的那个会**静默地什么都不提示**。
   */
  const browserSrc = readFileSync(join(ROOT, 'electron/handlers/browser.cjs'), 'utf8')
  check(
    '★ 唯一漏斗 request() 里真的会去说一声',
    /browse-notify\.cjs'\)\.tellUser\(/.test(browserSrc),
    'browser.cjs 里找不到 tellUser 调用',
  )
  check(
    '★ 说的时候把 sessionId 带上（通知去重键 + 点通知跳转都要它）',
    /sessionId: String\(payload\?\.sessionId/.test(browserSrc),
  )

  /* 四个工具得把 ctx.sessionId 放进 payload，否则上面那行永远是空串 */
  const tools = {
    browse: "electron/core/tools/browse.cjs",
    elements: 'electron/core/tools/browse-elements.cjs',
    click: 'electron/core/tools/browse-click.cjs',
    type: 'electron/core/tools/browse-type.cjs',
  }
  for (const [name, rel] of Object.entries(tools)) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    check(`${name} 工具把 sessionId 传下去了`, /sessionId: ctx\??\.sessionId/.test(src))
  }

  /* 渲染层：不报错、给提示、点通知落到浏览器标签 */
  const bridgeSrc = readFileSync(join(ROOT, 'src/components/layout/browser/useBrowseBridge.ts'), 'utf8')
  check(
    '★ 每个浏览请求都会点角标（不只是 navigate）',
    /isBrowseAction\(req\.action\)[\s\S]{0,200}markAgentActivity\(/.test(bridgeSrc),
  )
  check(
    '★ 提示走那条去重过的判断（不是每步弹一条）',
    /browseNotice\(\s*lastNoticeRef\.current/.test(bridgeSrc),
    'useBrowseBridge 里没看到去重调用',
  )
  const notifyHookSrc = readFileSync(join(ROOT, 'src/hooks/useTaskNotifications.ts'), 'utf8')
  check(
    '★ 点浏览通知分流到单独那条路（不落到「任务结果」）',
    /kind === 'browse'\s*\)\s*openBrowserWork\(/.test(notifyHookSrc),
    '没有 kind=browse 的分流',
  )
  check(
    '★ 那条路真的把右栏落到浏览器标签',
    /function openBrowserWork[\s\S]{0,400}setActiveRightTab\('browser'\)/.test(notifyHookSrc),
    'openBrowserWork 没切到浏览器标签',
  )
  check(
    '★ 角标表在 store 里（要在标签栏订阅，不能在组件里 useState）',
    /markAgentActivity: \(\) => set\(/.test(readFileSync(join(ROOT, 'src/stores/useBrowserStore.ts'), 'utf8')),
  )
}

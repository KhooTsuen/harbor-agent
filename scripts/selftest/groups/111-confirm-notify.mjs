import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   P1-3（2026-10-03 用户报的）：需要用户确认时也要走系统通知

   原来 AG-029 的通知只覆盖「任务完成 / 失败」—— 用户切到别的窗口之后，
   澄清卡 / 权限确认弹出来他根本不知道，任务就一直挂在卡上等。

   为什么从 32-notify.mjs 拆出来：那边本来就有 300 行上限的压力（硬约束 #2），
   而这一条是**另一件事**（同一套通知机制，但触发时机、文案、点击分流都不同），
   挤在一起只会两边都读不清。

   盯四件事：
     ① 文案：标题固定 + 正文带上「在问什么」
     ② 什么时候发：不在前台才发 / 同一张卡只发一次 / 前台不发
     ③ 点通知：带上会话 id 和 kind=confirm（渲染层据此跳对话 + 亮卡片）
     ④ 接线：装配线真接了通知器、两条卡片路径真会调、渲染层按 kind 分流
   ══════════════════════════════════════════════════════════════ */

const confirmNotice = require(join(ROOT, 'electron/core/confirm-notice.cjs'))
const confirmNotify = require(join(ROOT, 'electron/handlers/confirm-notify.cjs'))
const notifierModule = require(join(ROOT, 'electron/handlers/notify.cjs'))

/** 假 Notification：记录弹了什么，点击回调留着测试触发（和 32 组同款） */
function fakeNotification({ supported = true } = {}) {
  const shown = []
  class FakeNotification {
    static isSupported() {
      return supported
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
  group('需要你确认 / 文案')
  const oneAsk = confirmNotice.confirmNotice(
    confirmNotice.clarifyAsk([{ question: '白板用哪种坐标系？' }]),
  )
  check('标题就是「Harbor 需要你确认」', oneAsk.title === 'Harbor 需要你确认', oneAsk.title)
  check('正文带上「在问什么」', oneAsk.body.includes('白板用哪种坐标系？'), oneAsk.body)

  const manyAsk = confirmNotice.confirmNotice(
    confirmNotice.clarifyAsk([{ question: '一？' }, { question: '二？' }, { question: '三？' }]),
  )
  check(
    '问题不止一个时说清「共 N 个」（不然用户以为答完一个就完了）',
    manyAsk.body.includes('共 3 个问题'),
    manyAsk.body,
  )
  check(
    '问题文本缺失时也有话说（不弹一条空通知）',
    confirmNotice.clarifyAsk([]).includes('开工前'),
    confirmNotice.clarifyAsk([]),
  )

  check(
    '权限那条用内核自己写的人话摘要（不另起一份工具名词表）',
    confirmNotice.permissionAsk({
      summary: '删掉 3 个临时文件\n不会碰别的',
      toolName: 'run_shell',
    }) === '删掉 3 个临时文件',
  )
  check(
    '没有摘要时兜底也要说清是哪个工具',
    confirmNotice.permissionAsk({ toolName: 'run_shell' }).includes('run_shell'),
  )
  check(
    '超长文案会被裁（通知正文放不下）',
    confirmNotice.confirmNotice('x'.repeat(500)).body.length <= confirmNotice.MAX_ASK_CHARS,
  )

  group('需要你确认 / 什么时候发')
  const askCopy = { title: 'Harbor 需要你确认', body: '开工前想问：白板用哪种坐标系？' }

  /* 窗口不在前台：发。而且点开要知道「跳哪条对话 + 这是确认类」 */
  const hidden = fakeWindow({ visible: false, focused: false })
  const hiddenShown = fakeNotification()
  const hiddenNotifier = notifierFor(hidden.win, hiddenShown)
  const sentOne = hiddenNotifier.notifyConfirm({ id: 'sess-p13', key: 'clr_1', ...askCopy })
  check(
    '★ 窗口不在前台 → 发系统通知',
    sentOne.ok === true && hiddenShown.shown.length === 1,
    JSON.stringify(sentOne),
  )
  check(
    '通知内容 = 文案',
    hiddenShown.shown[0]?.options?.title === askCopy.title &&
      hiddenShown.shown[0]?.options?.body === askCopy.body,
  )
  hiddenShown.shown[0]?.clickHandler?.()
  check(
    '★ 点通知 → 带上会话 id 和 kind=confirm（渲染层据此跳对话 + 亮卡片）',
    hidden.sent.some(
      (m) =>
        m.channel === 'app:notificationClick' &&
        m.payload.id === 'sess-p13' &&
        m.payload.kind === 'confirm',
    ),
    JSON.stringify(hidden.sent.map((m) => m.payload)),
  )

  /* 同一张卡重复调：只发一次（用户明确要求「不重复」） */
  const again = hiddenNotifier.notifyConfirm({ id: 'sess-p13', key: 'clr_1', ...askCopy })
  check(
    '★ 同一张卡只发一次',
    again.ok === false && hiddenShown.shown.length === 1,
    JSON.stringify(again),
  )
  hiddenNotifier.notifyConfirm({ id: 'sess-p13', key: 'clr_2', ...askCopy })
  check('换一张卡照发（去重按卡片 id，不是按会话）', hiddenShown.shown.length === 2)

  /* 窗口在前台：一条都不发（这是「不打扰」的那条线） */
  const front = fakeWindow({ visible: true, focused: true })
  const frontShown = fakeNotification()
  const frontNotifier = notifierFor(front.win, frontShown)
  const frontResult = frontNotifier.notifyConfirm({ id: 'sess-p13', key: 'clr_9', ...askCopy })
  check('★ 窗口在前台 → 不发（不打扰）', frontShown.shown.length === 0 && frontResult.ok === false)

  /* 最小化：Windows 上 isVisible / isFocused 可能还说「正常」，得显式判 */
  const minAsk = fakeWindow({ visible: true, focused: true, minimized: true })
  const minShown = fakeNotification()
  const minNotifier = notifierFor(minAsk.win, minShown)
  minNotifier.notifyConfirm({ id: 'sess-p13', key: 'clr_10', ...askCopy })
  check('★ 最小化 → 也算不在前台（发）', minShown.shown.length === 1)

  group('需要你确认 / 接线')
  check('confirm-notify 提供 setNotifier（装配线接得进来）', typeof confirmNotify.setNotifier === 'function')
  const chatConfirmSrc = readFileSync(join(ROOT, 'electron/handlers/chat-confirm.cjs'), 'utf8')
  check(
    '★ 审批那条真的会去发通知',
    /sessionId,\s*\n\s*key: String\(payload\?\.confirmId/.test(chatConfirmSrc),
  )
  check(
    '★ 澄清那条真的会去发通知',
    /sessionId: String\(input\.sessionId \?\? ''\),\s*\n\s*key: cardId/.test(chatConfirmSrc),
  )
  /*
   * ⚠️ 这里不能直接写 `require('...')` 的字面量：自检 12 组会静态扫描所有 `.mjs`
   * 里的相对 require 并解析路径 —— 写在字符串里也一样会被当成真的引用，
   * 于是这条永远不会消失的红会挂在 12 组头上（实测踩到）。
   */
  check(
    '★ 装配线把通知器接给了 confirm-notify（不是建了不用）',
    /confirm-notify\.cjs'\)\s*\.setNotifier\(notifier\)/.test(
      readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8'),
    ),
  )
  check(
    '★ 审批那条把 sessionId 传下去了（点通知要跳回这条对话）',
    /chatConfirm\.askUser\(requestId, request, emit, sessionId\)/.test(
      readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8'),
    ),
  )
  const notifyHookSrc = readFileSync(join(ROOT, 'src/hooks/useTaskNotifications.ts'), 'utf8')
  check(
    '★ 渲染层按 kind 分流：确认类跳卡片（**不能**打开任务中心）',
    /kind === 'confirm'[\s\S]{0,200}openPendingCard\(/.test(notifyHookSrc),
  )
  check(
    '确认类不碰任务中心（任务中心是「看结果」的地方）',
    !/openPendingCard[\s\S]{0,200}setActiveRightTab\('tasks'\)/.test(notifyHookSrc),
  )

  /* 卡片亮了没：渲染层那个请求位是「递增 nonce」，不是布尔（不用写复位逻辑） */
  const uiStoreSrc = readFileSync(join(ROOT, 'src/stores/useUIStore.ts'), 'utf8')
  check(
    '卡片「亮一下」用递增 nonce 表示（卡片那边只认「又收到一次请求」）',
    /requestCardFocus: \(\) => set\(\(s\) => \(\{ cardFocusNonce: s\.cardFocusNonce \+ 1 \}\)\)/.test(
      uiStoreSrc,
    ),
  )
  const cardsSrc = readFileSync(join(ROOT, 'src/components/chat/AboveInputCards.tsx'), 'utf8')
  check(
    '★ 收到请求才聚焦（focusNonce <= 0 直接返回，别在普通打开时抢焦点）',
    /if \(focusNonce <= 0\) return/.test(cardsSrc),
  )
}

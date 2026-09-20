import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'
import Module from 'node:module'

/* ══════════════════════════════════════════════════════════════
   托盘（关窗口 ≠ 退出）

   用户报「点 × 就退出了」「右下角图标右键没菜单」——查下来是同一件事：
   点 × 其实好好地藏到了托盘（用 WM_CLOSE 复现验证过），但**右键弹不出菜单**
   就再也叫不回来，看着就像退出。

   这一组用假 electron 真跑一遍托盘逻辑（tray.cjs 在模块加载时就 require
   electron，纯 Node 里必须先挂假的）：
     · 右键 → 真的调 popUpContextMenu（不是只挂在 setContextMenu 上）
     · 左键 → 显示窗口
     · 菜单里有「显示窗口」和「退出」
     · 藏到托盘会隐藏窗口，并且**只提示一次**「我还在这儿」
   ══════════════════════════════════════════════════════════════ */

/** 假 electron：Tray / Menu / app 都记下被怎么用了 */
function fakeElectron() {
  const trays = []
  const menus = []
  class FakeTray {
    constructor(icon) {
      this.icon = icon
      this.handlers = new Map()
      this.popped = 0
      this.tooltip = ''
      trays.push(this)
    }
    setToolTip(text) {
      this.tooltip = text
    }
    setContextMenu(menu) {
      this.contextMenu = menu
    }
    popUpContextMenu(menu) {
      this.popped += 1
      this.poppedWith = menu
    }
    on(event, handler) {
      this.handlers.set(event, handler)
    }
    emit(event) {
      this.handlers.get(event)?.()
    }
  }
  class FakeMenu {
    static buildFromTemplate(template) {
      const menu = { template }
      menus.push(menu)
      return menu
    }
  }
  const app = {
    quitCalls: 0,
    quit() {
      this.quitCalls += 1
    },
  }
  return { FakeTray, FakeMenu, app, trays, menus }
}

/** 用假 electron 加载一次 tray.cjs（模块加载时就 require electron，必须挂假的） */
function loadTray(fake) {
  const originalLoad = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: fake.app, Tray: fake.FakeTray, Menu: fake.FakeMenu }
    return originalLoad.call(this, request, ...rest)
  }
  try {
    /* 每次都拿一份干净的：删掉缓存，避免上一组留下的 tray 单例 */
    for (const key of Object.keys(require.cache ?? {})) {
      if (key.includes('tray.cjs') || key.includes('window-state.cjs')) delete require.cache[key]
    }
    return require(join(ROOT, 'electron/tray.cjs'))
  } finally {
    Module._load = originalLoad
  }
}

function fakeWindow() {
  const calls = []
  return {
    calls,
    win: {
      isMinimized: () => false,
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
      hide: () => calls.push('hide'),
    },
  }
}

/* 品牌名从配置读 —— 断言里别再写死，不然改名时会和实现一起错 */
const brandName = require(join(ROOT, 'electron/core/config-defaults.cjs')).BRAND.name

export async function run() {
  group('托盘 / 菜单与显示窗口')

  const fake = fakeElectron()
  const tray = loadTray(fake)
  /* windowState.get() 拿不到窗口时走 createWindowHook —— 这里塞一个真窗口 */
  const { calls, win } = fakeWindow()
  const windowState = require(join(ROOT, 'electron/window-state.cjs'))
  windowState.set(win)

  const shownNotices = []
  tray.setupTray({ notify: (payload) => shownNotices.push(payload) })

  check('托盘创建了', fake.trays.length === 1)
  if (fake.trays.length === 0) {
    /* ★ 曾经在这里直接崩过：干净 clone 里没有图标文件 → 托盘不创建 →
       下一行访问 fake.trays[0].tooltip 抛 TypeError，整组测试挂掉。
       现在给出人话就早退，免得后来人对着一个 TypeError 猜半天。 */
    check('托盘图标文件在（build/icon.png 必须进仓库）', false)
    return
  }
  const icon = fake.trays[0]
  check('设了 tooltip（跟着品牌走）', icon.tooltip === brandName)

  const labels = (fake.menus[0]?.template ?? []).map((item) => item.label ?? `(${item.type})`)
  check('菜单里有「显示窗口」和「退出」', labels.includes('显示窗口') && labels.includes('退出'), labels.join(', '))

  /* ★ 右键：必须真的弹菜单（这是用户报的那个问题） */
  check('注册了右键处理', typeof icon.handlers.get('right-click') === 'function')
  check('没有只靠 setContextMenu（Windows 上要显式弹）', icon.contextMenu === undefined)
  icon.emit('right-click')
  check('★ 右键真的调了 popUpContextMenu', icon.popped === 1, String(icon.popped))
  check('弹的就是那份菜单', icon.poppedWith === fake.menus[0])

  /* 左键 / 双击 → 显示窗口 */
  calls.length = 0
  icon.emit('click')
  icon.emit('double-click')
  check('左键和双击都显示窗口', calls.filter((c) => c === 'show').length === 2, calls.join(','))

  /*
   * 菜单项：两项都要在，而且点了真有用。
   * 用 find + 可选调用（不是 find(...).click()）—— 后者的写法在菜单项缺失时
   * 会直接抛异常把整组测试带崩，那样虽然也是红，但看不出是缺了哪一项。
   */
  const showItem = fake.menus[0].template.find((item) => item.label === '显示窗口')
  const quitItem = fake.menus[0].template.find((item) => item.label === '退出')
  check('菜单两项都在', Boolean(showItem) && Boolean(quitItem))

  calls.length = 0
  showItem?.click()
  check('菜单「显示窗口」能叫回来', calls.includes('show'))

  quitItem?.click()
  check('菜单「退出」真的退出', fake.app.quitCalls === 1 && tray.isQuitting() === true)

  group('托盘 / 藏起来的提示')
  calls.length = 0
  tray.hideToTray(win)
  check('藏到托盘 = 隐藏窗口', calls.includes('hide'))
  check('★ 第一次会提示「我还在这儿」（否则用户以为退出了）', shownNotices.length === 1, String(shownNotices.length))
  check('提示里说明怎么回来', /托盘/.test(shownNotices[0]?.body ?? ''))

  tray.hideToTray(win)
  check('第二次不再提示（避免骚扰）', shownNotices.length === 1, String(shownNotices.length))

  group('托盘 / 接线')
  const mainSrc = readFileSync(join(ROOT, 'electron/main.cjs'), 'utf8')
  check('★ 点 × 走的是「藏到托盘」而不是直接关', /event\.preventDefault\(\)[\s\S]{0,200}hideToTray\(win\)/.test(mainSrc))
  check('托盘拿到了通知器（提示复用同一套系统通知）', mainSrc.includes('notify: trayNotifier?.notify'))
  const handlersSrc = readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  check('注册清单把通知器交回去了', handlersSrc.includes('return { notifier }'))
}

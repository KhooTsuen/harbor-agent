/**
 * 自检 / M02-C：**设置抽屉**
 *
 * ── 这一组钉什么 ───────────────────────────────────────────────
 *
 *   ① **能力清单从 manifest 现算**（设计文档明写「不手写」）。
 *      手写的清单会在改 manifest 时偷偷过期，而用户是拿它判断「这个扩展能干什么」。
 *   ② **不认识的权限如实列原名**，不隐藏、不编一句话骗人。
 *   ③ **站点权限只指路**：这里**没有**开关/白名单/拉黑按钮 ——
 *      做一个半吊子的第二套，用户会以为拉黑生效了（而真相在主应用）。
 *   ④ **原来的假按钮没了**：设置按钮现在真开抽屉，不再弹「还没做」。
 *   ⑤ 连接信息（host 名 / 状态 / 重试）都在。
 */

import { join, readFileSync, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')
const SRC = 'harbor-edge/src/sidepanel'

async function importTs(name) {
  return import(`file:///${join(ROOT, SRC, name).replace(/\\/g, '/')}`)
}

export async function run() {
  const S = await importTs('settings-info.ts')

  /* ══════════════════════════════════════════════════════════════
     ① 能力清单从 manifest 现算
     ══════════════════════════════════════════════════════════════ */
  group('M02-C 设置抽屉 · 能力清单从 manifest 现算（不手写）')

  const real = S.capabilitiesOf({
    permissions: ['nativeMessaging', 'sidePanel', 'storage', 'activeTab', 'scripting'],
  })
  check('★★★ 五个权限都列出来了', real.capabilities.length === 5, JSON.stringify(real.capabilities.map((c) => c.name)))
  check('★★★ 认得的权限翻成人话（不是显示权限名）', real.capabilities.every((c) => c.known === true && c.text !== c.name), JSON.stringify(real.capabilities[0]))
  check('★★ nativeMessaging 的人话说清了「唯一的数据通道」', /唯一的数据通道/.test(real.capabilities.find((c) => c.name === 'nativeMessaging').text))

  /* 不认识的权限：如实列原名（不隐藏、不编） */
  const unknown = S.capabilitiesOf({ permissions: ['someFutureThing'] })
  check('★★★ 不认识的权限照样列出来（不隐藏）', unknown.capabilities.length === 1 && unknown.capabilities[0].name === 'someFutureThing')
  check('★★★ 不认识时 known=false，界面上会显式标出「未收录」', unknown.capabilities[0].known === false && unknown.capabilities[0].text === 'someFutureThing')

  check('★ 读不到 manifest（null）不抛，返回空清单', S.capabilitiesOf(null).capabilities.length === 0)
  check('★ 只有 host_permissions 时单独给出（界面会警示）', S.capabilitiesOf({ host_permissions: ['http://a/*'] }).hostPermissions.length === 1)

  /* 右键选区是显式入口；仍不申请全站 host_permissions。 */
  const mf = S.capabilitiesOf(JSON.parse(R('harbor-edge/extension/manifest.json')))
  const names = mf.capabilities.map((c) => c.name)
  check('★★★ 有选区右键入口，仍无 tabs 权限', !names.includes('tabs') && names.includes('contextMenus'), names.join(','))
  check('★★ 快捷键已配置', Boolean(JSON.parse(R('harbor-edge/extension/manifest.json')).commands?.['open-panel']))
  /*
   * ★ M07 最小权限（2026-10-21 修订）：**默认**仍然不要 host 权限 ——
   *   装完就全站可读是不可接受的。但用户主动扩大的入口要有，靠
   *   `optional_host_permissions`（安装时不弹窗、必须运行时申请）。
   *   判据从「一条都不许有」改成「默认那一处必须是空、可选那一处才许有」。
   */
  check('★★★ 产品 manifest 默认 host_permissions 为空（M07 最小权限）', mf.hostPermissions.length === 0, JSON.stringify(mf.hostPermissions))
  check('★★ 可选 host 权限走 optional_host_permissions（安装时不弹窗）', mf.optionalHostPermissions.length === 1 && mf.optionalHostPermissions[0] === '<all_urls>', JSON.stringify(mf.optionalHostPermissions))

  /* ══════════════════════════════════════════════════════════════
     ② 站点权限只指路，不做第二套
     ══════════════════════════════════════════════════════════════ */
  group('M02-C 设置抽屉 · 站点权限只指路（不提前分裂）')

  const drawerSrc = R(`${SRC}/SettingsDrawer.tsx`)
  check('★★★ 指路文案说清「归主应用管」', /主应用统一管/.test(S.SITES_POINTER))
  check('★★★ 抽屉里**没有**站点开关（不做半吊子的第二套）', !/checkbox/.test(drawerSrc) && !/setSite|removeSite|blocked/i.test(drawerSrc))
  check('★★ 抽屉里没有直接改站点策略的调用', !/requestHost|sendMessage/.test(drawerSrc))

  /* ══════════════════════════════════════════════════════════════
     ③ 接线：假按钮没了、抽屉真开、连接信息在
     ══════════════════════════════════════════════════════════════ */
  group('M02-C 接线 · 假按钮换成真抽屉')

  const appSrc = R(`${SRC}/App.tsx`)
  check('★★★ 原来那个「扩展设置还没做」的假按钮没了', !/扩展设置还没做/.test(appSrc))
  check('★★★ 设置按钮现在真开抽屉', /label="设置"[^>]*onClick=\{\(\) => setSettings\(true\)\}/.test(appSrc))
  check('★★ App 把设置抽屉的开关状态传下去了', /settingsOpen=\{settings\}/.test(appSrc) && /onCloseSettings=\{/.test(appSrc))

  const chatSrc = R(`${SRC}/ChatPanel.tsx`)
  check('★★★ ChatPanel 挂载了设置抽屉', /<SettingsDrawer\s/.test(chatSrc))
  check('★★ 抽屉吃的是同一个 connected（不另编一套连接判断）', /connected=\{connected\}/.test(chatSrc))

  check('★★★ 连接信息三件齐：host 名 / 状态 / 重试', /aria-label="host 名"/.test(drawerSrc) && /aria-label="连接状态详情"/.test(drawerSrc) && /aria-label="重试连接"/.test(drawerSrc))
  check('★★ host 名是 install-host 写的那个', S.HOST_NAME === 'com.harbor.agent', S.HOST_NAME)
  check('★★ 抽屉的可访问名字是验收锚点', /aria-label="设置抽屉"/.test(drawerSrc))
  check('★★ 三个分区的锚点都在（连接 / 能力 / 站点指路）', /aria-label="连接信息"/.test(drawerSrc) && /aria-label="能力清单"/.test(drawerSrc) && /aria-label="站点权限指路"/.test(drawerSrc))
  check('★★ 未连接时才显示错误（连上了不吓人）', /!connected && lastError/.test(drawerSrc))

  /* ══════════════════════════════════════════════════════════════
     ④ 可选整站读取（2026-10-21）：够不够得着，与黑名单正交
     ══════════════════════════════════════════════════════════════ */
  group('M07 可选整站读取 · 宿主权限模式（纯函数）')

  const A = await importTs('site-access.ts')
  /* originPatternOf 是最容易写错、且错了不会报错的地方（拼错就是永远申请不到） */
  check('★★★ 普通网址 → 站点模式', A.originPatternOf('https://a.com/x/y?z=1') === 'https://a.com/*', A.originPatternOf('https://a.com/x/y?z=1'))
  check('★★★ http 也认（不能只认 https）', A.originPatternOf('http://a.com/') === 'http://a.com/*', A.originPatternOf('http://a.com/'))
  check('★★ 端口不写进模式（match pattern 的 host 段不带端口）', A.originPatternOf('http://localhost:3000/a') === 'http://localhost/*', A.originPatternOf('http://localhost:3000/a'))
  check('★★★ 浏览器内部页给不出模式（→ 不申请，而不是申请 /*）', A.originPatternOf('edge://settings') === '' && A.originPatternOf('about:blank') === '', JSON.stringify([A.originPatternOf('edge://settings'), A.originPatternOf('about:blank')]))
  check('★★ 空串 / 乱码不抛，返回空串', A.originPatternOf('') === '' && A.originPatternOf('不是网址') === '')
  check('★★ 非扩展环境（自检里没有 chrome）查权限一律 false，不抛', (await A.hasAllSites()) === false && (await A.requestAllSites()) === false)
  check('★★ 有站点模式才去申请；给不出模式直接 false', (await A.requestSite('edge://x')) === false)

  group('M07 可选整站读取 · 接线')

  const accessSrc = R(`${SRC}/SiteAccessPanel.tsx`)
  check('★★★ 抽屉挂了「整站读取」那一块', /<SiteAccessPanel/.test(drawerSrc))
  check('★★★ 申请按钮真的调 request（不是画个开关骗人）', /requestAllSites/.test(accessSrc) && /removeAllSites/.test(accessSrc))
  check('★★★ 申请是点击里的第一句（丢了用户手势就申请不了）', /const ok = await requestAllSites\(\)/.test(accessSrc))
  check('★★ 听浏览器授权变化（在原生框里改了要跟着变）', /onAdded/.test(accessSrc) && /onRemoved/.test(accessSrc))
  check('★★ 说清了「够得着」与「许不许读」是两件事', /站点黑名单/.test(accessSrc))

  const pageSrc = R(`${SRC}/PageCard.tsx`)
  check('★★★ 网页卡有「记住本页」入口', /aria-label="记住本页"/.test(pageSrc))
  check('★★ 记住本页只申请当前站点（不是偷偷申请整站）', /requestSite\(/.test(pageSrc) && !/requestAllSites\(/.test(pageSrc))
  check('★★ 拿不到地址时不显示（申请 origin 需要具体地址）', /readable && remembered === false/.test(pageSrc))
}

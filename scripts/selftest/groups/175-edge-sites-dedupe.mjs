/**
 * 自检 / Edge 扩展：**站点策略 + 指令去重**
 *
 * 两块都是 2026-10-20 用户逐条指出的洞，修法各有一条贯穿的主线：
 *
 *   ① **站点策略 → fail-closed**。核实不了（连不上主进程 / 策略文件坏了）必须
 *      **拒绝**读和操作，不能放行。以前是 fail-open，理由是「Harbor 没开时读不到
 *      页面」—— 站不住：`activeTab` 授予后持续到导航离开，Harbor 关掉后扩展
 *      **仍然**读得到，于是「Harbor 没开」成了绕过黑名单的后门。
 *      要区分**「用户还没配过」**（可核实为空 → 按默认策略放行）与
 *      **「无法核实已有策略」**（拒绝，并说清原因）。
 *
 *   ② **去重 → 动作 + 目标 + 载荷**。上一版键只有 `command|ref|pageVersion`，
 *      于是「同一输入框先填 AAA 再填 BBB」第二条被静默拦掉；而 `tabs-create` /
 *      `tabs-close` 那两个分支在去重判断**之前**就 return，名单里有、实际从没生效。
 *      另外「记录」必须发生在**执行之后**，且只在副作用真的发生时记 —— 否则
 *      「第一次失败后立刻重试」也会被拦 2 秒。
 *
 * 判据用「读源码钉接线 + 真跑纯模块」：
 *   · `ext-sites.cjs` 是纯 CJS，直接 require 真跑
 *   · `dedupe.js` 是纯 ESM（不碰 chrome），用 data URL 动态 import 真跑
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import fs from 'node:fs'
import path from 'node:path'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')

export async function run() {
  const sites = require(join(ROOT, 'electron/core/ext-sites.cjs'))
  const opsSrc = R('electron/core/ext-ops.cjs')
  const cmdSrc = R('harbor-edge/extension/lib/command-run.js')

  /* ══════════════════════════════════════════════════════════════
     ① 归一化与父域匹配（判定只有一处）
     ══════════════════════════════════════════════════════════════ */
  group('Edge 站点策略 · 归一化与父域匹配（判定只有一处）')

  check('★★ 带端口的 url 归一成裸 host', sites.hostOf('https://Example.COM:8443/a/b') === 'example.com')
  check('★★ 裸 host + 路径也能归一', sites.hostOf('example.com/x') === 'example.com')
  check('★ localhost 保留（不当成空）', sites.hostOf('localhost') === 'localhost')
  check('★ 空值给空串', sites.hostOf('') === '' && sites.hostOf(null) === '')

  const blocked = { 'example.com': { blocked: true } }
  check('★★★ 子域命中父域规则', Boolean(sites.matchBlocked(blocked, 'a.example.com')))
  check('★★★ 相似域名**不**误伤（notexample.com 不算 example.com）', sites.matchBlocked(blocked, 'notexample.com') === null)
  check('★★ 精确命中', Boolean(sites.matchBlocked({ localhost: { blocked: true } }, 'localhost')))
  check('★★ 没配置的站点一律放行（默认策略是放行）', sites.matchBlocked({}, 'anything.test') === null)

  /* ══════════════════════════════════════════════════════════════
     ② 扩展侧真的在采集/操作之前问过 + 核实不了一律拒绝
     ══════════════════════════════════════════════════════════════ */
  group('Edge 站点策略 · 采集前必问，且核实不了就不放行')

  check(
    '★★★ 读当前页在采集前问策略（checkSite 在 executeScript 之前）',
    /checkSite\(url\)[\s\S]{0,400}executeScript/.test(R('harbor-edge/extension/service-worker.js')),
  )
  check(
    '★★★ 观察页面在采集前问策略',
    /checkSite\(String\(target\.url[\s\S]{0,600}executeScript/.test(R('harbor-edge/extension/lib/observe-run.js')),
  )
  check('★★★ 下行指令执行前问策略（被拉黑就不碰页面）', /checkSite\(String\(target\.tab\?\.url/.test(cmdSrc))
  check('★★ 被拒时 reason=site-blocked（模型据此知道不是执行失败、别重试）', /reason:\s*'site-blocked'/.test(cmdSrc))

  /*
   * ★★★ 修正①（行为判据，2026-10-20）：真造坏文件 → 必须拒绝。
   *    以前这里是**读源码匹配正则**，第一版正则在 `catch` 之后留了 200 字符的余量，
   *    结果匹配到了后面另一句 `return unverifiable(...)` ——「把 catch 改成 fail-open」
   *    时判据**不变红**（空转）。改成真跑：造坏文件最直接，改坏任何一处都会红。
   *
   *    ⚠️ 只碰自检隔离数据根（`data/unit-test-data`），不碰用户真实策略文件。
   */
  const sitesFile = sites.file()
  const backup = fs.existsSync(sitesFile) ? fs.readFileSync(sitesFile, 'utf8') : null
  const restoreSites = () => {
    try {
      if (backup === null) fs.rmSync(sitesFile, { force: true })
      else fs.writeFileSync(sitesFile, backup, 'utf8')
    } catch {
      /* 恢复失败不影响已有结论（下一轮自检会重建隔离根） */
    }
  }
  try {
    fs.mkdirSync(path.dirname(sitesFile), { recursive: true })

    /* (a) 文件不在 = 确认没配置 → 放行（默认策略） */
    fs.rmSync(sitesFile, { force: true })
    const fresh = sites.check('https://example.com/x')
    check('★★★ 策略文件不在 → 放行（确认「用户还没配过」）', fresh.allowed === true && fresh.verified === true, JSON.stringify(fresh))

    /* (b) 拉了黑名单 → 拒绝 */
    sites.setSite('blocked-trial.test', true, '自检：故意拉黑')
    const hit = sites.check('https://a.blocked-trial.test/')
    check('★★ 拉黑后拒绝（父域命中）', hit.allowed === false && hit.blockedBy === 'blocked-trial.test' && hit.verified === true)
    const temporary = sites.setSite('hour-trial.test', true, '临时测试', { minutes: 60 })
    const temporaryRow = sites.list().sites.find((row) => row.host === 'hour-trial.test')
    check('★★★ 临时拒绝立即生效且有到期时间', temporary.ok === true && temporaryRow?.active === true && temporaryRow.expiresAt > Date.now())
    check('★★★ 到期条目自动放行', sites.matchBlocked({ 'hour-trial.test': { blocked: true, expiresAt: Date.now() - 1 } }, 'hour-trial.test') === null)
    sites.removeSite('hour-trial.test')
    check('★★★ 撤销后立即放行', sites.check('https://hour-trial.test/').allowed === true)

    fs.writeFileSync(sitesFile, JSON.stringify({ version: 1, sites: { 'legacy.test': { blocked: true } } }), 'utf8')
    const upgraded = sites.setSite('new.test', true, '升级测试')
    const upgradedFile = JSON.parse(fs.readFileSync(sitesFile, 'utf8'))
    check('★★★ v1 站点策略升级后保留旧拒绝', upgraded.ok === true && upgradedFile.version === 2 && sites.check('https://legacy.test').allowed === false)

    /* (c) 文件坏了 = 无法核实 → **必须拒绝**（这就是修正①的核心） */
    fs.writeFileSync(sitesFile, '{ 这不是 JSON', 'utf8')
    const broken = sites.check('https://a.blocked-trial.test/')
    check('★★★ 策略文件坏了 → 拒绝（不是放行）', broken.allowed === false, JSON.stringify(broken))
    check('★★★ 且标 verified:false（能区分「被拉黑」与「核实不了」）', broken.verified === false)
    check('★★ 文件坏了时 check() 给得出人话原因', /坏了|解析|读不到/.test(String(broken.error)))
    check('★★★ 文件坏了时**没配置过的站点也拒绝**（无法核实 = 谁都不放行）', sites.check('https://never.test/').allowed === false)

    /* (d) 读不出（目录占位 → 非 ENOENT）→ 同样拒绝 */
    fs.rmSync(sitesFile, { force: true })
    fs.mkdirSync(sitesFile, { recursive: true })
    check('★★ 读不出策略文件 → 也拒绝（不只防解析错误）', sites.check('https://example.com/').allowed === false)
    fs.rmSync(sitesFile, { recursive: true, force: true })

    /* (e) 坏了的时候不许写（否则等于拿空表覆盖用户配置） */
    fs.writeFileSync(sitesFile, 'broken', 'utf8')
    const w = sites.setSite('another.test', true, 'x')
    check('★★★ 无法核实时 setSite 拒绝写（不丢用户已有配置）', w.ok === false && fs.readFileSync(sitesFile, 'utf8') === 'broken')

    /* (f) 修好之后恢复放行，不留粘滞 */
    fs.rmSync(sitesFile, { force: true })
    check('★ 修好后恢复放行（不粘滞）', sites.check('https://example.com/').allowed === true)
  } finally {
    restoreSites()
  }

  /* 扩展侧：接线层用源码钉（它依赖 chrome，跑不起来） */
  const siteSrc = R('harbor-edge/extension/lib/site-policy.js')
  check('★★★ 扩展侧连不上主进程时走 unverifiable（不是 allowed:true）', /catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,80}return\s+unverifiable\(/.test(siteSrc))
  check('★★★ 扩展侧主进程回 verified:false 时走 unverifiable', /reply\.verified === false[\s\S]{0,80}return\s+unverifiable\(/.test(siteSrc))
  check('★★ 核实不了时带 verified:false', /verified:\s*false/.test(siteSrc))
  check('★★ 扩展侧没有「查不到就放行」的 return', !/allowed:\s*true[^}]{0,60}verified:\s*true,\s*host:\s*''/.test(siteSrc))
  check('★★ 策略落 data/ 下（硬约束 #3）', /join\(DIRS\.data,\s*'ext-sites\.json'\)/.test(R('electron/core/ext-sites.cjs')))
  check('★★ 协议里有 site:policy 一条', /SITE_POLICY:\s*'site:policy'/.test(R('electron/core/ext-kinds.cjs')))
  check('★★ 分派表里注册了它', /\[P\.KIND\.SITE_POLICY\]/.test(opsSrc))

  /* ══════════════════════════════════════════════════════════════
     ③ 去重：真跑 dedupe.js（它不碰 chrome，能直接加载）
     ══════════════════════════════════════════════════════════════ */
  group('Edge 去重 · 动作 + 目标 + 载荷 2 秒内只执行一次')

  const dedupeSrc = R('harbor-edge/extension/lib/dedupe.js')
  const D = await import(`data:text/javascript;base64,${Buffer.from(dedupeSrc, 'utf8').toString('base64')}`)

  check('★★★ 去重窗口是 2 秒（源码常量）', /DEDUPE_WINDOW_MS\s*=\s*2000/.test(dedupeSrc))

  D.resetDedupe()
  const kClick = D.fingerprint('click', { ref: 'e1', pageVersion: 'v1' })
  check('★★ 首次执行不算重复', D.seenRecently(kClick) === false)
  D.markExecuted(kClick)
  check('★★★ 同动作 + 同目标 + 同版本 → 判重复', D.seenRecently(kClick) === true)
  check('★★★ 同一元素点击后页面版本变化仍算重复', D.seenRecently(D.fingerprint('click', { ref: 'e1', pageVersion: 'v2' })) === true)
  check('★★ 不同元素 → 不算重复', D.seenRecently(D.fingerprint('click', { ref: 'e2', pageVersion: 'v1' })) === false)

  /* 载荷必须进指纹：否则「先填 AAA 再填 BBB」第二条被静默拦掉 */
  D.resetDedupe()
  const kA = D.fingerprint('type', { ref: 'i1', text: 'AAA', pageVersion: 'v1' })
  const kB = D.fingerprint('type', { ref: 'i1', text: 'BBB', pageVersion: 'v1' })
  check('★★★ 同一输入框填**不同文字**不算重复（载荷进指纹）', kA !== kB && D.seenRecently(kB) === false, `${kA} vs ${kB}`)
  D.markExecuted(kA)
  check('★★ 同一输入框填**相同文字**才算重复', D.seenRecently(kA) === true)

  /* 失败后重试必须放行：判据是 reallyHappened（≠ ok） */
  check('★★★ 明确报错 → 不算发生（可立刻重试）', D.reallyHappened({ ok: false, error: '元素不存在' }) === false)
  check('★★★ 注入超时（指令已发出）→ 算发生', D.reallyHappened({ ok: false, reason: 'no-result', timedOut: true }) === true)
  check('★★ 导航型点击 → 算发生', D.reallyHappened({ ok: false, reason: 'navigating', navigated: true }) === true)

  /* 标签页操作必须真被覆盖（上一版在去重判断之前就 return 了） */
  check('★★★ tabs-create / tabs-close 在去重范围里', D.isMutating('tabs-create') === true && D.isMutating('tabs-close') === true)
  D.resetDedupe()
  const kOpen = D.fingerprint('tabs-create', { url: 'https://a.test/' })
  D.markExecuted(kOpen)
  check('★★ 连开同一个 url → 第二次判重复；开不同 url 不误拦', D.seenRecently(kOpen) === true && D.seenRecently(D.fingerprint('tabs-create', { url: 'https://b.test/' })) === false)
  check(
    '★★★ 接线：标签页分支**在 return 之前**先去重（防回退）',
    /* ★ 2026-10-20 修：原来只要求出现 `seenRecently(key)`，于是把它改成
       `if (false && seenRecently(key))` 也照样通过（空转）。现在钉住完整条件。 */
    /if\s*\(\s*mutating\s*&&\s*seenRecently\(key\)\s*\)\s*return\s+reply\(duplicateResult\(\)\)/.test(cmdSrc) &&
      /if\s*\(mutating\s*&&\s*reallyHappened\(out\)\)\s*markExecuted\(key\)/.test(cmdSrc),
  )
  check(
    '★★★ 接线：页面动作分支也是同一对条件（两处一致，不各写一套）',
    (cmdSrc.match(/mutating && seenRecently\(key\)/g) || []).length >= 2,
  )
  check('★★ 阅读型动作不去重（get-elements / verify / wait / scroll / focus）', ['get-elements', 'verify', 'wait', 'scroll', 'focus'].every((c) => D.isMutating(c) === false))
  check('★★ 重复时不执行、明确回 duplicate + deduped', /reason:\s*'duplicate'/.test(dedupeSrc) && /deduped:\s*true/.test(dedupeSrc))
  check(
    '★★★ 主进程把 pageVersion 一起下发（否则扩展只能拿 url 冒充版本）',
    /call\('click',\s*\{\s*ref,\s*settleMs,\s*pageVersion/.test(R('electron/core/ext-command.cjs')),
  )
  /*
   * ★★★ 2026-10-20 自查发现的漏：`NEEDS_PAGE_VERSION` 里定了 5 个动作要靠版本判重，
   *    但主进程只有 `click` 真把版本下发下去 —— `type` / `select` / `clear` / `key`
   *    都漏了，于是「页面变了、要再填一次同样的字」会被**误判成重复**。
   *    这条钉住「凡去重指纹要版本的动作，主进程都真的给了」。
   */
  const actSrc = R('electron/core/ext-actions.cjs')
  check('★★ 页面版本变化不改变同一点击的去重指纹', D.fingerprint('click', { ref: 'v1.2', pageVersion: 'v1' }) === D.fingerprint('click', { ref: 'v1.2', pageVersion: 'v2' }))
  const sendVer = (cmd) => new RegExp(`call\\('${cmd}',\\s*\\{[^}]*pageVersion`).test(cmd === 'click' ? R('electron/core/ext-command.cjs') : actSrc)
  check('★★★ 凡需版本的动作用，主进程都真的下发了 pageVersion', ['click', 'type', 'select', 'clear', 'key'].every(sendVer), ['click', 'type', 'select', 'clear', 'key'].filter((c) => !sendVer(c)).join(',') || '全部下发')

  /*
   * ★★★ 2026-10-20 真机逮到（accept-ownership ⑮e）：去重回 `{ok:false, reason:'duplicate'}`
   *    （**没有** error 字段），旧兜底 `res.error ? res : fail(INTERNAL,...)` 把它吞成
   *    INTERNAL —— 用户看到「浏览器没回可用的结果」，猜不到「这是重复、别重试」。
   *    `click` 早有 `!res.reason` 保护，其余四个没有。这条钉「六处口径一致」。
   */
  check('★★★ 带 reason 的业务性拒绝原样落盘（不被兜底吞成 INTERNAL）', /refusedOrNull\(kind, res,/.test(actSrc) && /res\.ok === true \|\| !res\.reason/.test(actSrc))
  const finishCount = (actSrc.match(/return finishAction\('/g) || []).length
  check('★★★ 六个动作都走同一处（不是只修 type）', finishCount >= 6 && /const refused = refusedOrNull\(kind, res, meta\)/.test(actSrc), `finishAction 调用 ${finishCount} 处`)
  const actions = require(join(ROOT, 'electron/core/ext-actions.cjs')).createActions({
    call: async () => ({ ok: true }), getElements: async () => ({ ok: true, pageVersion: 'v1' }),
    landAction: (kind, result) => ({ ok: result.ok, kind }),
  })
  const outcomes = await Promise.all([actions.type({ ref: 'v1.1', text: 'a' }), actions.select({ ref: 'v1.1', value: 'a' }), actions.scroll({}), actions.clear({ ref: 'v1.1' }), actions.focus({ ref: 'v1.1' }), actions.key({ ref: 'v1.1', key: 'Enter' })])
  check('★★★ 六个动作成功后都返回成功回执', outcomes.every((outcome) => outcome?.ok === true), JSON.stringify(outcomes))
  check('★★ duplicate 回执带 reason（不是只有 error）', /reason:\s*'duplicate'/.test(dedupeSrc) && !/reason:\s*'duplicate'[\s\S]{0,120}error:\s*\{/.test(dedupeSrc))

  /* ══════════════════════════════════════════════════════════════
     ④ 推送事件名必须与渲染层真实发出的对齐（M02-B 前置）
     ══════════════════════════════════════════════════════════════ */
  group('Edge 推送 · PUSH_TYPES 与渲染层事件名对齐（防静默失效）')

  const pushTypes = require(join(ROOT, 'electron/core/ext-chat-streams.cjs')).PUSH_TYPES
  /*
   * ★★★ 从渲染层的类型定义里抠出**真实事件名**，逐个要求 PUSH_TYPES 认得。
   *    2026-10-20 查出的静默失效：PUSH_TYPES 写的是 `tool_start`/`tool_end`，
   *    而渲染层发的是 `agent.tool.started`/`agent.tool.completed` —— 那两个名字
   *    永远命中不了，「当前在跑哪个工具」从没推到过侧边栏，且**没有任何报错**。
   */
  const chatEventsSrc = R('src/types/chat-events.ts')
  const realTypes = [...new Set([...chatEventsSrc.matchAll(/type:\s*'([a-z_.]+)'/g)].map((m) => m[1]))]
  const toolTypes = realTypes.filter((t) => t.startsWith('agent.tool.'))
  check('★★ 渲染层确实有 agent.tool.* 事件（抠得到名字）', toolTypes.length >= 2, toolTypes.join(','))
  check(
    '★★★ 工具事件用**真名**在 PUSH_TYPES 里（不是 tool_start 那种对不上的旧名）',
    toolTypes.every((t) => pushTypes.has(t)),
    toolTypes.filter((t) => !pushTypes.has(t)).join(',') || '全对齐',
  )
  check('★★★ 任务卡要的相位事件也在（turn_start / plan / turn_end）', ['turn_start', 'plan', 'turn_end'].every((t) => pushTypes.has(t)))
  check('★★★ 「等待确认」也推（否则用户不知道卡在哪）', pushTypes.has('confirm_request'))
}

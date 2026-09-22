import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { existsSync, readFileSync as read } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   动作流 + 兜底（log-actions.cjs / crash-guard / preload 的唯一出入口）

   用户的要求是「把**没预料到的事件**也记下来，比如用户点了什么功能」。
   手工埋点做不到「没预料到」，所以靠三处兜底：
     ① preload 里所有 IPC 都过同一个 `call()`
     ② 渲染层全量点击 + window 级异常 → 上报
     ③ 主进程未捕获异常
   这一组钉的是「这三条网还在、而且没被绕过」。

   还有两条纪律必须钉死：
     · **不记 payload**（记了就等于把会话内容/密钥副本写进日志）
     · 高频通道不进流水（不然一天几十 MB 噪音）
   ══════════════════════════════════════════════════════════════ */

const actions = require(join(ROOT, 'electron/core/log-actions.cjs'))
/* 顶层 require 一份：run() 里面那处是给 actionsFile() 用的局部变量 */
const logCore = require(join(ROOT, 'electron/core/log.cjs'))
const { DIRS } = require(join(ROOT, 'electron/core/paths.cjs'))
const path = require('node:path')

function rowsOf(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function actionsFile() {
  /* 和实现一样用本地日期（用 UTC 的话凌晨会去找「昨天」那份文件） */
  const log = require(join(ROOT, 'electron/core/log.cjs'))
  return path.join(DIRS.logs, `actions-${log.dayStamp()}.jsonl`)
}

export async function run() {
  /* ── ① 写一条动作 ──────────────────────────────────────── */
  group('动作流 / 写下来的是结构化的一行')
  const marker = `selftest-${Date.now()}`
  actions.record({ kind: 'click', name: marker })
  const text = existsSync(actionsFile()) ? read(actionsFile(), 'utf8') : ''
  const mine = rowsOf(text).filter((r) => r.name === marker)
  check('★ 动作写进了 actions-*.jsonl', mine.length === 1, String(mine.length))
  check(
    '带时间戳（能和人看的日志对齐）',
    typeof mine[0]?.ts === 'string' && mine[0].ts.includes('T'),
  )
  check('带种类（click / ipc / error / action）', mine[0]?.kind === 'click')

  /* ── ② ★ 不记 payload：手滑塞进来的密钥也要被脱敏 ──────── */
  group('动作流 / 不记内容（密钥也得挡掉）')
  const secretMark = `selftest-secret-${Date.now()}`
  actions.record({
    kind: 'ipc',
    name: `probe-${Date.now()}`,
    ok: false,
    detail: `Authorization: Bearer sk-${secretMark}abcdefghijklmnop`,
  })
  const afterSecret = existsSync(actionsFile()) ? read(actionsFile(), 'utf8') : ''
  check(
    '★ detail 过脱敏（原文不许出现在文件里）',
    !afterSecret.includes(`sk-${secretMark}`),
    'raw secret leaked',
  )
  check('但事件本身还在（不然就成了静默丢日志）', afterSecret.includes('probe-'))

  /* ── ③ 高频通道不进流水 ───────────────────────────────── */
  group('动作流 / 高频通道不进流水')
  const before = existsSync(actionsFile()) ? read(actionsFile(), 'utf8').length : 0
  for (const name of ['shell:data', 'chat:event', 'log:action']) {
    actions.record({ kind: 'ipc', name, ok: true, ms: 1 })
  }
  const after = existsSync(actionsFile()) ? read(actionsFile(), 'utf8').length : 0
  check('★ 终端/流式那类通道写不进去（不然把有用的冲掉）', after === before, `${before} → ${after}`)
  check(
    '跳过名单里有它们',
    ['shell:data', 'chat:event'].every((n) => actions.SKIP.has(n)),
  )
  check(
    '上限存在（日志不能把磁盘吃光）',
    typeof actions.MAX_BYTES === 'number' && actions.MAX_BYTES > 0,
  )

  /* ── ④ ★ 唯一出入口：preload 里只有一处 invoke ────────── */
  group('兜底 / preload 是唯一出入口（绕不过去）')
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  /* 数之前先把块注释剥了 —— 注释里就写着这几个字（这个坑本项目踩过多次） */
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  const invokes = stripComments(preload).split('ipcRenderer.invoke(').length - 1
  check(
    '★ 整个 preload 只剩一处 ipcRenderer.invoke（就是 call() 自己那行）',
    invokes === 1,
    `找到 ${invokes} 处 —— 多一处说明有调用绕过了动作流；一处都没有说明 call() 调自己（死递归）`,
  )
  check('所有方法都走 call()', preload.includes("call('app:selfTest'"))
  /* ★ 沙箱化的 preload 不能 require 兄弟文件（拆出去过一次，界面 IPC 全死）*/
  check(
    '★ preload 是自足的（不许拆到兄弟文件里 require）',
    !/require\('\.\//.test(stripComments(preload)),
    'sandbox:true 下要求兄弟模块会抛，整个 preload 作废',
  )
  const callBody = stripComments(preload).slice(stripComments(preload).indexOf('function call('))
  check(
    '★ 上报里没有 args（只报通道名/成败/耗时，不报参数）',
    !/report\(\{[^}]*args/.test(callBody),
    'payload 可能被带进日志',
  )
  /*
   * ★ 成功那条路也要上报 —— 只查「invoke 只剩一处」不够：
   *   把成功分支里的 report 删掉，那个守卫照样绿（变异测试逮到的），
   *   但结果就是「506 条调用一条都没记」。
   */
  check('★ 成功路径真上报', /report\(\{ kind: 'ipc', name: channel, ok: true/.test(callBody))
  check('★ 失败路径也真上报', /ok: false/.test(callBody) && callBody.includes('report({'))

  /* ── ⑤ 主进程：所有通道都包了一层 ─────────────────────── */
  group('兜底 / 每个 IPC 通道的成败都留痕')
  const reg = readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  check(
    '★ ipcMain.handle 被包住（新通道自动在网里）',
    reg.includes('function wrapInvokeHandlers(ipcMain)'),
  )
  check(
    '成功记进动作流水',
    reg.includes("actions.record({ kind: 'ipc', name: channel, ok: true, ms })"),
  )
  check(
    '★ 失败进主日志（以前渲染层弹个 toast、日志里一个字都没有）',
    reg.includes('通道失败 ${channel}'),
  )
  check('慢调用也记一行', reg.includes('慢调用 ${channel}'))
  check(
    '包在注册之前（不然前面注册的通道漏网）',
    reg.indexOf('wrapInvokeHandlers(ipcMain)') < reg.indexOf("handlers/window.cjs').register"),
  )

  /* ── ⑥ 未捕获异常的两端 ───────────────────────────────── */
  group('兜底 / 没预料到的异常也要有地方落')
  const guard = readFileSync(join(ROOT, 'electron/crash-guard.cjs'), 'utf8')
  check('主进程 uncaughtException 有兜底', guard.includes("process.on('uncaughtException'"))
  check('主进程 unhandledRejection 有兜底', guard.includes("process.on('unhandledRejection'"))
  const mainSrc = readFileSync(join(ROOT, 'electron/main.cjs'), 'utf8')
  check(
    '★ 装得足够早（在 main.cjs 里调用，不是 app ready 之后）',
    mainSrc.includes('installCrashGuard()'),
  )
  check(
    '渲染层 window 级 error 有兜底',
    readFileSync(join(ROOT, 'src/lib/actionLog.ts'), 'utf8').includes(
      "win.addEventListener('error'",
    ),
  )
  check(
    '渲染层 unhandledrejection 有兜底',
    readFileSync(join(ROOT, 'src/lib/actionLog.ts'), 'utf8').includes("'unhandledrejection'"),
  )
  check(
    '渲染层在 React 挂载之前就装上',
    readFileSync(join(ROOT, 'src/main.tsx'), 'utf8').includes('installActionLog()'),
  )
  check(
    'ErrorBoundary 也把它报到主进程（不再只有 console.error）',
    readFileSync(join(ROOT, 'src/components/ErrorBoundary.tsx'), 'utf8').includes('logError('),
  )

  /* ── ⑦ ★ 真发一个未捕获异常，看它落不落下来 ──────────── */
  /*
   * 这一条是「把源码守卫换成行为断言」：
   * 变异测试把 `process.on('unhandledRejection', …)` 包成 `if (false)` ——
   * 字符串守卫照样绿，因为那行字还在。只有真 emit 一次才知道有没有人接。
   */
  group('兜底 / 真发一个未处理的异常')
  const crashGuard = require(join(ROOT, 'electron/crash-guard.cjs'))
  crashGuard.installCrashGuard()
  /*
   * ★ 两个标记必须**互不包含**：第一版写成 `boom` 和 `${boom}-uncaught`，
   *   结果 uncaughtException 那条记下来的串里也含 `boom` —— 于是把
   *   unhandledRejection 关掉（if (false)）之后断言照样绿（变异测试逮到的）。
   */
  const stamp = Date.now()
  const rejMark = `selftest-rejected-${stamp}`
  const uncMark = `selftest-crashed-${stamp}`
  process.emit('unhandledRejection', new Error(rejMark))
  process.emit('uncaughtException', new Error(uncMark))
  const afterBoom = existsSync(actionsFile()) ? read(actionsFile(), 'utf8') : ''
  check('★ unhandledRejection 真被记进动作流水', afterBoom.includes(rejMark))
  check('★ uncaughtException 也真被记下来', afterBoom.includes(uncMark))
  check(
    '★ 两条各记各的（不会因为前缀相同而互相冒充）',
    !rejMark.includes(uncMark) && !uncMark.includes(rejMark),
  )
  const mainLog = readFileSync(join(DIRS.logs, `${logCore.dayStamp()}.log`), 'utf8')
  check('★ 主日志里也有（人看的那份）', mainLog.includes(rejMark) && mainLog.includes(uncMark))

  /* ── ⑧ 上报通道本身注册了 ─────────────────────────────── */
  group('兜底 / 上报通道注册齐全')
  const handlerSrc = readFileSync(join(ROOT, 'electron/handlers/log.cjs'), 'utf8')
  check(
    '注册了 log:action（用 on，不给界面加延迟）',
    handlerSrc.includes("ipcMain.on('log:action'"),
  )
  check('注册了 log:error', handlerSrc.includes("ipcMain.on('log:error'"))
  check('渲染层异常也进动作流水（和「点了什么」能对上时间）', handlerSrc.includes("kind: 'error'"))
  check('注册清单里接上了', reg.includes("handlers/log.cjs').register({ ipcMain })"))
}

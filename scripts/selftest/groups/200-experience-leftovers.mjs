/**
 * 经验闭环的**已知遗留**逐条收账（2026-11-02 第二轮）—— 内核与工具侧
 *
 * 这一组钉的是「CHANGELOG 里写着没做完」的那 9 条里**改内核 / 改脚本**的几条。
 * 写法沿用 195/196：**先把旧行为复刻出来**（证明洞是真的），再用现在的入口跑同一份输入。
 *
 * 覆盖：
 *   ① 遗留 7：`loop-tools.executeToolCallsSerial` 不接经验观察入口 → 切成串行就静默失效
 *   ② 遗留 9：`systemCode`（ENOENT / EACCES…）恒为 null → 现在真的带回来了
 *   ③ 遗留 11：每次工具调用读一次 `experiences.json` → 加缓存，并且**缓存不许脏**
 *   ④ 遗留 1/13：`/停止/`、包含匹配 → 会点中「立即发送（先停止当前任务）」
 *
 * 界面那三条（改做法 / 类别筛选 / 简洁视图点名）在 `201-experience-leftovers-ui.mjs`
 * —— 按「改的是谁」拆的，不是按行数硬切。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as nodeJoin } from 'node:path'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'

import { check, group } from '../harness.mjs'
import { ROOT, join } from '../env.mjs'

/** 与 198 同一套：动态 import 必须给 file:// URL（Windows 上直接给 E:\… 会报错） */
async function loadSelectors() {
  return import(pathToFileURL(join(ROOT, 'tools/shot/ui-selectors.mjs')).href)
}

/** 造一个假页面（只实现表达式用到的那几个成员） */
function fakePage(names, clicks) {
  const buttons = names.map((name) => ({
    getAttribute: (attr) => (attr === 'aria-label' ? name : null),
    textContent: '',
    title: '',
    click: () => clicks.push(name),
  }))
  return { document: { querySelectorAll: () => buttons } }
}

export async function run() {
  const { STOP_LABELS, STOP, RUNNING, SEND, pickExactLabel } = await loadSelectors()

  /* ══════════════════════════════════════════════════════════
     ① 遗留 7：串行执行器也必须接经验入口
     ══════════════════════════════════════════════════════════ */
  group('经验遗留 / ① 串行执行器接了经验观察入口')

  const loopTools = readFileSync(join(ROOT, 'electron/core/loop-tools.cjs'), 'utf8')
  const runner = readFileSync(join(ROOT, 'electron/core/tool-runner.cjs'), 'utf8')
  check(
    '★ 复刻旧洞：以前串行那份里一个 experience 都没有',
    !/experience/.test(''),
    '（这条只是把前提写下来：改之前 loop-tools.cjs 里 grep 不到 experience）',
  )
  check(
    '★★ 现在串行执行器调的是**同一个入口** experience.afterRun',
    /experience\.afterRun\(/.test(loopTools),
    '没接的话，切回串行就等于经验层静默失效',
  )
  check(
    '★★ 两份执行器用的是**同名模块**（不是各 require 一个不同的东西）',
    /require\('\.\/experience-loop\.cjs'\)/.test(loopTools) &&
      /require\('\.\/experience-loop\.cjs'\)/.test(runner),
    '一个走 experience-loop、一个走别处，迟早两套判据',
  )
  check(
    '★ 串行那份也把 learned.note 拼进了模型看得到的那段',
    /learned\.note/.test(loopTools),
    '接了口不放话，模型仍然看不到「上次这样修好的」',
  )
  check(
    '★ 传进去的上下文与并行版一致（projectId / sessionId / workdir）',
    /projectId:\s*ctx\?\.projectId/.test(loopTools) &&
      /sessionId:\s*ctx\?\.sessionId/.test(loopTools) &&
      /workdir:\s*ctx\?\.workdir/.test(loopTools),
    '少一个，验证器的「同项目」判据就退化了',
  )

  /* ══════════════════════════════════════════════════════════
     ② 遗留 9：systemCode 不再恒为 null
     ══════════════════════════════════════════════════════════ */
  group('经验遗留 / ② 系统错误码真的带回来了（不再是常数 null）')

  const failure = await import(pathToFileURL(join(ROOT, 'electron/core/tool-failure.cjs')).href)
  const shellSrc = readFileSync(join(ROOT, 'electron/core/tools/run_shell.cjs'), 'utf8')
  check(
    '★ 复刻旧洞：跑不起来的命令，退出码必须是 null（不能拿 -1 冒充）',
    failure.of({ toolName: 'run_shell', ok: false, output: 'x', systemCode: 'ENOENT' }).exitCode === null,
    'exitCode 与 systemCode 是两件事',
  )
  const enoent = failure.of({ toolName: 'run_shell', ok: false, output: 'x', systemCode: 'ENOENT' })
  check('★★ ENOENT 原样带回来了（以前恒为 null）', enoent.systemCode === 'ENOENT', String(enoent.systemCode))
  /*
   * 原因码不许被它带歪：**分类说「非零退出」但根本没有退出码**时只能是 TOOL_ERROR，
   * 不能是 EXIT_CODE（那是把「没跑起来」说成「跑了但失败」，人会去翻一段不存在的输出）。
   * 带 `kind` 才是生产路径的真形状（`outcomeOf` 总会把分类递进来）。
   */
  const enoentWithKind = failure.of({
    toolName: 'run_shell',
    ok: false,
    output: 'x',
    systemCode: 'ENOENT',
    kind: 'process_exit',
  })
  check(
    '★ 原因码没被它带歪：命令没跑起来 ⇒ TOOL_ERROR，不是 EXIT_CODE',
    enoentWithKind.reasonCode === 'TOOL_ERROR',
    enoentWithKind.reasonCode,
  )
  check(
    '★ 连分类都没有时也不谎称「跑了但失败」（是 UNKNOWN，不是 EXIT_CODE）',
    enoent.reasonCode !== 'EXIT_CODE',
    enoent.reasonCode,
  )
  check(
    '★ 形状非法的不许进库（形状校验只有一处）',
    failure.of({ toolName: 'run_shell', ok: false, output: 'x', systemCode: 'bad code!' }).systemCode === null,
  )
  check(
    '★ factsOf 白名单里有 systemCode（否则它到不了事件与台账）',
    failure.factsOf({ systemCode: 'EACCES' }).systemCode === 'EACCES',
    JSON.stringify(failure.factsOf({ systemCode: 'EACCES' })),
  )
  check(
    '★ 非字符串的 truthy 值一律不带（不让内部结构漏出去）',
    failure.factsOf({ systemCode: 123 }).systemCode === undefined,
  )
  check(
    '★★ run_shell 真的把 error.code 的字符串分支递上去了',
    /typeof rawCode === 'string' \? \{ systemCode: rawCode \}/.test(shellSrc),
    '没有这一句，systemCode 仍然是常数 null',
  )
  check(
    '★ 成功那次也没有这个键（成功没有失败事实）',
    failure.of({ toolName: 'run_shell', ok: true, output: 'ok' }) === null,
  )

  /* ══════════════════════════════════════════════════════════
     ③ 遗留 11：读盘缓存 —— 生效、且不许脏
     ══════════════════════════════════════════════════════════ */
  group('经验遗留 / ③ 每次工具调用不再都读一次盘（且缓存不许脏）')

  const storeFile = await import(pathToFileURL(join(ROOT, 'electron/core/experience-store-file.cjs')).href)
  const before = storeFile.readCount()
  storeFile.load()
  const firstRead = storeFile.readCount()
  storeFile.load()
  storeFile.load()
  const afterTwo = storeFile.readCount()
  check('★ 第一次读真的读了盘（计数器在动）', firstRead >= before, `${before} → ${firstRead}`)
  check(
    '★★ 紧接着两次 load **一次盘都没读**（缓存命中）',
    afterTwo === firstRead,
    `${firstRead} → ${afterTwo}`,
  )
  const shared = storeFile.load()
  check(
    '★★ 每次 load 给的是**新对象**（缓存的是文本，不是解析结果）',
    storeFile.load() !== shared && storeFile.load().items !== shared.items,
    '缓存对象会让上一次调用的就地修改污染下一次读',
  )
  /* 外部改写文件 ⇒ 下一次 load 必须看得见（否则「刚写的看不到」那种鬼故事又来了） */
  const original = readFileSync(storeFile.filePath(), 'utf8')
  try {
    const dir = mkdtempSync(nodeJoin(tmpdir(), 'exp-cache-'))
    check('★ 临时目录建好了（这条只是排除环境问题）', dir.length > 0)
    writeFileSync(
      storeFile.filePath(),
      JSON.stringify({ version: 1, items: [{ id: 'x', triggerText: '外部写入的一条' }] }),
      'utf8',
    )
    const seen = storeFile.load()
    check(
      '★★ 盘上被外部改过之后，load 立刻看得到（缓存按 mtime:size 失效）',
      seen.items.some((item) => item.id === 'x'),
      JSON.stringify(seen.items.map((item) => item.id)),
    )
    rmSync(dir, { recursive: true, force: true })
  } finally {
    writeFileSync(storeFile.filePath(), original, 'utf8')
  }

  /* ══════════════════════════════════════════════════════════
     ④ 遗留 1/13：停止 / 发送也是「包含匹配」，会点错按钮
     ══════════════════════════════════════════════════════════ */
  group('经验遗留 / ④ 「停止」不许再用包含匹配（会点中「立即发送」）')

  const realButtons = ['立即发送（先停止当前任务）', '停止生成']
  const oldHit = realButtons.find((name) => /停止/.test(name))
  check(
    '★ 复刻旧洞：/停止/ 先撞上的是「立即发送（先停止当前任务）」',
    oldHit === '立即发送（先停止当前任务）',
    String(oldHit),
  )
  check(
    '★★ 现在的名单只认「停止生成」',
    pickExactLabel(realButtons, STOP_LABELS) === '停止生成',
    String(pickExactLabel(realButtons, STOP_LABELS)),
  )
  const clicks = []
  const hit = runInNewContext(STOP, fakePage(realButtons, clicks))
  check('★★ 表达式真跑：点到的是「停止生成」', hit === true && clicks.join('|') === '停止生成', JSON.stringify(clicks))
  const onlyImmediate = []
  const miss = runInNewContext(STOP, fakePage(['立即发送（先停止当前任务）'], onlyImmediate))
  check(
    '★★ 只有「立即发送…」时一次都不点（当前是 `false`，不是「假装还在跑」）',
    miss === false && onlyImmediate.length === 0,
    JSON.stringify({ miss, onlyImmediate }),
  )
  const running = runInNewContext(RUNNING, fakePage(['立即发送（先停止当前任务）'], []))
  check(
    '★★ 「还在跑吗」不会被「立即发送…」骗成 true（旧写法会）',
    running === false,
    String(running),
  )
  const sendClicks = []
  runInNewContext(SEND, fakePage(['立即发送（先停止当前任务）', '发送消息'], sendClicks))
  check('★ 发送 likewise 只点是「发送消息」', sendClicks.join('|') === '发送消息', JSON.stringify(sendClicks))

  /* 脚本层面：acceptance 与所有 e2e 不许再自己拼 /停止/ 或 /发送消息/ */
  const acceptance = readFileSync(join(ROOT, 'tools/acceptance.mjs'), 'utf8')
  check(
    '★★ acceptance.mjs 不再自己写 /停止/ 正则',
    !/re=\/停止\//.test(acceptance) && !/const re = \/停止\//.test(acceptance),
    '仍然是「按名字猜」',
  )
  check(
    '★★ acceptance.mjs 的「还在跑」走 RUNNING（同一条判据）',
    /ev\(RUNNING\)/.test(acceptance),
    '自己再写一份 → 两处口径',
  )
  /* ══════════════════════════════════════════════════════════
     ⑤ 这一轮碰过的内核/工具文件都没有超红线
     ══════════════════════════════════════════════════════════ */
  group('经验遗留 / ⑤ 这一轮碰过的内核与工具文件都没有超红线')

  const touched = [
    'electron/core/experience-approve.cjs',
    'electron/core/experience-store-file.cjs',
    'electron/core/tool-failure.cjs',
    'electron/core/tool-failure-reason.cjs',
    'electron/core/loop-tools.cjs',
    'electron/core/tools/run_shell.cjs',
    'tools/shot/ui-selectors.mjs',
    'tools/acceptance.mjs',
    'tools/live-probe.mjs',
  ]
  const over = touched
    .map((rel) => ({ rel, lines: readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/).length }))
    .filter((entry) => entry.lines > 300)
  check('★★ 全部 ≤ 300 行', over.length === 0, over.map((o) => o.rel + '=' + o.lines).join(', '))
}

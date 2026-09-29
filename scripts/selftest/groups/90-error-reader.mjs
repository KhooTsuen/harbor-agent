import { readdirSync, readFileSync, statSync } from 'node:fs'
import { check, group } from '../harness.mjs'
import { ROOT, join, mkdirSync, rmSync, writeFileSync, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   错误清单：读取器 + 保留期（阶段 2）

   阶段 1 解决的是「内核把错误记下来」，这一组守的是**读出来那一侧**：
   界面（右栏「错误」标签）走 `errors:list` → 内核 `error-reader.cjs`。

   三件必须守的：
     ① **只读** —— 读取器一个写操作都不许有（清理由保留期模块单独做）
     ② **规则只有一份** —— 严重性/去重/合并/措辞都在内核 `error-rules.cjs`；
        这条是**本仓库返工最多的一类问题**，所以直接读源码钉住
     ③ 保留期**只删自己写的文件**，而且永远留最新那个（别清到空）

   数据都在 tmp 下的临时目录里造，不碰用户真实数据。
   ══════════════════════════════════════════════════════════════ */

const TMP = join(ROOT, 'tmp', 'selftest-error-reader')

/** 造一行观察哨格式的记录 */
function line(over = {}) {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'unknown',
    source: 'ipc',
    message: '出错了',
    raw: '',
    location: 'chat:send',
    needsUser: false,
    retryable: false,
    hint: '',
    tool: '',
    taskId: '',
    sessionId: '',
    repeat: 1,
    ...over,
  })}\n`
}

export async function run() {
  group('可靠性 / 错误清单读取器与保留期')

  const reader = require(join(ROOT, 'electron/core/error-reader.cjs'))
  const retention = require(join(ROOT, 'electron/core/error-retention.cjs'))
  const ruleCore = require(join(ROOT, 'electron/core/error-rules.cjs'))

  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  /* ── ① 没有文件 = 「还没出过错」，不是故障 ── */
  const empty = reader.read({ dir: TMP })
  check(
    '目录空时返回 ok + 空清单（不是报错）',
    empty.ok === true && empty.entries.length === 0 && empty.stats.files === 0,
    JSON.stringify(empty.stats),
  )

  /* ── ② 真读：分类采信文件里的 kind、严重性按内核口径、repeat 折回次数 ── */
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const name = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.jsonl`
  writeFileSync(
    join(TMP, name),
    line({ kind: 'auth', message: '登录失败：401', repeat: 3, needsUser: true }) +
      line({ kind: 'network', message: 'fetch failed', location: 'chat:stream', retryable: true }) +
      line({ kind: 'unknown', message: '认不出的那种错' }) +
      'not-json\n' +
      '\n',
    'utf8',
  )

  const result = reader.read({ dir: TMP })
  const byKind = (k) => result.entries.find((e) => e.kind === k)
  check('读到了 3 种（合并后）', result.entries.length === 3, `${result.entries.length} 种`)
  check(
    '★ 采信文件里已分类的 kind（不在读取侧重猜）',
    byKind('auth')?.kind === 'auth' && byKind('network')?.kind === 'network',
    result.entries.map((e) => e.kind).join(','),
  )
  check(
    '★ repeat 折回次数（auth 报了 3 次算 3 次，不是 1 次）',
    Number(byKind('auth')?.count) === 3,
    `count=${byKind('auth')?.count}`,
  )
  check(
    '★ 严重性用内核口径：auth+等用户处理=P0、network=P2、unknown=P3（不是 P0）',
    byKind('auth')?.severity === 'P0' && byKind('network')?.severity === 'P2' && byKind('unknown')?.severity === 'P3',
    result.entries.map((e) => `${e.kind}:${e.severity}`).join(' '),
  )
  check(
    '★ unknown 永不升到 P0（「分类器认不出」不等于「用不了」）',
    ruleCore.severityOf('unknown', { needsUser: true }) === 'P3' &&
      ruleCore.severityOf('auth') === 'P1' &&
      ruleCore.severityOf('auth', { needsUser: true }) === 'P0',
    `unknown=${ruleCore.severityOf('unknown', { needsUser: true })} auth=${ruleCore.severityOf('auth')}`,
  )
  check(
    '位置是可查坐标（origin:地点）',
    byKind('auth')?.location === 'ipc:chat:send' && byKind('network')?.location === 'ipc:chat:stream',
    byKind('auth')?.location,
  )
  check('坏行单独计数，不影响别的行', result.stats.badLines === 1 && result.stats.lines === 4, `bad=${result.stats.badLines} lines=${result.stats.lines}`)
  check('P0 排在最前面（人要先看到能用的那个）', result.entries[0]?.severity === 'P0', result.entries[0]?.severity)

  /* ── ③ 只读：跑一遍读取器不许新增/修改任何文件 ── */
  const before = readdirSync(TMP).map((f) => `${f}:${statSync(join(TMP, f)).mtimeMs}`)
  reader.read({ dir: TMP })
  const after = readdirSync(TMP).map((f) => `${f}:${statSync(join(TMP, f)).mtimeMs}`)
  check('★ 读取器只读：文件与修改时间一个都没变', before.join('|') === after.join('|'), after.join(' '))

  /* ── ④ 保留期：只删过期的那几个，永远留最新，别的文件一律不碰 ── */
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const old = '2020-01-01.jsonl'
  const mid = '2020-01-02.jsonl'
  const newest = '2020-01-03.jsonl' /* 比保留期老得多 —— 但不许删（不然一打开发现历史空了） */
  const other = 'keep-me.txt'
  for (const f of [old, mid, newest, other]) writeFileSync(join(TMP, f), line(), 'utf8')

  const pruned = retention.prune({ dir: TMP, days: 30 })
  const left = readdirSync(TMP).sort()
  check(
    '★ 保留了最新那个（哪怕它比保留期还老）',
    left.includes(newest),
    left.join(' '),
  )
  check('删掉了过期的', pruned.removed.includes(old) && pruned.removed.includes(mid), pruned.removed.join(' '))
  check(
    '★ 非自己写的文件一律不碰（用户放别的东西是他的自由）',
    left.includes(other),
    left.join(' '),
  )
  check(
    '删了几个有据可查（返回值里带名字）',
    pruned.ok === true && pruned.removed.length === 2,
    JSON.stringify(pruned),
  )
  check('保留期默认 30 天', retention.KEEP_DAYS === 30, String(retention.KEEP_DAYS))

  rmSync(TMP, { recursive: true, force: true })

  /* ── ⑤ 规则只有一份（本仓库返工最多的一类问题，直接读源码钉住） ── */
  const scriptsSeverity = readFileSync(join(ROOT, 'scripts/errors/severity.mjs'), 'utf8')
  const scriptsRender = readFileSync(join(ROOT, 'scripts/errors/render.mjs'), 'utf8')
  const kernelRules = readFileSync(join(ROOT, 'electron/core/error-rules.cjs'), 'utf8')
  check(
    '★ 严重性规则只在内核定义一次（scripts 那边只是转发，没有把规则表又拄一份）',
    kernelRules.includes('function severityOf') &&
      scriptsSeverity.includes('kernelRules.severityOf') &&
      !scriptsSeverity.includes('P1_KINDS') &&
      !scriptsSeverity.includes('MESSAGE_HINTS'),
    'scripts/errors/severity.mjs 里又把规则表（P1_KINDS / MESSAGE_HINTS）拄了一份',
  )
  check(
    '★ 严重性措辞也只有一份（命令行和界面用同一批词）',
    scriptsRender.includes('SEVERITY_LABEL as SEV_LABEL') && !scriptsRender.includes("P0: 'P0 阻塞"),
    'render.mjs 里又写了一份措辞表',
  )
  check(
    '★ 读取器不含写操作（只读铁律）',
    !/writeFileSync|unlinkSync|appendFileSync|mkdirSync/.test(readFileSync(join(ROOT, 'electron/core/error-reader.cjs'), 'utf8')),
    'error-reader.cjs 里出现了写/删文件',
  )
  check(
    '★ 观察哨启动时接上了保留期',
    readFileSync(join(ROOT, 'electron/core/error-observer.cjs'), 'utf8').includes('retention.prune('),
    'install() 里没调 prune —— 错误记录会无限长大',
  )
}

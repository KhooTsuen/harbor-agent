import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   日志可查性

   这三条都是「查一个 bug 被日志坑过」才加的：

   ① 时间戳写 UTC → 我把他**今天凌晨 01:12** 的操作看成「昨天 17:12」，
      差点把当天的账当成隔夜旧账排除掉。现在带本地时区偏移。
   ② 日志里**没有会话/任务短码** → 同时跑着两条对话时，只能靠时间戳把几行凑一起。
   ③ 日志里**不写「这一轮是谁起的」** → 我看到「又跑了一轮」，完全不知道是
      切版本、自动重试、还是用户自己发的 —— 这个 bug 查了四轮。
      现在有一行 `新一轮：来源=…`。
   ══════════════════════════════════════════════════════════════ */

const log = require(join(ROOT, 'electron/core/log.cjs'))
const logSrc = readFileSync(join(ROOT, 'electron/core/log.cjs'), 'utf8')

export async function run() {
  /* ── ① 时间戳带本地时区 ─────────────────────────────────── */
  group('日志 / 时间戳要说清「这是本地几点」')
  const stamp = log.formatStamp(new Date(2026, 8, 23, 1, 12, 9, 805))
  check(
    '★ 形如 2026-09-23T01:12:09.805+08:00（带偏移，不再需要心算）',
    /^2026-09-23T01:12:09\.805[+-]\d{2}:\d{2}$/.test(stamp),
    stamp,
  )
  check('★ 不含 Z（那是 UTC，之前就是被它坑的）', !stamp.endsWith('Z'))
  check('毫秒是 3 位（不会少写）', stamp.includes('.805'), stamp)
  const offset = Number(stamp.slice(-6, -3))
  check(
    '偏移和运行环境一致（换时区也没写死）',
    offset === -new Date(2026, 8, 23).getTimezoneOffset() / 60,
    `${offset} vs ${-new Date(2026, 8, 23).getTimezoneOffset() / 60}`,
  )

  /* ── ② 短码 ────────────────────────────────────────────── */
  group('日志 / id 只留够用的短码')
  check(
    '长 id 取末 6 位',
    log.shortId('sess_mucxm1b4ahcnd') === '4ahcnd',
    log.shortId('sess_mucxm1b4ahcnd'),
  )
  check('本来就短的不动', log.shortId('abc') === 'abc')
  check('空值不炸', log.shortId(undefined) === '')

  /* ── ③ tagged：同一件事的几行带同一个前缀 ──────────────── */
  group('日志 / tagged 给一组日志加前缀')
  const seen = []
  const fake = { info: (m) => seen.push(m) }
  const here = log.tagged('sess…4ahcnd · b4ah')
  check(
    'tagged 返回 info/warn/error 三个方法',
    ['info', 'warn', 'error'].every((k) => typeof here[k] === 'function'),
  )
  check('tagged 的前缀进的是正文（格式不变）', typeof fake.info === 'function')
  /* 前缀格式固定成 `[tag] ` —— 我会拿它 grep，改了就说明得一起改文档 */
  check('前缀格式：`[tag] `', logSrc.includes("const prefix = tag ? `[${tag}] ` : ''"))

  /* ── ④ 源码守位：这几行不许被改回去 ─────────────────────── */
  group('日志 / 接线守位')
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check(
    '★ 每轮开头说清「来源」（查问题时第一个要回答的问题）',
    chatSrc.includes('新一轮：来源=${reason}'),
  )
  check('★ 收尾带用时（不然看不出这一轮跑了多久）', chatSrc.includes('用时 ${spent} 秒'))
  check('中止和失败分开记', chatSrc.includes('对话中止（用户按了停止 / 切走了）'))
  check('短码用在热路径上', chatSrc.includes('log.tagged(`sess…'))

  /*
   * ★ 顺序守卫：这一行用了 history / mode / workdir，必须在它们声明之后。
   *   我第一版放在函数开头 —— TDZ，chat:send 直接抛 ReferenceError，
   *   消息发不出去、日志一个字都没有（真机探针逮到的）。
   */
  check(
    '★ 「新一轮」那行在 history / workdir 之后（早一行就是 TDZ，消息发不出去）',
    chatSrc.indexOf('新一轮：来源=') > chatSrc.indexOf('const workdir ='),
  )

  const llmSrc = readFileSync(join(ROOT, 'electron/core/llm.cjs'), 'utf8')
  check(
    '★ 模型请求行带用途标签（对话轮次 vs 场景调用要分得开）',
    llmSrc.includes("请求模型${label ? `[${label}]` : ''}"),
  )
  const sceneSrc = readFileSync(join(ROOT, 'electron/core/scene.cjs'), 'utf8')
  check('场景调用自己标出来', sceneSrc.includes('label: `场景 ${sceneId}`'))
  const modelSrc = readFileSync(join(ROOT, 'electron/core/loop-model.cjs'), 'utf8')
  check('对话轮次标成「对话 <短码>」', modelSrc.includes('label: `对话 ${log.shortId('))
  check('复核单独标', modelSrc.includes("label: '复核'"))

  /* ── ⑤ 渲染层真的把来源传下去了 ────────────────────────── */
  group('日志 / 渲染层带来源')
  const turnsSrc = readFileSync(join(ROOT, 'src/stores/thread/turns.ts'), 'utf8')
  check(
    'sendChat 会把 reason 发给主进程',
    turnsSrc.includes('...(opts.reason ? { reason: opts.reason } : {})'),
  )
  const mvSrc = readFileSync(join(ROOT, 'src/stores/thread/messageVersions.ts'), 'utf8')
  check(
    '编辑 / 重新生成 / 补一版回答各自标注（切版本本身不跑，没有「切提问版本」这一说）',
    ['编辑后重答', '重新生成', '补一版回答'].every((r) => mvSrc.includes(r)),
  )
  const storeSrc = readFileSync(join(ROOT, 'src/stores/useThreadStore.ts'), 'utf8')
  check('点「继续」和用户发送分得开', storeSrc.includes("resumeTaskId ? '点继续' : '用户发送'"))

  /* ── ⑥ 日志仍然过脱敏（别为了好查把密钥写进去）─────────── */
  group('日志 / 该脱敏的还是要脱敏')
  check('唯一写入口仍然过 redact', logSrc.includes("redact(String(message ?? ''))"))
  check(
    'tagged 也走同一个 write（不会绕开脱敏）',
    logSrc.includes('const prefix = tag ?') && logSrc.includes("write('INFO', prefix + msg)"),
  )
}

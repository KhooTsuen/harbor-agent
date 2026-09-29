import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { check, group } from '../harness.mjs'
import { ROOT, join, readFileSync, mkdirSync, rmSync, existsSync, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   错误观察哨（`electron/core/error-observer.cjs`）

   它挂在 catch 块里，所以「自己会不会抛」比「记不记得全」重要得多；
   另外它有两个**只能在这儿守**的点：

   · **自检不能往里写** —— 内核自检会故意造几百个错，要是观察哨在自检里也开着，
     等于往用户真实数据目录灌假错误（`data/logs` 已经被这么污染过一次）。
     这一组全程用 tmp 下的临时目录，最后一条还专门验「不装就一条都不写」。

   · **定时器不能拦住进程退出** —— 定时器是 unref 的，但这件事**测试照不到**：
     一旦哪天有人忘了 unref，表现是「自检卡住不动」，而且是在别人的机器上卡住。
     所以这里**真起一个子进程**跑一遍，看它会不会自己退出。

   还有一组**源码钉子**：`record()` 焊在哪几个 catch 里。层与层的接线测试照不到
   （docs/踩坑记录.md 那两个坑就是这么来的），所以直接读源码点名 ——
   哪天谁把那行删了，这一组立刻红。
   ══════════════════════════════════════════════════════════════ */

const TMP = join(ROOT, 'tmp', 'selftest-error-observer')
/* 观察哨写 `<dir>/<日期>.jsonl`，而扫描器读 `<dataDir>/errors/` —— 这里就按真机布局建 */
const DIR = join(TMP, 'errors')

export async function run() {
  group('可靠性 / 错误观察哨')

  const observer = require(join(ROOT, 'electron/core/error-observer.cjs'))
  const redact = require(join(ROOT, 'electron/core/redact.cjs'))
  const kernelErrors = require(join(ROOT, 'electron/core/errors.cjs'))

  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  /* ── ① 不装 = 一条都不写（自检期就是这个状态） ── */
  observer.record(new Error('没装就不该被记下来'))
  check(
    '★ 没 install 时 record 一条都不写（自检因此不会污染真实数据目录）',
    observer.stats().recorded === 0 && !existsSync(DIR),
    `recorded=${observer.stats().recorded}`,
  )

  /* ── ② install 之后真写盘 ── */
  const installed = observer.install({ dir: DIR })
  check('install 后拿到落点', installed.ok && installed.dir === DIR, JSON.stringify(installed))

  const SECRET = 'sk-selftest-0123456789abcdef'
  /*
   * 关键：**不带标签** 登记。带了标签的话替换出来的是 `***自检密钥***`，
   * 而噪音规则里有 `/自检/`、`/探针/` —— 那几行会被自己判成噪音，测试白跑。
   */
  redact.remember(SECRET)
  /* 消息里也避开「自检 / 探针」字样，同上原因（见 errors/noise.mjs 的 SELFTEST_TEXT） */
  observer.record(new Error(`连接被拒绝：ECONNREFUSED 127.0.0.1:9  key=${SECRET}`), {
    source: 'ipc',
    location: 'chat:send',
  })
  const written = observer.flush()
  /* 文件名按**本地日期**算（观察哨用的就是本地日期；用 UTC 的话凌晨 0-8 点会间歇性红） */
  const name = readdirSync(DIR).find((f) => f.endsWith('.jsonl'))
  const file = name ? join(DIR, name) : ''
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  let first = null
  try {
    first = JSON.parse(text.trim().split('\n')[0])
  } catch {
    first = null
  }

  check('flush 落到 data 下的当天 jsonl', written === 1 && text.trim().split('\n').length === 1, `写了 ${written} 条，文件 ${name}`)
  check('记录了来源与位置', first?.source === 'ipc' && first?.location === 'chat:send', JSON.stringify([first?.source, first?.location]))
  check(
    '★ 落盘前过脱敏（密钥不落盘）',
    !text.includes(SECRET) && text.includes('已隐藏'),
    text.includes(SECRET) ? '文件里出现了明文密钥' : '已替换成 ***已隐藏***',
  )
  check(
    'kind 来自内核分类器（不另写一套）',
    first?.kind === kernelErrors.classify(new Error('ECONNREFUSED 127.0.0.1:9')).kind,
    `文件里是 ${first?.kind}`,
  )

  /* ── ③ 同一个错刷很多次：折成幂次行，不丢「它还在发生」这件事 ── */
  for (let i = 0; i < 7; i++) observer.record(new Error('一模一样的错'), { source: 'tool', location: 'run_shell' })
  observer.flush()
  const repeats = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.message === '一模一样的错')
  check(
    '★ 同一签名重复 8 次只落 3 行（repeat 1/2/4）',
    repeats.length === 3 && repeats.map((e) => e.repeat).join(',') === '1,2,4',
    `${repeats.length} 行，repeat=${repeats.map((e) => e.repeat).join('/')}`,
  )

  /* ── ④ 挂在 catch 里，自己绝不能抛 ── */
  let thrown = null
  try {
    observer.record(undefined)
    observer.record(null, { source: 123 })
    observer.record(new Error('x'.repeat(4000)), { raw: {}, location: 'y' })
    const circular = {}
    circular.self = circular
    observer.record(circular, { source: 'z', location: circular })
  } catch (error) {
    thrown = error
  }
  check('★ 畸形输入不抛异常（它自己抛会把原始错误盖掉）', thrown === null, thrown ? String(thrown) : '')

  const before = observer.stats().failed
  observer.dispose()
  observer.record(new Error('dispose 之后这条不该写'))
  check('dispose 后关闸', observer.flush() === 0 && observer.stats().enabled === false, `failed=${before}`)

  /* ── ⑤ 真起子进程：定时器不能拦住它退出（否则自检会「卡住不动」） ── */
  const probe = [
    `const o = require(${JSON.stringify(join(ROOT, 'electron/core/error-observer.cjs'))})`,
    `o.install({ dir: ${JSON.stringify(DIR)} })`,
    `o.record(new Error('子进程里记一条'))`,
    `process.stdout.write('done')`,
  ].join(';')
  const child = spawnSync(process.execPath, ['-e', probe], { timeout: 15_000, encoding: 'utf8' })
  check(
    '★ 装了观察哨的进程也能自己退出（定时器 unref + exit 前落盘）',
    child.status === 0 && child.stdout === 'done' && !child.error,
    `status=${child.status} stdout=${JSON.stringify(child.stdout)} err=${child.error?.code ?? ''}`,
  )

  /* ── ⑥ 源码钉子：record() 焊在哪几个 catch 里（层间接线，测试照不到） ── */
  const src = (p) => readFileSync(join(ROOT, p), 'utf8')
  const sites = [
    ['electron/register-handlers.cjs', "observer.record(error, { source: 'ipc'", 'IPC 通道兜底（139 个通道一处覆盖）'],
    ['electron/core/tool-runner.cjs', "source: 'tool'", '工具失败'],
    ['electron/core/loop-model.cjs', "source: 'model'", '模型调用失败'],
    ['electron/core/mcp.cjs', "source: 'mcp'", 'MCP 服务器起不来'],
    ['electron/core/pty.cjs', "source: 'pty'", '终端开不起来'],
  ]
  for (const [file, needle, label] of sites) {
    check(`接线还在：${label}`, src(file).includes(needle), `${file} 里没找到 ${needle}`)
  }

  const mainSrc = src('electron/main.cjs')
  check(
    '★ 主进程只在非 headless 模式装观察哨',
    /if \(!HEADLESS\) require\(.*error-observer\.cjs.*\)\.install\(\)/.test(mainSrc),
    '没找到守卫 —— 那样 --self-test 会把假错误写进用户数据',
  )

  /*
   * ★ 这条是**真踩过**才加的：第一次接线时 `loop-model.cjs` 里写了 `observer.record(...)`
   * 但忘了 require，自检里直接 `observer is not defined` —— 报错还被外层 catch 包成
   * 「任务没跑完」，看着像别的问题。凡是「用了就必须先 require」的东西，都容易漏一个。
   * 所以这里扫全 `electron/`，不允许再出现「用了没引入」。
   */
  const users = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.cjs')) users.push(full)
    }
  }
  walk(join(ROOT, 'electron'))
  const bad = users
    .filter((f) => readFileSync(f, 'utf8').includes('observer.record('))
    .filter((f) => !readFileSync(f, 'utf8').includes('error-observer.cjs'))
  check(
    '★ 每个用 observer.record 的内核文件都 require 了它（漏了就 ReferenceError）',
    bad.length === 0,
    bad.map((f) => f.replace(`${ROOT}\\`, '')).join('、'),
  )

  /* ── ⑦ 读取侧认得出观察哨写的东西 ── */
  try {
    const { scan } = await import('../../scan-errors.mjs')
    const result = scan({ dataDir: TMP, since: 0 })
    const found = (result.entries ?? []).filter((e) => e.source === 'observer')
    check('读取侧（scripts/errors.mjs）能扫到观察哨的输出', result.ok === true && found.length > 0, `扫到 ${found.length} 条`)
    const dup = found.find((e) => e.message === '一模一样的错')
    check('重复计数在聚合时被折回次数', Number(dup?.count) === 7, `count=${dup?.count}（期望 7 = 循环里报了 7 次）`)
  } catch (error) {
    check('读取侧（scripts/errors.mjs）能扫到观察哨的输出', false, String(error?.message ?? error))
  }

  rmSync(TMP, { recursive: true, force: true })
}

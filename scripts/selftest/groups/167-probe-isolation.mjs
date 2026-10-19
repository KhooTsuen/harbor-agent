import { join, ROOT, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   探针隔离：tmp/ 下的临时脚本**默认不许**写正式数据根

   ── 为什么单列一组（2026-10-17 的真实污染）────────────────────
   `tmp/` 下的纯 Node 探针两个隔离条件都不满足：入口不是
   `scripts/selftest.mjs`，也没人替它设 `HARBOR_UNIT_TEST`。于是
   `DIRS.data` 解析成**源码开发版的数据根**，探针的审计直接追加进
   `data/audit/2026-10-17.jsonl` —— 当天实测多出 9 条 b1-selftest 记录，
   把历史审计污染了。

   当时的兜底是「探针自己记得 require('./_iso.cjs')」，结果**写那个兜底的人
   自己漏用了**。所以判据挪进 `paths.cjs` 的 `isProbeRun()`：**位置**本身
   就是信号，不依赖人的记性。

   本组钉的就是这条：判据在、且真的生效；同时**不能误伤**真正该走真目录的
   两种情况（自检 / 单测各有自己的隔离名）。
   ══════════════════════════════════════════════════════════════ */

export function run() {
  group('探针隔离 / tmp 下的脚本默认走隔离数据根')
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))

  check('★ paths 导出了 isProbeRun（判据只有一处）', typeof paths.isProbeRun === 'function')

  /*
   * 自检进程自己的入口是 scripts/selftest.mjs → 不该被当成探针。
   * 这条同时保证「加了 isProbeRun 之后，自检的数据根没有被改道」。
   */
  check('★★ 自检进程自己不算探针（数据根仍是 selftest-data）', paths.isProbeRun() === false, `data=${paths.DIRS.data}`)
  check(
    '★★ 自检的数据根仍是 data/selftest-data',
    paths.DIRS.data.toLowerCase().endsWith(join('data', 'selftest-data').toLowerCase()),
    paths.DIRS.data,
  )

  /* 判据读的是入口脚本路径 —— 用假的 argv 直接喂，不必真去造一个探针进程 */
  const realArgv = process.argv
  const probe = (entry) => {
    process.argv = [realArgv[0], entry]
    try {
      return paths.isProbeRun()
    } finally {
      process.argv = realArgv
    }
  }

  check('★★★ tmp/ 下的 .cjs 被认出是探针', probe(join(ROOT, 'tmp', '_whatever.cjs')) === true)
  check('★★★ tmp/ 子目录里的也算', probe(join(ROOT, 'tmp', 'some-round', 'probe.mjs')) === true)
  check('★ tmp-evil/ 不算（前缀不能靠字符串半截蒙混）', probe(join(ROOT, 'tmp-evil', 'x.cjs')) === false)
  check('★ scripts/ 下的不算', probe(join(ROOT, 'scripts', 'foo.mjs')) === false)
  check('★ 没有 argv[1] 时不抛、也不算探针', probe('') === false)

  /*
   * 关键的一条：隔离名判据（`isolationDirName`）没有单独导出，所以这里
   * 直接钉**它的外部可观测后果** —— 只要 isProbeRun 为真，dataDir 就必须
   * 落在 unit-test-data。用源码文本确认那条接线还在（防止有人把分支删了
   * 却留下一个永远返回 true 的 isProbeRun）。
   */
  const src = require('node:fs').readFileSync(join(ROOT, 'electron/core/paths.cjs'), 'utf8')
  check(
    '★★★ isProbeRun 真的接在 isolationDirName 上（不是留个空函数）',
    /if \(isProbeRun\(\)\) return 'unit-test-data'/.test(src),
  )
  check('★★ 打包版仍然优先走真目录（那几个分支对它无效）', /if \(packaged\) return null/.test(src))
}

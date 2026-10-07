/**
 * 规模闸门 · P4-1：逃出工作目录的递归/批量，按**目标实际规模**判，不按命令形态。
 *
 * 为什么单开一组（不动 `108-scale-gate.mjs`）：那组已经 298 行，贴 300 红线（硬约束 2）。
 *
 * 缺口原话在 `docs/improvement-checklist.md` P4-1（2026-10-03 记的）：
 * 「Agent 要清理 2 个临时文件 + 列一层目录，被规模闸门拦下要求确认」——
 * 判据是命令**长得像不像**（看到 `-Recurse` 就拦），不管它实际动多大。
 *
 * 修法（2026-10-07，用户批准改权限行为 · 硬禁区 10）：
 *   · 探得到目标且不大（< `scaleMaxFiles`）→ 不拦（降 note）；
 *   · 探得到但很大 → 照旧拦；
 *   · 探不到（环境变量 / 盘根 / glob / 没权限）→ **照旧拦**（不知道就别放行，保守方向）。
 *
 * ⚠️ 判据的形状（硬约束 9）：**探测器用替身**喂「小 / 大 / 探不到」三种，跟跑测试那台机器
 *    的盘上有啥无关；真读盘的探测器在最后两节拿**稳定的仓库路径**单独验。
 */
import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const WORKDIR = 'D:\\proj'
const sh = (command, probe) => ({ name: 'run_shell', args: { command }, workdir: WORKDIR, userText: '', probe })
const SMALL = () => ({ known: true, files: 2 })
const LARGE = () => ({ known: true, files: 99999 })
const UNKNOWN = () => ({ known: false, files: null })

export async function run() {
  const gate = require(join(ROOT, 'electron/core/tools/scale-gate.cjs'))
  const files = require(join(ROOT, 'electron/core/scale-files.cjs'))

  group('A2 / P4-1：目标探得到且不大 → 不拦（缺口正身）')

  const clean2 = gate.inspect(sh('Remove-Item -Recurse -Force C:\\tmp\\a.txt, C:\\tmp\\b.txt', SMALL))
  check(
    '★★ 清理 2 个临时文件（目标探得到、很小）→ 不拦 —— 正是 P4-1 当初被拦的场景',
    clean2.level !== 'ask',
    `${clean2.level}｜${clean2.reasons.join('；')}`,
  )
  check('★ 而且是「降成 note」而非「什么都没记」（仍留痕，将来可回看）', clean2.level === 'note', clean2.level)
  check(
    '★ 判据里说明白了是「按实测规模放行」',
    clean2.reasons.some((r) => /实测.*未达阈值/.test(r)),
    clean2.reasons.join('；'),
  )

  group('A2 / P4-1：很大、或探不到 → 照旧拦（保守方向不许松）')

  check(
    '★ 目标很大（≥ scaleMaxFiles）→ 照旧拦',
    gate.inspect(sh('robocopy C:\\src D:\\dst /E', LARGE)).level === 'ask',
    gate.inspect(sh('robocopy C:\\src D:\\dst /E', LARGE)).level,
  )
  check(
    '★★ 目标探不出来（没权限 / 不存在）→ 照旧拦（不知道就别放行）',
    gate.inspect(sh('robocopy C:\\src D:\\dst /E', UNKNOWN)).level === 'ask',
    gate.inspect(sh('robocopy C:\\src D:\\dst /E', UNKNOWN)).level,
  )
  check(
    '★★ 环境变量写法（说不清是哪个目录）→ 压根不探测、直接拦',
    (() => {
      let called = false
      const spy = () => {
        called = true
        return { known: true, files: 0 }
      }
      return gate.inspect(sh('dir /s %TEMP%', spy)).level === 'ask' && called === false
    })(),
  )
  check(
    '★ 盘根（`C:\\`）→ 不探测（探它没意义）、直接拦',
    (() => {
      let called = false
      const spy = () => {
        called = true
        return { known: true, files: 0 }
      }
      return gate.inspect(sh('dir /s C:\\', spy)).level === 'ask' && called === false
    })(),
  )

  group('A2 / P4-1：探测拿到的路径就是命令里那几个目标')

  let got = null
  gate.inspect(
    sh('robocopy C:\\src D:\\dst /E', (paths) => {
      got = paths
      return { known: true, files: 5 }
    }),
  )
  check(
    '★ 两个目标都传给探测器（多目标取最大的那个）',
    Array.isArray(got) &&
      got.length === 2 &&
      got[0].toLowerCase().startsWith('c:') &&
      got[1].toLowerCase().startsWith('d:'),
    JSON.stringify(got),
  )
  let gotWd = 'not-called'
  gate.inspect({
    name: 'run_shell',
    args: { command: 'grep -r foo .' },
    workdir: WORKDIR,
    userText: '',
    probe: (paths) => {
      gotWd = paths
      return { known: false, files: null }
    },
  })
  check('★ 工作目录内的递归**不探测**（本来就不拦，白探是浪费）', gotWd === 'not-called', String(gotWd))

  group('A2 / P4-1：真探测器（读盘）—— 有界递归 / 失败即 unknown')

  const smallDir = join(ROOT, 'electron', 'core', 'tools')
  const rt = files.probePaths([smallDir], { max: 2000 })
  check('★ 真探测：仓库里一个小目录 → known 且远小于阈值', rt.known === true && rt.files > 0 && rt.files < 2000, JSON.stringify(rt))
  check('★★ 真探测：不存在的路径 → known:false（不知道就别放行）', files.probePaths([join(ROOT, 'no-such-dir-xyz-123')], { max: 2000 }).known === false)
  check('★ 真探测：glob 写法（`C:\\data\\*`）→ known:false（不是真路径，探不了）', files.probePaths(['C:\\data\\*'], { max: 2000 }).known === false)
  check('★ 真探测：单个文件 → 1（命令目标是文件时，条目数就是一个）', files.probePaths([join(ROOT, 'package.json')], { max: 2000 }).files === 1)
  check(
    '★★ 真探测：递归巨树（`C:\\Users`，两层下界会误判成小）→ **不是**「known 且小」（Windows 上撞阈值/撞目录上限，Linux 上不存在 → 两种都算过）',
    (() => {
      const r = files.probePaths(['C:\\Users'], { max: 2000 })
      return r.known === false || r.files >= 2000
    })(),
    JSON.stringify(files.probePaths(['C:\\Users'], { max: 2000 })),
  )
}

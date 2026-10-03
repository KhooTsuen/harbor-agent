import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/*
 * 临时脚本骨架（`tools/probe.mjs`）的自检。
 *
 * 为什么值得单独一组：这个月的假结论**基本都出在临时脚本这一层**
 * （判据恒 undefined、漏交证据、前置不成立照样跑完给 ✅…）。
 * 骨架本身要是不可靠，比没有骨架更糟 —— 所以这里两件事都验：
 *   ① **框架自测**：拿「肯定不过」的输入喂它，断言它会红；
 *   ② **真跑一遍**：把故意写错的脚本丢给 node 跑，断言**子进程退出码非 0**、
 *      而且输出里能看见是哪一条出的问题（不是靠读代码猜）。
 */

/* Windows 上 import('E:\\…') 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 必须转 file:// URL */
const probeUrl = pathToFileURL(join(ROOT, 'tools/probe.mjs')).href

/**
 * 造一个一次性脚本并真跑它。
 *
 * ⚠️ 这里**故意**用数组拼字符串、不用模板串 —— 本文件在测的就是「模板串里那些坑」，
 * 自己先别踩：注释里的反引号、正文里的 `\n` 在模板串里全是事故。
 */
function runFixture(bodyLines) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-fixture-'))
  const file = join(dir, 'fixture.mjs')
  try {
    const source = [
      `import { probe } from '${probeUrl}'`,
      "const p = probe('fixture')",
      ...bodyLines,
      '',
    ].join('\n')
    writeFileSync(file, source, 'utf8')
    const res = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' })
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function run() {
  const mod = await import(pathToFileURL(join(ROOT, 'tools/probe.mjs')).href)

  group('临时脚本骨架：框架自测（拿肯定不过的输入喂它）')

  const st = mod.selfTest()
  for (const item of st.项) {
    check(
      `★ ${item.名称} → 期望 ${item.期望}，实际 ${item.实际}`,
      item.ok,
      item.ok ? '' : '探针自己交出了假结论（这正是它要拦的东西）',
    )
  }

  group('临时脚本骨架：故意写错的脚本必须被拦住（真跑一遍）')

  /* ① 漏交证据 + 恒 undefined —— 老写法最典型的两种假绿 */
  const a = runFixture([
    "p.check('漏交证据的判据', true)",
    "p.check('恒 undefined 的判据', undefined, '模板串漏了 return')",
    'p.finish()',
  ])
  check('★ 漏证据 / 恒 undefined 的脚本：退出码非 0', a.status === 1, `退出码=${a.status}`)
  check(
    '★ 输出里点名了「判据没交证据」（不是悄悄算 ✅）',
    /判据没交证据/.test(a.out) && !/✅ 漏交证据的判据/.test(a.out),
    `输出片段=${a.out.replace(/\s+/g, ' ').slice(-160)}`,
  )

  /* ② 前置不成立：必须拒绝开跑（退出码 2），而不是跑完给个 ✅ */
  const b = runFixture([
    "p.ready('安装版存在', false, '先跑 npm run package')",
    'p.requireReady()',
    "p.check('这行不该被执行', true, 'ev')",
    'p.finish()',
  ])
  check('★ 前置不成立 → 退出码 2（专门表示「没跑」）', b.status === 2, `退出码=${b.status}`)
  check(
    '★ 前置不成立时后面的判据一条都没跑',
    /前置不成立/.test(b.out) && !/这行不该被执行/.test(b.out),
    `输出片段=${b.out.replace(/\s+/g, ' ').slice(0, 120)}`,
  )

  /* ③ 漏 await：promise 在判据算完之后才炸 —— 以前静默，现在必须非 0 */
  const c = runFixture([
    'const boom = async () => { throw new Error(\'忘了 await\') }',
    'boom()',
    "p.check('这条本来会过', true, 'ev')",
    'setTimeout(() => p.finish(), 30)',
  ])
  check('★ 漏 await 的脚本：退出码非 0', c.status === 1, `退出码=${c.status}`)
  check('★ 输出里说了是漏 await', /漏了 await/.test(c.out), `输出片段=${c.out.replace(/\s+/g, ' ').slice(-160)}`)

  /* ④ 忘了 finish()：结论不完整，同样非 0 */
  const d = runFixture(["p.check('这条本来会过', true, 'ev')"])
  check('★ 忘了 finish() 的脚本：退出码非 0', d.status === 1, `退出码=${d.status}`)
  check('★ 输出里说了没汇总', /没调 finish/.test(d.out), `输出片段=${d.out.replace(/\s+/g, ' ').slice(-160)}`)

  /* ⑤ 反向对照：本该通过的脚本**必须**是 0 —— 否则就是「养了个只会喊红的哨兵」 */
  const e = runFixture([
    "p.ready('前置成立', true)",
    'p.requireReady()',
    "p.check('真判据', 1 + 1 === 2, '1+1=2')",
    'p.finish()',
  ])
  check('★ 本该通过的脚本：退出码 0（不误报）', e.status === 0, `退出码=${e.status}｜${e.out.replace(/\s+/g, ' ').slice(0, 120)}`)
  check('通过时也把证据打出来了', /证据：1\+1=2/.test(e.out), `输出片段=${e.out.replace(/\s+/g, ' ').slice(-160)}`)

  group('临时脚本骨架：js() 生成的注入代码（替代手写模板串）')

  /*
   * 这里真正要证明的是：函数体里带**反引号注释**和**真换行**也不会坏。
   * 手写模板串时，这两样分别是「提前截断模板」和「SyntaxError」的来源。
   */
  const source = mod.jsSource(
    (a) => {
      /* 注释里的反引号 ` 以前会截断模板串 */
      return a + 1
    },
    41,
  )
  let evaluated = null
  let error = ''
  try {
    /* eslint-disable-next-line no-new-func */
    evaluated = new Function(`return ${source}`)()
  } catch (err) {
    error = String(err?.message ?? err)
  }
  check(
    '★ 带反引号注释、带真换行的函数 → 生成的代码仍能执行且结果正确',
    evaluated === 42,
    `结果=${String(evaluated)}｜错误=${error || '无'}｜源码=${source.slice(0, 60)}`,
  )
  check('参数走 JSON.stringify（不用手拼引号）', source.endsWith('(41)'), `源码=${source}`)
}

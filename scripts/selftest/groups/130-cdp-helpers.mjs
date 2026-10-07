/**
 * 自检 / 真机脚本的公共 helper（`tools/shot/cdp.mjs` 的可靠性三件套）
 *
 * 来由：2026-10-03 真机脚本连着三轮报的是**脚本自己的错**（清单「测试脚本自身的可靠性」）。
 * 三个坑各钉一条：① 表达式语法错被当成产品崩了 ② 漏 return 判据恒 undefined
 * ③ 子进程 / 连接忘关 node 不退出。这里只验纯逻辑，不连真机（连真机交给 tools/cdp.mjs）。
 */
import { pathToFileURL } from 'node:url'
import { join, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* 换行/语法错的造法：真换行（不是 `\n` 两个字符）塞进单引号字符串 —— 正是页面上报
   `SyntaxError` 的那种写法，只不过那时是在脚本里手滑打出来的 */
const BROKEN = "'第1行" + String.fromCharCode(10) + "第2行'"

export async function run() {
  group('真机脚本 helper：语法预检 / 异常分家 / 退出清理')

  const cdp = await import(pathToFileURL(join(ROOT, 'tools/shot/cdp.mjs')).href)

  /* ① 语法预检 */
  check('合法表达式：预检通过', cdp.checkExpression('(function () { return 1 })()').ok === true)
  const broken = cdp.checkExpression(BROKEN)
  check('★ 语法错的表达式：预检就拦下（不发给页面）', broken.ok === false, broken.error)
  check('预检失败给得出原因', typeof broken.error === 'string' && broken.error.length > 0)
  check('空表达式：也拦', cdp.checkExpression('   ').ok === false)

  /* ② evaluate：正常 / 页面抛错 / 语法错，三者分得清 */
  const okCdp = { send: async () => ({ result: { value: 42 } }) }
  check('正常返回：拿到值', (await cdp.evaluate(okCdp, '40 + 2', { label: '算术' })) === 42)

  const throwCdp = {
    send: async () => ({
      exceptionDetails: { exception: { description: 'TypeError: x is not a function\n    at <anonymous>:1:1' } },
    }),
  }
  let thrown = ''
  try {
    await cdp.evaluate(throwCdp, 'x()', { label: '调用 x' })
  } catch (error) {
    thrown = error.message
  }
  check(
    '★ 页面抛异常：evaluate 抛错，且只留第一行',
    thrown.includes('TypeError: x is not a function') && !thrown.includes('at <anonymous>'),
    thrown,
  )
  check('★ 报错带上 label（我做了什么）', thrown.includes('调用 x'), thrown)

  let syntaxThrown = ''
  try {
    await cdp.evaluate(okCdp, BROKEN, { label: '坏脚本' })
  } catch (error) {
    syntaxThrown = error.message
  }
  check('★ 语法错：evaluate 直接抛，理由是「语法」', syntaxThrown.includes('语法'), syntaxThrown)

  /* ③ undefined：警告（漏 return），但不算失败 */
  const undefCdp = { send: async () => ({ result: { value: undefined } }) }
  const warns = []
  const realWarn = console.warn
  console.warn = (...parts) => warns.push(parts.join(' '))
  let v1
  let v2
  try {
    v1 = await cdp.evaluate(undefCdp, 'void 0', { label: '忘了 return' })
    const afterFirst = warns.length
    v2 = await cdp.evaluate(undefCdp, 'void 0', { label: '故意的', allowUndefined: true })
    check('★ undefined：明确警告「是不是漏了 return」', afterFirst === 1 && warns[0].includes('return'), warns.join(' | '))
    check('allowUndefined：不再警告', warns.length === afterFirst, `警告 ${warns.length} 次`)
  } finally {
    console.warn = realWarn
  }
  check('两种都照常返回 undefined（不伪造成有值）', v1 === undefined && v2 === undefined)

  /* ④ makeCleanup：倒序执行、只跑一次 */
  const order = []
  const clean = cdp.makeCleanup()
  clean.add(() => order.push('a'))
  clean.add(() => order.push('b'))
  clean.run()
  clean.run()
  check('★ 清理按倒序执行、且只跑一次', order.join(',') === 'b,a', order.join(','))

  /* ⑤ findPageTarget：端口没开时给人话，不是原始 fetch 错误 */
  let netErr = ''
  try {
    await cdp.findPageTarget(1, { timeoutMs: 150 })
  } catch (error) {
    netErr = error.message
  }
  check('★ 端口连不上：报错带端口号 + 怎么办', netErr.includes('1') && netErr.includes('dev'), netErr)
}

/**
 * CDP 内核（主进程直连 webview 的 webContents）
 *
 * 这一组只验**纯 Node 能验的那部分**：`valueOfEvaluate` 的取值/抛错口径，
 * 以及「browse-ax 不再自己写一份 CDP」的源码钉子。
 * 真连 webContents 要 electron + 真网页，不在自检里跑（那属于真机验收）。
 *
 * 为什么要这个模块：CDP 调用原来散在各处（browse-ax 自己 attach、
 * selftest-report 自己截图），收进 `electron/core/cdp.cjs` 一处 —— 后面
 * browse 的读取路径也要用它。详见该文件头。
 */
import { createRequire } from 'node:module'
import { ROOT, join, readFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

const require = createRequire(import.meta.url)

export async function run() {
  group('CDP 内核 / 主进程直连 webContents')

  /* 能 require 成功本身就说明：顶层没 require electron（否则纯 Node 下会炸） */
  const cdp = require(join(ROOT, 'electron/core/cdp.cjs'))

  check(
    '导出 attach / send / evaluate / getFullAxTree / valueOfEvaluate',
    ['attach', 'send', 'evaluate', 'getFullAxTree', 'valueOfEvaluate'].every(
      (k) => typeof cdp[k] === 'function',
    ),
  )
  check('CDP 版本固定 1.3（与原 browse-ax 一致）', cdp.CDP_VERSION === '1.3')

  /* valueOfEvaluate：纯函数，这里真跑 */
  check('正常返回：取到值', cdp.valueOfEvaluate({ result: { value: 42 } }) === 42)
  check('没有值：返回 undefined（不抛）', cdp.valueOfEvaluate({ result: {} }) === undefined)

  let thrown = ''
  try {
    cdp.valueOfEvaluate({
      exceptionDetails: {
        exception: { description: 'TypeError: x is not a function\n    at <anonymous>:1:1' },
      },
    })
  } catch (error) {
    thrown = error.message
  }
  check(
    '★ 页面抛错：抛出，且只留第一行（别把堆栈灌给模型）',
    thrown.includes('TypeError: x is not a function') && !thrown.includes('at <anonymous>'),
    thrown,
  )

  let byText = ''
  try {
    cdp.valueOfEvaluate({ exceptionDetails: { text: 'SyntaxError: bad' } })
  } catch (error) {
    byText = error.message
  }
  check('抛错里没有 exception 时退回 text 字段', byText === 'SyntaxError: bad', byText)

  /* 源码钉子：CDP 那层只有一处（cdp.cjs），browse-ax 不再自己 attach/sendCommand */
  const axSrc = readFileSync(join(ROOT, 'electron/core/tools/browse-ax.cjs'), 'utf8')
  check(
    '★ browse-ax 走 cdp.cjs，不再自己 attach / sendCommand',
    /['"]\.\.\/cdp\.cjs['"]/.test(axSrc) &&
      !axSrc.includes('debugger.attach') &&
      !axSrc.includes('sendCommand'),
  )
}

/**
 * 读网页正文（主进程经 CDP）—— `electron/core/browse-read.cjs`
 *
 * B2（2026-10-09）把「读正文」从渲染层 `executeJavaScript` 搬到主进程
 * `Runtime.evaluate`。原来这段空重试逻辑是 `browseWait.test.ts` 里的 vitest 用例，
 * 随逻辑一起搬过来了（那边已删）——**覆盖跟着代码走**，不能搬完就没人管。
 *
 * 这里用注入的假 `evaluate` 跑，纯 Node，不开 Electron、不连网页。
 */
import { createRequire } from 'node:module'
import { ROOT, join } from '../env.mjs'
import { check, group } from '../harness.mjs'

const require = createRequire(import.meta.url)

/** 造一个按顺序吐值的假 evaluate；`calls.n` 记被调了几次 */
function mk(values) {
  let i = 0
  const calls = { n: 0 }
  const evaluate = async () => {
    calls.n += 1
    const value = values[Math.min(i, values.length - 1)]
    i += 1
    if (value instanceof Error) throw value
    return value
  }
  return { evaluate, calls }
}

export async function run() {
  group('读网页正文（主进程经 CDP）')

  const br = require(join(ROOT, 'electron/core/browse-read.cjs'))

  check(
    '导出 READ_SCRIPT / readPageText',
    typeof br.readPageText === 'function' && typeof br.READ_SCRIPT === 'string',
  )
  check(
    'READ_SCRIPT 是读正文的 IIFE（innerText + 兜底 html）',
    br.READ_SCRIPT.includes('innerText') && br.READ_SCRIPT.includes('outerHTML'),
  )

  let m = mk([{ text: '正文', html: '<p>x</p>', title: 'T', url: 'https://a/' }])
  let out = await br.readPageText(0, { evaluate: m.evaluate, sleepMs: 0 })
  check(
    '有正文：读一次就交付，四个字段都带出来',
    m.calls.n === 1 && out.text === '正文' && out.title === 'T' && out.url === 'https://a/',
  )

  m = mk([{ text: '' }, { text: '填好了' }])
  out = await br.readPageText(0, { evaluate: m.evaluate, sleepMs: 0 })
  check('★ 第一次空（SPA 还没填）→ 再读一次', m.calls.n === 2 && out.text === '填好了')

  m = mk([{ text: '', html: '' }, { text: '', html: '<body>裸的</body>' }])
  out = await br.readPageText(0, { evaluate: m.evaluate, sleepMs: 0 })
  check('空 text 但后备 html 有内容也算数', m.calls.n === 2 && out.html.includes('裸的'))

  m = mk([new Error('guest 没就绪'), { text: '来了' }])
  out = await br.readPageText(0, { evaluate: m.evaluate, sleepMs: 0 })
  check('★ 脚本偶发失败 → 重试后成功', m.calls.n === 2 && out.text === '来了')

  m = mk([new Error('boom')])
  let thrown = ''
  try {
    await br.readPageText(0, { evaluate: m.evaluate, sleepMs: 0 })
  } catch (error) {
    thrown = error.message
  }
  check('★ 一直失败 → 抛出（不编一个「没有正文」）', thrown === 'boom' && m.calls.n === 3)

  m = mk([{ text: '' }])
  out = await br.readPageText(0, { evaluate: m.evaluate, sleepMs: 0, tries: 3 })
  check('一直空：试满次数就停（不无限等）', m.calls.n === 3 && out.text === '')
}

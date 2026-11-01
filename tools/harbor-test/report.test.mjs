import test from 'node:test'
import assert from 'node:assert/strict'
import { compare, markdown } from './report.mjs'

const target = { kind: 'source', path: 'E:\\CodexWorkbench', id: 'source:e:\\codexworkbench' }
const item = (name, status) => ({ group: 'M04', name, status })
const run = (status, ms, items) => ({ target, scope: 'e2e', stages: [{ id: 'm04d', status, durationMs: ms, sourceHash: 'abc', items }] })

test('上次通过本次失败，报告点名退步与三倍耗时', () => {
  const old = run('PASS', 12_000, [item('下行通道', 'pass')])
  const current = run('FAIL_ASSERTION', 47_000, [item('下行通道', 'fail')])
  const diff = compare(current, old)
  assert.equal(diff.regressions.length, 1)
  assert.equal(diff.slow[0].factor, 3.9)
  const text = markdown(current, diff)
  assert.match(text, /上次通过，这次失败/)
  assert.match(text, /12 秒 → 47 秒/)
})

test('脚本判据源已变化时不虚报退步', () => {
  const old = run('PASS', 12_000, [item('下行通道', 'pass')])
  const current = run('FAIL_ASSERTION', 47_000, [item('下行通道', 'fail')])
  current.stages[0].sourceHash = 'changed'
  assert.deepEqual(compare(current, old).regressions, [])
})

test('环境没跑成时报告说明无法判断程序', () => {
  const current = run('FAIL_INFRA', 1000, [])
  const text = markdown(current, compare(current, null))
  assert.match(text, /暂不能判断目标是否可用/)
  assert.match(text, /执行环境或脚本启动异常/)
})

test('首次失败复测通过时只报抖动并保留风险说明', () => {
  const current = run('FLAKY', 20_000, [item('下行通道', 'pass')])
  current.stages[0].attempts = [{ status: 'FAIL_ASSERTION' }, { status: 'PASS' }]
  const text = markdown(current, compare(current, null))
  assert.match(text, /首次失败、复测通过/)
  assert.match(text, /环境抖动：1 个/)
})

test('单脚本通过不宣称整个版本可用', () => {
  const current = run('PASS', 10_000, [item('下行通道', 'pass')])
  current.scope = 'e2e-accept-phase2'
  const text = markdown(current, compare(current, null))
  assert.match(text, /本次选定的检查通过/)
  assert.doesNotMatch(text, /可以继续使用当前被测版本/)
})

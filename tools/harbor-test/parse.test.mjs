import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, parseE2e, parseSelf, parseUnit, parseVerify } from './parse.mjs'

test('自检的组名与失败判据进入结构化结果', () => {
  const p = parseSelf('── 页面读取 ──\n  ✅ 能读取当前页\n  ❌ 旧引用被拒绝\n════════\n通过 1 项，失败 1 项')
  assert.equal(p.items[1].group, '页面读取')
  assert.equal(p.items[1].status, 'fail')
  assert.equal(classify(1, p), 'FAIL_ASSERTION')
})

test('真机退出零但没有判据不能假绿', () => {
  assert.equal(classify(0, parseE2e('Edge 已启动，脚本结束')), 'SUSPECT')
})

test('真机输出 FAIL 但退出零不能假绿', () => {
  const p = parseE2e('PASS  扩展加载 -- yes\nFAIL  下行通道 -- no\n==== 1/2 通过 ====')
  assert.equal(p.failed, 1)
  assert.equal(classify(0, p), 'SUSPECT')
})

test('单测汇总能识别', () => {
  const p = parseUnit(' Test Files  2 passed (2)\n      Tests  8 passed (8)')
  assert.equal(p.passed, 8)
  assert.equal(classify(0, p), 'PASS')
})

test('全链失败后不会把没运行的阶段算通过', () => {
  const p = parseVerify('> harbor-agent@1.32.0 verify\n> harbor-agent@1.32.0 test:unit\n Test Files  2 passed (2)\n      Tests  8 passed (8)\n> harbor-agent@1.32.0 security\nPASS 82 · FAIL 1\n失败清单：\n    · SEC-073 健康态报 undecryptable')
  assert.deepEqual(p.seen, ['verify', 'test:unit', 'security'])
  assert.equal(p.security.fail, 1)
  assert.deepEqual(p.security.failures, ['SEC-073 健康态报 undecryptable'])
  assert.equal(p.seen.includes('build'), false)
})

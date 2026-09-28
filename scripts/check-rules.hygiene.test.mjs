/* 「仓库卫生」检查的测试（第 8 项：根目录项数 / tmp/ 项数与体积）
 *
 * 用临时目录造场景，绝不拿真实仓库当断言对象 —— 那样「清洁度」一变测试就红，
 * 而它本来就是个**趋势警告**，不是正确性断言。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { checkHygiene, LIMITS } from './check-rules.mjs'
import { tempRoot } from './check-rules/test-kit.mjs'

const many = (root, dir, n, prefix = 'f') => {
  const full = path.join(root, dir)
  fs.mkdirSync(full, { recursive: true })
  for (let i = 0; i < n; i += 1) fs.writeFileSync(path.join(full, `${prefix}${i}.cjs`), '// x\n')
}

/* 测试用的窄阈值：不要用真实阈值去「造超标现场」——
   那样体积用例得真写 1.5 GB 文件（实测把测试拖到 15 秒，还白占磁盘） */
const TIGHT = { rootEntries: 3, tmpEntries: 2, tmpMb: 0.001 }

test('卫生：干净的临时根里什么都不报', () => {
  const { root, done } = tempRoot({ 'package.json': '{}' })
  try {
    const result = checkHygiene(root)
    assert.deepEqual(result.errors, [], '这一项永远不报 error')
    assert.deepEqual(result.warnings, [], `干净的根不该有警告，实际：${result.warnings.join('｜')}`)
  } finally {
    done()
  }
})

test('卫生：没有 tmp/ 时跳过临时目录那段，但仍报根目录', () => {
  const { root, done } = tempRoot({})
  try {
    many(root, '.', 4, 'root')
    const result = checkHygiene(root, TIGHT)
    assert.ok(
      result.warnings.some((w) => w.includes('仓库根目录')),
      `根目录项数超限要报，实际：${result.warnings.join('｜')}`,
    )
    assert.ok(result.summary.includes('没有 tmp/'), `摘要要说清跳过了什么，实际：${result.summary}`)
  } finally {
    done()
  }
})

test('卫生：tmp/ 项数超限 → 报出该跑哪个脚本', () => {
  const { root, done } = tempRoot({})
  try {
    many(root, 'tmp', 4)
    const result = checkHygiene(root, TIGHT)
    const hit = result.warnings.find((w) => w.includes('tmp/ 根下'))
    assert.ok(hit, `tmp/ 项数超限要报，实际：${result.warnings.join('｜')}`)
    assert.ok(hit.includes('organize2.cjs'), '警告里要给出可执行的下一步（哪个脚本）')
  } finally {
    done()
  }
})

test('卫生：tmp/ 体积超限 → 单独一条警告（不只是项数）', () => {
  const { root, done } = tempRoot({})
  try {
    many(root, 'tmp', 1, 'replica')
    fs.writeFileSync(path.join(root, 'tmp', 'big.bin'), Buffer.alloc(4096))
    const result = checkHygiene(root, { ...TIGHT, tmpMb: 0.001 })
    assert.ok(
      result.warnings.some((w) => w.includes('体积')),
      `体积超限要报，实际：${result.warnings.join('｜')}`,
    )
  } finally {
    done()
  }
})

test('卫生：真实阈值要比现状宽（不然每周都红）', () => {
  assert.equal(typeof LIMITS.rootEntries, 'number')
  assert.equal(typeof LIMITS.tmpEntries, 'number')
  assert.equal(typeof LIMITS.tmpMb, 'number')
  assert.ok(LIMITS.tmpEntries > 400, '阈值要比整理后的现状宽')
  assert.ok(LIMITS.tmpMb > 500, '隔离副本本身就有 391 MB，别卡太紧')
})

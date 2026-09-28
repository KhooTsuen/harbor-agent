/* 「易漂数字」检查的测试（第 9 项）
 *
 * 重点有两个：
 *   ① 会涨的计数（自检项数 / 通道数）在「现状说明」类文件里要报出来
 *   ② 写了「看输出」这类前提的行**不许**报（否则作者会被逼着删掉有用的说明）
 *   ③ 历史记录文件（CHANGELOG / 验收核对）不在名单里 —— 当时的数字就是事实
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { checkDriftingNumbers } from './check-rules.mjs'
import { tempRoot } from './check-rules/test-kit.mjs'

test('易漂数字：真实仓库现在是干净的', () => {
  const result = checkDriftingNumbers(path.resolve(import.meta.dirname, '..'))
  assert.deepEqual(result.errors, [], '这一项只警告')
  assert.deepEqual(result.warnings, [], `现状说明类文件里不该有写死的计数：${result.warnings.join('｜')}`)
})

test('易漂数字：写死「自检 1800 项」要报，且给出文件与行号', () => {
  const { root, done } = tempRoot({ 'AGENT.md': '# 规矩\n\n内核自检 1800 项，直接 require。\n' })
  try {
    const result = checkDriftingNumbers(root)
    assert.equal(result.warnings.length, 1, result.warnings.join('｜'))
    assert.ok(result.warnings[0].includes('AGENT.md:3'), `要带位置：${result.warnings[0]}`)
    assert.ok(result.warnings[0].includes('自检'), '要说清是哪类数字')
  } finally {
    done()
  }
})

test('易漂数字：写死「137 个 IPC 通道」也要报', () => {
  const { root, done } = tempRoot({ 'docs/架构.md': '一共 137 个 IPC 通道。\n' })
  try {
    const result = checkDriftingNumbers(root)
    assert.equal(result.warnings.length, 1, result.warnings.join('｜'))
    assert.ok(result.warnings[0].includes('通道'), result.warnings[0])
  } finally {
    done()
  }
})

test('易漂数字：写了「看输出」「每版都会涨」的行放行', () => {
  const { root, done } = tempRoot({
    'AGENT.md': '内核自检 1800 项，项数每版都会涨。\nIPC 通道 137 个，看输出。\n',
  })
  try {
    const result = checkDriftingNumbers(root)
    assert.deepEqual(result.warnings, [], `带前提的行不该报：${result.warnings.join('｜')}`)
  } finally {
    done()
  }
})

test('易漂数字：历史记录文件不在名单里（当时的数字是事实）', () => {
  const { root, done } = tempRoot({
    'CHANGELOG.md': '内核自检 1811 项 / 失败 0。\n',
    'docs/验收核对-第16章.md': '当时 2786 项全过。\n',
  })
  try {
    const result = checkDriftingNumbers(root)
    assert.deepEqual(result.warnings, [], `历史文件不该被改写：${result.warnings.join('｜')}`)
  } finally {
    done()
  }
})

test('易漂数字：文件不存在就跳过（不炸）', () => {
  const { root, done } = tempRoot({})
  try {
    const result = checkDriftingNumbers(root)
    assert.deepEqual(result.warnings, [])
    assert.ok(result.summary.includes('份文件'), result.summary)
  } finally {
    done()
  }
})

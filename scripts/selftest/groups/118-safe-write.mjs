/**
 * 自检 / 写盘原子性：rename 撞上「文件被占着」要重试，不是一撞就崩
 *
 * 来由（2026-10-05）：`safe-write.cjs` 的 rename 在 Windows 上撞上 EPERM
 * （`rename 'data/memory.json.tmp-968' -> 'data/memory.json'`），一抛就把整个自检崩掉、
 * **连着拦下三次推送**。而那两条写用户数据的路（记忆 / 会话）用的是同一个函数 ——
 * 所以这不是「自检不稳」，是一次普通的写盘会变成崩溃。
 *
 * 怎么造这个错：`safe-write.cjs` 里是 `require('node:fs')`，与这里拿到的是**同一个
 * 模块对象**，把 `fs.renameSync` 换掉就能精确模拟「前 N 次被占着」。
 */
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const { writeAtomic } = require(join(ROOT, 'electron/core/safe-write.cjs'))

/**
 * 让 renameSync 按给定的 code 序列失败：第 i 次调用若 `codes[i-1]` 有值就抛那个 code，
 * 否则走真的 rename。返回 `{ result, calls }`，结束时一定恢复原函数。
 */
function withRenameFailures(codes, fn) {
  const real = fs.renameSync
  let calls = 0
  fs.renameSync = (from, to) => {
    calls += 1
    const code = codes[calls - 1]
    if (code) {
      const error = new Error(`${code}：假装目标文件被别的东西占着`)
      error.code = code
      throw error
    }
    return real(from, to)
  }
  try {
    return { result: fn(), calls }
  } finally {
    fs.renameSync = real
  }
}

export async function run() {
  group('写盘：rename 被占着要重试')

  const dir = fs.mkdtempSync(join(tmpdir(), 'harbor-safe-write-'))
  const file = join(dir, 'memory.json')
  const read = () => fs.readFileSync(file, 'utf8')

  writeAtomic(file, '{"a":1}')
  check('正常写：内容落盘', read() === '{"a":1}', read())

  /* ★ 事故现场：前两次 EPERM、第三次成功 —— 修之前第二次就崩了 */
  const twice = withRenameFailures(['EPERM', 'EPERM'], () => writeAtomic(file, '{"a":2}'))
  check('★ 前两次被占着 → 重试到成功', read() === '{"a":2}', read())
  check('★ 确实重试了（rename 被调 3 次）', twice.calls === 3, `实际 ${twice.calls} 次`)

  withRenameFailures(['EBUSY'], () => writeAtomic(file, '{"a":3}'))
  check('EBUSY 是同一类，同样重试', read() === '{"a":3}', read())

  /* 一直占着：必须抛出来，不能假装写成功，也不能无限重试 */
  const always = withRenameFailures(Array(20).fill('EPERM'), () => {
    try {
      writeAtomic(file, '{"a":4}')
      return '没抛'
    } catch (error) {
      return error.code
    }
  })
  check('★ 一直写不进去 → 抛错（不糊弄成成功）', always.result === 'EPERM', String(always.result))
  check('★ 重试有上限，不是死循环', always.calls === 5, `实际 ${always.calls} 次`)
  check('失败时留下的是旧内容，不是半截', read() === '{"a":3}', read())

  /* 非「被占着」的错误立刻抛 —— 磁盘满了重试一百次也没用 */
  const fatal = withRenameFailures(['ENOSPC'], () => {
    try {
      writeAtomic(file, '{"a":5}')
      return '没抛'
    } catch (error) {
      return error.code
    }
  })
  check('★ ENOSPC 这类真错误一次都不重试', fatal.calls === 1 && fatal.result === 'ENOSPC', `调了 ${fatal.calls} 次`)

  /* 失败后不留垃圾：data/ 里曾经攒下过 .tmp-* 残留 */
  const left = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
  check('★ 失败后不留 .tmp-* 临时文件', left.length === 0, left.join('、') || '（干净）')

  fs.rmSync(dir, { recursive: true, force: true })
}

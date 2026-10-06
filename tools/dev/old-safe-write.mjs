/* 拿「旧版本」跑一遍新自检里的那条断言：证明它真能抓住老问题，而不是自证 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
/* 装机版里那份是修复前的代码（这轮没重新打包） */
const OLD = 'E:/Harbor/resources/app/electron/core/safe-write.cjs'
const NEW = join(import.meta.dirname, '..', '..', 'electron', 'core', 'safe-write.cjs')

const dir = fs.mkdtempSync(join(tmpdir(), 'sw-probe-'))
const file = join(dir, 'memory.json')

/** 前两次 rename 抛 EPERM，第三次才放行 —— 正是 2026-10-05 那次的形状 */
function scenario(mod) {
  const real = fs.renameSync
  let calls = 0
  fs.renameSync = (from, to) => {
    calls += 1
    if (calls <= 2) {
      const error = new Error('EPERM: operation not permitted, rename')
      error.code = 'EPERM'
      throw error
    }
    return real(from, to)
  }
  try {
    mod.writeAtomic(file, '{"a":2}')
    return { ok: true, calls }
  } catch (error) {
    return { ok: false, calls, code: error.code }
  } finally {
    fs.renameSync = real
  }
}

for (const [name, path] of [
  ['旧版本（装机版里那份）', OLD],
  ['新版本（这轮改的）', NEW],
]) {
  const mod = require(path)
  const before = fs.readFileSync(path, 'utf8').includes('renameWithRetry') ? '有重试' : '无重试'
  const r = scenario(mod)
  console.log(
    `${r.ok ? '✓ 写成功' : '✗ 崩了(' + r.code + ')'}  ${name}｜代码：${before}｜rename 被调 ${r.calls} 次`,
  )
  fs.writeFileSync(file, '{"a":1}', 'utf8')
}

fs.rmSync(dir, { recursive: true, force: true })

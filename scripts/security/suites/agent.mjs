/**
 * security:agent —— Agent 授权 / 工具 / Prompt Injection（SEC-013 ~ 024）
 *
 * 本轮实现：016（跨轮授权继承）/ 017（参数替换 TOCTOU）。
 * 013 / 014 / 018 / 021 需要提示词层或真任务链，本轮如实标 NOT_RUN（下一批）。
 */

import { sec, mark } from '../harness.mjs'
import { fs, path, require, ROOT, WORKSPACE, tmpDir } from '../sandbox.mjs'
import { CASES } from '../cases.mjs'

const join = path.join

/** SEC-016：批准只读之后，新的高风险（越界/敏感）动作仍要重新授权 */
function grantScope(capability) {
  const outside = tmpDir('agent-outside')
  const file = join(outside, 'data.txt')
  fs.writeFileSync(file, 'x', 'utf8')

  sec('SEC-016', capability.check(file, { workdir: WORKSPACE }).ok === false, '未授权时越界路径被拒')
  capability.grant(file, { mode: 'session', sessionId: 's1' })
  sec('SEC-016', capability.check(file, { workdir: WORKSPACE, sessionId: 's1' }).ok === true, '同一会话内授权后放行')
  sec('SEC-016', capability.check(file, { workdir: WORKSPACE, sessionId: 's2' }).ok === false, '别的会话不继承该授权')

  capability.revoke(file)
  sec('SEC-016', capability.check(file, { workdir: WORKSPACE, sessionId: 's1' }).ok === false, '撤销后要重新授权')

  /* 授权一次只读，不代表写入/删除也获批：路径边界是同一套判据 */
  const envFile = join(WORKSPACE, '.env')
  fs.writeFileSync(envFile, 'SECRET=1', 'utf8')
  sec('SEC-016', capability.check(envFile, { workdir: WORKSPACE }).ok === false, '敏感文件即便在工作目录内也要单独授权')
  const reason = capability.sensitiveReason(envFile)
  sec('SEC-016', typeof reason === 'string' && reason.length > 0, `敏感理由是人话（${reason}）`)
}

/** SEC-017：检查后、写入前换掉链接目标 —— 每次判定都基于**当下**的真实路径 */
function toctou(capability) {
  const inside = join(WORKSPACE, 'toc-inside')
  fs.rmSync(inside, { recursive: true, force: true })
  fs.mkdirSync(inside, { recursive: true })
  const outside = tmpDir('toc-outside')
  fs.writeFileSync(join(inside, 'a.txt'), 'x', 'utf8')
  fs.writeFileSync(join(outside, 'a.txt'), 'x', 'utf8')
  const link = join(WORKSPACE, 'toc-link')
  fs.rmSync(link, { recursive: true, force: true })
  let made = false
  try {
    fs.symlinkSync(inside, link, process.platform === 'win32' ? 'junction' : 'dir')
    made = true
  } catch {
    made = false
  }
  if (!made) {
    mark('SEC-017', 'BLOCKED', '本机无法创建目录链接，未验证')
    return
  }
  const target = join(link, 'a.txt')
  sec('SEC-017', capability.check(target, { workdir: WORKSPACE }).ok === true, '链接指向工作目录内 → 放行')

  /* 批准之后把链接改指向外部：下一次判定必须重新解析，不能拿旧结论 */
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const after = capability.check(target, { workdir: WORKSPACE })
  sec('SEC-017', after.ok === false, `换目标后重新判定为越界（absolute=${after.absolute}）`)
  fs.rmSync(link, { recursive: true, force: true })
}

export async function run() {
  const capability = require(join(ROOT, 'electron/core/capability.cjs'))
  console.log('\n· SEC-016 跨轮授权继承')
  try {
    grantScope(capability)
  } catch (error) {
    sec('SEC-016', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }
  console.log('\n· SEC-017 参数替换 TOCTOU')
  try {
    toctou(capability)
  } catch (error) {
    sec('SEC-017', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }
  const done = new Set(['SEC-016', 'SEC-017'])
  for (const c of CASES.filter((c) => c.suite === 'agent' && !done.has(c.id))) {
    mark(c.id, 'NOT_RUN', '待实现（下一批）')
  }
}

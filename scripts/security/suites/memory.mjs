/**
 * security:memory —— Memory 数据边界（SEC-057 ~ 066）
 *
 * 本轮实现首批里的：057（项目级记忆不跨项目泄漏）。
 */

import { sec, mark } from '../harness.mjs'
import { require, ROOT } from '../sandbox.mjs'
import { CASES } from '../cases.mjs'
import path from 'node:path'

const join = path.join

/** SEC-057：项目 A 的私有记忆不能出现在项目 B / 无项目上下文的注入里 */
function projectIsolation(memory) {
  memory.clear()
  memory.add({ content: 'PROJA-私有标记：部署口令在运维手册第 3 页', type: 'fact', scope: 'project', projectId: 'projA' })
  memory.add({ content: '全局偏好标记：回复用简体中文', type: 'preference', scope: 'global' })

  const at = (opts) => memory.retrieve(opts).map((i) => String(i.content ?? ''))
  const noCtx = at({})
  const projB = at({ projectId: 'projB' })
  const projA = at({ projectId: 'projA' })

  sec('SEC-057', !noCtx.some((c) => c.includes('PROJA-私有标记')), '无项目上下文时，项目记忆不注入')
  sec('SEC-057', !projB.some((c) => c.includes('PROJA-私有标记')), '项目 B 看不到项目 A 的私有记忆')
  sec('SEC-057', projA.some((c) => c.includes('PROJA-私有标记')), '项目 A 自己看得到（功能没弄坏）')
  sec('SEC-057', noCtx.some((c) => c.includes('全局偏好标记')), '全局记忆任何上下文都注入（不是一刀切关掉）')

  /* 注入段（真正进系统提示的那段）同样不该带出 A 的私事 */
  const sectionB = memory.buildPromptSection({ projectId: 'projB' })
  sec('SEC-057', !sectionB.includes('PROJA-私有标记'), '项目 B 的注入段里没有 A 的私事')
  memory.clear()
}

export async function run() {
  const memory = require(join(ROOT, 'electron/core/memory.cjs'))
  console.log('\n· SEC-057 项目级记忆隔离')
  try {
    projectIsolation(memory)
  } catch (error) {
    sec('SEC-057', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }
  for (const c of CASES.filter((c) => c.suite === 'memory' && c.id !== 'SEC-057')) {
    mark(c.id, 'NOT_RUN', '待实现（下一批）')
  }
}

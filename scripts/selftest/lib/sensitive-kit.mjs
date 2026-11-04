/**
 * 敏感文件授权自检的公共夹具（205 / 206 共用）
 *
 * ★ 为什么单独一个文件：两个组都要「造虚拟敏感文件 + 按档位读一次 + 看授权表」。
 *   各抄一份的话，哪天夹具变了（比如沙箱路径挪了），两组会各自绿着而互相不一致 ——
 *   AGENT.md 硬约束 9 说的就是这个（夹具要用同一个，不能手写一个「差不多」的）。
 *
 * ★ 安全性：只碰 `SANDBOX` / 沙箱旁边的隔离目录，内容是**假的**密钥串
 *   （`sk-should-not-be-exposed`），不读也不写用户真实凭据。
 */

import { mkdirSync, ROOT, SANDBOX, existsSync, join, require, writeFileSync } from '../env.mjs'

export const SECRET = 'sk-should-not-be-exposed'

/** 工作目录**外**的另一个目录（沙箱旁边，仍在隔离数据下） */
export const OUTSIDE = join(SANDBOX, '..', 'selftest-outside')

export const capability = require(join(ROOT, 'electron/core/capability.cjs'))
export const rules = require(join(ROOT, 'electron/core/capability-rules.cjs'))
export const store = require(join(ROOT, 'electron/core/capability-store.cjs'))
export const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))

/** 把虚拟文件摆好（幂等，两个组都会先调一次） */
export function prepare() {
  if (!existsSync(SANDBOX)) mkdirSync(SANDBOX, { recursive: true })
  if (!existsSync(OUTSIDE)) mkdirSync(OUTSIDE, { recursive: true })
  writeFileSync(join(SANDBOX, '.env'), `SECRET=${SECRET}\n`, 'utf8')
  writeFileSync(join(SANDBOX, 'plain.txt'), 'plain\n', 'utf8')
  writeFileSync(join(OUTSIDE, '.env'), `SECRET=${SECRET}-outside\n`, 'utf8')
  writeFileSync(join(OUTSIDE, 'note.txt'), 'outside\n', 'utf8')
}

/** 每个用例都从「一条授权都没有」开始 */
export function reset() {
  store.revokeAll()
}

/** 直接塞一条历史形状的记录（旧版本写进盘里的就是这些形状） */
export function seed(grant) {
  store.all().grants.push(grant)
}

/** 造一条「看起来像旧版本留下的」记录 */
export function legacy(extra) {
  return {
    path: join(OUTSIDE, 'note.txt'),
    grantedAt: Date.now(),
    reason: '历史记录',
    ...extra,
  }
}

/** 当前授权表里还剩几条（判「有没有被提前消耗」就看它） */
export function live() {
  return store.all().grants.filter((item) => Boolean(item))
}

/**
 * 读一次文件，但让用例**自己指定 ctx**。
 *
 * 用来钉「这次调用是谁」这件事：真实链路里出现过只带 `threadId` 的 ctx
 * （`_shared.cjs` 的历史写法），检查和落授权必须是同一个身份，否则会出现
 * 「检查放行、授权落不下去 → 重试还是拒绝」= C-1 主诉。
 *
 * @param {string} file
 * @param {{ sessionId?: string, threadId?: string, permission?: string }} overrides
 * @param {boolean} answer 确认卡怎么答
 */
export async function readWithCtx(file, overrides, answer) {
  let asked = 0
  const text = await tools.execute(
    'read_file',
    { path: file },
    {
      ...overrides,
      workdir: SANDBOX,
      permission: overrides.permission ?? 'ask',
      granted: new Map(),
      confirm: async () => {
        asked += 1
        return answer
      },
    },
  )
  return { text: String(text), asked }
}

/**
 * 按某个权限档位读一次文件。
 *
 * ★ 一定要传 `confirm`：真实运行时 `handlers/chat.cjs` 总会传它，
 *   而 `tools/permission.cjs` 在**没有** confirm 时会先返回错误 ——
 *   不传的话「full 档不问」这类断言测的其实是「没有确认通道」那条分支。
 *
 * @returns {Promise<{ text: string, asked: number }>}
 */
export async function readWith(file, permission, sessionId, answer) {
  let asked = 0
  const text = await tools.execute(
    'read_file',
    { path: file },
    {
      workdir: SANDBOX,
      permission,
      sessionId,
      granted: new Map(),
      confirm: async () => {
        asked += 1
        return answer
      },
    },
  )
  return { text: String(text), asked }
}

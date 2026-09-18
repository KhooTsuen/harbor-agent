/**
 * 破坏性测试 D 组 · 不需要模型介入的几项
 *
 * D2  工具返回 10MB 输出 → 截断生效吗、会不会撑爆
 * D3  工具抛异常 → 循环会继续还是整轮死掉
 * D7  权限确认框一直不点 → 会永久挂着吗
 * D8  用量闸 → 能不能真的拦住
 *
 *   node tools/break-test-loop.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
const limits = require(join(ROOT, 'electron/core/limits.cjs'))

const workdir = join(ROOT, 'test-env', 'PersonalAgent', 'data', 'workspace')

function ctx(extra = {}) {
  return {
    workdir,
    permission: 'full',
    shellTimeout: 30,
    log: { info() {}, warn() {}, error() {} },
    sessionId: `break-loop-${Date.now()}`,
    taskId: 'break-loop',
    shellPolicy: { medium: 'allow', high: 'allow', critical: 'allow' },
    confirm: async () => true,
    ...extra,
  }
}

console.log('══ D2：工具返回超大输出（10MB）══')
{
  const t0 = Date.now()
  const out = await tools.execute(
    'run_shell',
    {
      command:
        'node -e "for(let i=0;i<100000;i++)console.log(\'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\')"',
    },
    ctx(),
  )
  const text = String(out)
  console.log(`  命令跑完 ${Date.now() - t0}ms | 返回长度 ${text.length} 字符`)
  console.log(
    `  ${text.length <= 9000 ? '✓ 截断了（上限 8000 + 提示尾巴）' : '⚠️ 没截断，可能撑爆上下文'}`,
  )
  console.log(`  尾部：${text.slice(-100).replace(/\n/g, ' ')}`)
}

console.log('\n══ D3：工具抛异常（不存在的文件 / 空命令）══')
for (const [label, name, args] of [
  ['read_file 一个不存在的文件', 'read_file', { path: 'no-such-file-xyz.txt' }],
  ['run_shell 空命令', 'run_shell', { command: '' }],
  ['edit_file 原文对不上', 'edit_file', { path: 'x.txt', oldText: 'zzz', newText: 'y' }],
]) {
  try {
    const out = await tools.execute(name, args, ctx())
    console.log(
      `  ✓ ${label} → 返回了错误文本（没抛）: ${String(out).slice(0, 70).replace(/\s+/g, ' ')}`,
    )
  } catch (error) {
    console.log(
      `  ✓ ${label} → 抛错（会被循环接住）: ${String(error?.message ?? error).slice(0, 70)}`,
    )
  }
}

console.log('\n══ D7：权限确认框一直不点 ══')
{
  /*
   * 真实实现（handlers/chat.cjs 的 askUser）有个 CONFIRM_TIMEOUT_MS 超时，
   * 到点 resolve(false)。这里模拟「永远不回」—— 看有没有兜底。
   */
  const neverRespond = () => new Promise(() => {})
  const t0 = Date.now()
  const race = await Promise.race([
    tools
      .execute(
        'read_file',
        { path: join(ROOT, 'data', 'config.json') },
        ctx({ confirm: neverRespond }),
      )
      .then(() => '工具返回了')
      .catch((error) => `工具抛错：${String(error?.message ?? error).slice(0, 60)}`),
    new Promise((r) =>
      setTimeout(() => r('⚠️ 8 秒了还没动静（工具层自己没有超时，靠上层 askUser 兜）'), 8000),
    ),
  ])
  console.log(`  ${race}`)
  console.log(`  耗时 ${Date.now() - t0}ms`)
}

console.log('\n══ D8：用量闸 ══')
{
  console.log(`  limits 导出：${Object.keys(limits).join(', ')}`)
  /* 用一个肯定会超的预算试 */
  const fakeEmit = () => {}
  const fakeConfig = { limits: { enabled: true, maxTotalTokens: 1, maxTokensPerTurn: 1 } }
  try {
    limits.enforce
      ? await limits.enforce(fakeEmit, fakeConfig)
      : console.log('  （enforce 签名不同，跳过）')
    console.log('  enforce 没抛 —— 可能依赖内部状态')
  } catch (error) {
    console.log(`  ✓ enforce 抛了：${String(error?.message ?? error).slice(0, 90)}`)
  }
}

/**
 * 破坏性测试 D 组 · 不需要模型介入的几项
 *
 * D2  工具返回 10MB 输出 → 截断生效吗、会不会撑爆
 * D3  工具抛异常 → 循环会继续还是整轮死掉
 * D7  权限确认框一直不点 → 工具层自己超时按「拒绝」返回吗（8 秒内）
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
   * 两层兜底，这条测的是**工具层**那层：
   *   ① electron/core/tools/approval.cjs 的 `ctx.confirmTimeoutMs`（默认 10 分钟）
   *   ② 真实界面 handlers/chat.cjs 的 CONFIRM_TIMEOUT_MS（5 分钟，到点 resolve(false)）
   * ① 以前**根本不存在** —— confirm 永不 resolve 就等于把这轮工具调用永久挂起，
   * 上层弹窗一旦没弹出来，工具层不会自己醒。
   *
   * 所以这里给一个永不 resolve 的 confirm + 1.5 秒的兜底超时，
   * 期望：**1.5 秒左右**就按「拒绝」返回，而不是 8 秒还没动静。
   */
  const neverRespond = () => new Promise(() => {})
  const t0 = Date.now()
  const outcome = await Promise.race([
    tools
      .execute(
        'read_file',
        { path: join(ROOT, 'data', 'config.json') },
        ctx({ confirm: neverRespond, confirmTimeoutMs: 1500 }),
      )
      .then(
        (out) => ({ how: 'returned', text: String(out) }),
        (error) => ({ how: 'threw', text: String(error?.message ?? error) }),
      ),
    new Promise((r) => setTimeout(() => r({ how: 'hang', text: '' }), 8000)),
  ])
  const elapsed = Date.now() - t0
  console.log(`  耗时 ${elapsed}ms`)
  console.log(`  返回：${outcome.text.slice(0, 110).replace(/\s+/g, ' ')}`)
  if (outcome.how === 'hang') {
    console.log('  ⚠️ 8 秒了还没动静 —— 工具层没兜底，只能靠上层 askUser 救')
  } else if (/拒绝/.test(outcome.text)) {
    console.log('  ✓ 工具层自己兜住了：没等到答复就按「拒绝」返回（不挂死）')
  } else {
    console.log('  ? 返回的不是拒绝文本 —— 这条可能压根没走到确认（路径本来就允许）')
  }
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

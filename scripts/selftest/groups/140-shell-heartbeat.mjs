import { check, group } from '../harness.mjs'
import { ROOT, join, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   B1（Phase 5）：`run_shell` 长命令期间的**周期心跳**

   为什么只能在这儿守：渲染层的兜底时钟判的是「连续多久没收到 `chat:event`」（300s），
   而 `run_shell` 单条命令允许跑到 600s。**不发心跳**的话，一条正常的长命令会被
   必然误判成卡死 —— 界面退订事件流、后台还在跑，稍后的 `done` 落进已退订的订阅里
   被静默丢弃（用户看到的就是「它自己中断了，可任务最后又完成了」）。
   完整定位见 docs/research/phase5-turn-lifecycle-design.md。

   这里**真跑一遍**（不是只读源码）：把心跳间隔用 env 口子调小到几百毫秒，
   跑一条 ~800ms 的命令，数一数 `ctx.progress` 被调了几次；再确认命令结束后它停了。

   ⚠️ 心跳间隔在**每次调用时**读 env（见 run_shell.cjs 的 heartbeatMs）——
   不能在模块加载时求值：别的自检组会先把 run_shell 模块 require 进来。
   ══════════════════════════════════════════════════════════════ */

const KEY = 'HARBOR_SHELL_HEARTBEAT_MS'

export async function run() {
  group('工具 / run_shell 周期心跳（B1）')

  process.env[KEY] = '150'
  const runShell = require(join(ROOT, 'electron/core/tools/run_shell.cjs'))

  const notes = []
  let calls = 0
  const ctx = {
    workdir: ROOT,
    shellTimeout: 30,
    signal: new AbortController().signal,
    /* 工具自报进度：事件 `agent.tool.progress` 的载荷（见 tool-run-ctx.cjs） */
    progress: (payload = {}) => {
      calls += 1
      notes.push(String(payload.note ?? ''))
    },
  }

  /* 一条「静默」约 800ms 的命令（不发任何输出，模拟 `npm run verify` 那类长活） */
  const cmd = `${JSON.stringify(process.execPath)} -e "setTimeout(function(){}, 800)"`
  const out = await runShell.run({ command: cmd }, ctx)

  check(
    '★ 长命令期间真的在发心跳（≥ 2 次）',
    calls >= 2,
    `progress 被调了 ${calls} 次（期望 ≥2；间隔 150ms，命令 ~800ms）`,
  )
  check(
    '心跳带的是「还在跑」的说明（不是假的百分比）',
    notes.every((n) => n.includes('还在跑')),
    JSON.stringify(notes.slice(0, 3)),
  )
  check('命令本身正常跑完（心跳没有干扰它）', String(out).includes('[退出码 0]'), String(out))

  /* 命令结束后心跳必须停 —— 不然白醒、拖住进程退出 */
  const after = calls
  await new Promise((r) => setTimeout(r, 500))
  check('★ 命令结束后心跳停了（不白醒、不拖住退出）', calls === after, `又涨到 ${calls}`)

  delete process.env[KEY]
}

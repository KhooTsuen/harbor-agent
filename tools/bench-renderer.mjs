#!/usr/bin/env node
/*
 * AG-038 渲染器基准（真机）
 *
 *   node tools/bench-renderer.mjs
 *
 * 做三件事：
 *   ① 造一份极端数据的会话（1000 条消息 + 一条带一万个工具调用的消息），
 *      写进隔离副本的数据目录；
 *   ② 用打包好的可执行文件跑 `tools/bench-renderer-probe.js`；
 *   ③ 把量出来的数字打出来。
 *
 * 为什么必须有这个（而不是只看单元基准）：jsdom 里没有排版、没有合成层，
 * 毫秒数只能当相对值；「卡不卡顿」终究要在**真的 Chromium**里量。
 * 单元基准（`src/components/chat/__tests__/rendererPerf.test.tsx`）负责
 * 「别退化成 O(n²)」，这个脚本负责「真机上是不是真能看」。
 *
 * 前置：`npm run build && npm run package`，并且把 `dist-portable/PersonalAgent`
 * 拷一份到 `tmp/smooth-env/PersonalAgent`（见 README 的验证流程）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENV = join(ROOT, 'tmp/smooth-env/PersonalAgent')
const EXE = join(ENV, 'PersonalAgent.exe')

if (!existsSync(EXE)) {
  console.error(
    `没找到打包好的应用：${EXE}\n先 npm run build && npm run package，再拷一份到 tmp/smooth-env/。`,
  )
  process.exit(1)
}

/* ── ① 造数据 ─────────────────────────────────────────────── */
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const paths = require(join(ROOT, 'electron/core/paths.cjs'))
paths.markPackaged(ENV)

const sessionCore = require(join(ROOT, 'electron/core/session.cjs'))

const LONG = 1000
const TOOL_EVENTS = 10_000

function seedLongSession() {
  const session = sessionCore.create({
    title: '极端数据 · 1000 条消息',
    workdir: join(ROOT, 'tmp/real-ws'),
  })
  for (let i = 1; i <= LONG; i += 1) {
    sessionCore.append(session.id, {
      id: `bench_m${i}`,
      threadId: session.id,
      role: i % 2 === 0 ? 'assistant' : 'user',
      kind: 'text',
      content: `第 ${i} 条消息：这是一段用来量渲染的正文，**有点 md**，还有 \`行内代码\`。`,
      status: 'sent',
      timestamp: 1700000000000 + i,
    })
  }
  return session.id
}

function seedToolSession() {
  const session = sessionCore.create({
    title: '极端数据 · 一万个工具事件',
    workdir: join(ROOT, 'tmp/real-ws'),
  })
  const runs = Array.from({ length: TOOL_EVENTS }, (_, i) => ({
    id: `bench_r${i}`,
    name: 'read_file',
    ok: true,
    output: '',
    ms: 5,
    summary: `读了第 ${i} 个文件`,
  }))
  sessionCore.append(session.id, {
    id: 'bench_tools',
    threadId: session.id,
    role: 'assistant',
    kind: 'text',
    content: '一口气读了一万个文件。',
    status: 'sent',
    timestamp: 1700000000000,
    toolRuns: runs,
  })
  return session.id
}

mkdirSync(join(ENV, 'data/sessions'), { recursive: true })
const longId = seedLongSession()
const toolId = seedToolSession()
console.log(`造好数据：长会话 ${longId}（${LONG} 条）· 工具会话 ${toolId}（${TOOL_EVENTS} 个）`)

/* ── ② 跑探针 ─────────────────────────────────────────────── */
const result = spawnSync(
  process.execPath,
  [
    join(ROOT, 'tools/shot-electron.mjs'),
    `--exe=${EXE}`,
    `--out=${join(ROOT, 'tmp/shots-bench')}`,
    `--js-file=${join(ROOT, 'tools/bench-renderer-probe.js')}`,
  ],
  { cwd: ROOT, stdio: 'inherit' },
)

/* ── ③ 结果 ───────────────────────────────────────────────── */
console.log('\n基准跑完，把上面「执行脚本」那行的数字抄进 CHANGELOG 的对比表。')
writeFileSync(
  join(ROOT, 'tmp/bench-last.md'),
  `# 最近一次基准\n\n会话：${LONG} 条消息 / ${TOOL_EVENTS} 个工具事件\n`,
  'utf8',
)
process.exit(result.status ?? 0)

#!/usr/bin/env node
/**
 * 契约登记表（C1）——「同一个跨模块约定：真值在哪个文件、谁必须跟它一致、
 * 有没有自检钉住」的**一处清单**，并**自检这张表本身**。
 *
 * 用法：`npm run contracts`
 *
 * 起点：审计（docs/Architecture Reality Audit.md §3）把「同一事实多处表达」列成了散文；
 * 这里改成机器可读的一行一条 —— 谁是真值、镜像是谁、钉子在哪，一眼看全。
 *
 * ⚠️ 它只回答 **Q1「谁定义了什么、定义了几次」**，**不回答 Q2「这两处是不是同一件事」**——
 *    Q2 要判断（`level` 在 risk 是「危险度」，在 scale 是「要不要问」，同名不同义），
 *    机械判不了。见 docs/research/truth-map-design.md §1：
 *    **机械可以「找候选」，不可以「下判决」** —— 找候选的活归 `npm run dup`。
 *
 * 字段：
 *   id                短标识
 *   name              人话名字
 *   sot               唯一真相源文件（真值所在）
 *   mirrors           必须与 sot 逐字一致的镜像（可空）
 *   pin               钉住它的自检组名（scripts/selftest/groups/<pin>.mjs）；null = **没钉（缺口）**
 *   driftConsequence  '不一致但报错'（有钉子兜）| '静默出错'（没钉子）| '只是冗余'
 *
 * 加一条契约前**先确认真值文件** —— 路径写错，这张表自己就先漂了（命令会报红）。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const GROUP_DIR = path.join('scripts', 'selftest', 'groups')

export const CONTRACTS = [
  {
    id: 'chat-event-types',
    name: '聊天事件 type 全集（主进程 → 渲染层）',
    sot: 'electron/core/event-types.cjs',
    mirrors: ['src/types/events.ts'],
    pin: '126-event-types',
    driftConsequence: '不一致但报错',
  },
  {
    id: 'agent-event-names',
    name: '生命周期事件标准名（agent.*）',
    sot: 'electron/core/event-types.cjs',
    mirrors: ['src/types/events.ts'],
    pin: '126-event-types',
    driftConsequence: '不一致但报错',
  },
  {
    id: 'decision-types',
    name: '决策类型（approval / clarify）',
    sot: 'electron/core/decisions.cjs',
    mirrors: ['src/types/decision.ts'],
    pin: '125-decision-shape',
    driftConsequence: '不一致但报错',
  },
  {
    id: 'ipc-channels',
    name: 'IPC 通道清单',
    sot: 'electron/ipc-channels.cjs',
    mirrors: [],
    pin: '134-ipc-channels',
    driftConsequence: '不一致但报错',
  },
  {
    id: 'decision-event-names',
    name: '决策卡事件名（confirm_request / *.timeout）',
    sot: 'electron/core/event-types.cjs',
    mirrors: ['electron/core/decisions.cjs'],
    pin: '141-decision-event-names',
    driftConsequence: '不一致但报错',
  },
]

/** 自检这张表：引用的路径 / 自检组必须真实存在，否则表自己就漂了 */
export function checkRegistry(root = ROOT) {
  const errors = []
  const unpinned = []
  for (const c of CONTRACTS) {
    if (!existsSync(path.join(root, c.sot))) errors.push(`${c.id}：真值文件不存在 → ${c.sot}`)
    for (const m of c.mirrors) {
      if (!existsSync(path.join(root, m))) errors.push(`${c.id}：镜像文件不存在 → ${m}`)
    }
    if (c.pin === null) unpinned.push(c.id)
    else if (!existsSync(path.join(root, GROUP_DIR, `${c.pin}.mjs`))) {
      errors.push(`${c.id}：自检组不存在 → ${c.pin}`)
    }
  }
  return { errors, unpinned, total: CONTRACTS.length }
}

function main() {
  const { errors, unpinned, total } = checkRegistry()
  console.log('═══ Harbor 契约登记表（真相源）═══')
  console.log('（Q1：谁定义了什么、定义了几次。Q2「是不是同一件事」要人判断 —— 见 npm run dup）\n')

  CONTRACTS.forEach((c, i) => {
    console.log(`${i + 1}. ${c.name}   [${c.id}]`)
    console.log(`   真值   ${c.sot}`)
    console.log(`   镜像   ${c.mirrors.length ? c.mirrors.join('  ·  ') : '（无）'}`)
    console.log(`   钉子   ${c.pin ?? '⚠ 没有'}`)
    console.log(`   漂了   ${c.driftConsequence}`)
    console.log('')
  })

  console.log(`共 ${total} 条契约；其中 ${unpinned.length} 条没有自检钉住（缺口）：`)
  if (unpinned.length) for (const id of unpinned) console.log(`  ⚠ ${id}`)
  else console.log('  （无）')

  if (errors.length) {
    console.error('\n✗ 登记表自身有问题（路径 / 自检组对不上）：')
    for (const e of errors) console.error(`  • ${e}`)
    process.exit(1)
  }
  console.log('\n✓ 登记表里引用的文件与自检组都存在')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()

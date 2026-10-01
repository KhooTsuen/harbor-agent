/**
 * 内核 `.cjs` 的未定义标识符扫描（AG-053 批④）
 *
 * 为什么单独一个脚本而不是直接 `eslint electron`：
 *   ① 有一条**已知但不在本批范围内**的发现（见下面 KNOWN），
 *      直接跑会红；而这个项目**不许用 `eslint-disable` 注释**压掉（硬约束 #1）。
 *   ② 「允许清单过期」也要红 —— 修好了却留着清单，等于把闸门焊死。
 *
 * 跑：node scripts/lint-kernel.mjs       通过 → 0；有新的 / 清单过期 → 1
 *
 * ⚠️ 规则本身在 `eslint.config.js` 的 `electron/**\/*.cjs` 那一块（只开 `no-undef`）。
 *   不直接进 `npm run lint`（那个只管 `src`），而是作为 `verify` 里独立一步 ——
 *   「内核不过 tsc」这条线的补丁就打在这儿。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * 已知的未定义标识符（**待修，不是豁免**）。
 *
 * 每条都要写清「为什么先留着」+「怎么才能删掉」。修好了必须删条目，
 * 否则这个脚本会报「允许清单过期」。
 */
export const KNOWN = [
  {
    file: path.join('electron', 'handlers', 'shell.cjs'),
    name: 'inspectCommand',
    why:
      '预览终端（PTY 不可用时的那个假终端）里跑命令会抛。真机上 PTY 可用、走不到这条路，' +
      '所以一直没暴露。修法＝改用 risk.classify（别处都是这么用的），**等确认**（不在本批改动范围内）。',
  },
]

function runEslint() {
  const eslint = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
  const result = spawnSync(
    process.execPath,
    [eslint, 'electron', '--ext', '.cjs', '--format', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.error) throw result.error
  const raw = (result.stdout ?? '').trim()
  if (!raw) return []
  return JSON.parse(raw)
}

/** 把 ESLint 的结果摊平成「文件 + 名字」的发现清单 */
function findingsOf(results) {
  const out = []
  for (const file of results) {
    const rel = path.relative(ROOT, file.filePath)
    for (const message of file.messages) {
      /* 只看 no-undef；别的（比如引用了不存在的规则）单独报出来，不当成豁免项 */
      if (message.ruleId === 'no-undef') {
        const name = String(message.message).match(/'([^']+)' is not defined/)?.[1] ?? message.message
        out.push({ file: rel, name, line: message.line, other: false })
      } else {
        out.push({ file: rel, name: `${message.ruleId ?? '（无规则）'}: ${message.message}`, line: message.line, other: true })
      }
    }
  }
  return out
}

function main() {
  let results
  try {
    results = runEslint()
  } catch (error) {
    console.error(`跑 eslint 失败：${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }

  const all = findingsOf(results)
  const knownHit = new Set()
  const fresh = []
  for (const one of all) {
    if (one.other) {
      fresh.push(one)
      continue
    }
    const match = KNOWN.find((k) => k.file === one.file && k.name === one.name)
    if (match) knownHit.add(`${match.file}·${match.name}`)
    else fresh.push(one)
  }

  const scanned = results.length
  if (fresh.length === 0 && knownHit.size === KNOWN.length) {
    console.log(`✓ 内核 ${scanned} 个 .cjs：没有未定义的标识符（允许清单 ${KNOWN.length} 条仍待修）`)
    for (const one of KNOWN) {
      console.log(`   · 待修：${one.file} · ${one.name} —— ${one.why}`)
    }
    process.exit(0)
  }

  if (fresh.length > 0) {
    console.error(`✗ 内核 ${scanned} 个 .cjs 里发现 ${fresh.length} 处问题：`)
    for (const one of fresh) {
      console.error(`   ${one.file}:${one.line}  ${one.name}`)
    }
    console.error(
      '\n这类名字写错**不会**被 tsc、`node --check`、单测任何一种方式抓到（内核不参与 tsc），' +
        '\n只能靠真跑到那一步才现形 —— 所以它必须在这里红。',
    )
  }

  const stale = KNOWN.filter((k) => !knownHit.has(`${k.file}·${k.name}`))
  if (stale.length > 0) {
    console.error(`\n✗ 允许清单过期了（已经修好 / 名字变了）—— 请删掉这几条：`)
    for (const one of stale) console.error(`   ${one.file} · ${one.name}`)
  }
  process.exit(1)
}

/* 被 import 时只导出（测试要拿 KNOWN），直接跑才执行 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
}

/**
 * 内核 `.cjs` 的类型棘轮（checkJs 基线）
 *
 * 为什么要有它：
 *   内核 `.cjs` **不参与 `tsc`**（`tsconfig.json` 只 include `src`），
 *   所以 `scripts/lint-kernel.mjs` 只补了 `no-undef` 一条 ——
 *   属性名写错、给「只许 true 的字段」赋 false、把数字和字符串比较……
 *   这类只有类型检查才抓得到的问题，过去全凭人肉。
 *
 * 为什么用「基线」而不是「一次修干净」：
 *   2026-10-09 实测：`checkJs`（strict:false）下内核 256 个 `.cjs` 有
 *   **208 条**错误、摊在 82 个文件里；而且内核互相 import，
 *   想只挑「干净文件」单独开关是做不到的（被引用的脏文件会被一起拉进来）。
 *   一次性修完是几十个文件的工程，会碰上 AGENT.md 的硬禁区。
 *   所以这里只上一条**棘轮**：把现状拍成基线，**只许往下走**。
 *
 *   · 出现基线里没有的错（新文件 / 新错误码 / 同码数量变多）→ 红
 *   · 基线里的错被修掉（数量变少）→ 也红，提示同步下调基线
 *     （不然基线会变成「焊死的闸门」—— 和 `lint-kernel.mjs` 的 KNOWN 一个道理）
 *
 * 跑：`npm run typecheck:kernel`             对基线 → 0；漂了 → 1
 *      `npm run typecheck:kernel -- --write-baseline`   重拍基线（只在核对过之后用）
 *
 * 基线文件：`scripts/kernel-types-baseline.json`（key = 文件 → 错误码 → 条数，
 * 与行号无关 —— 上游插一行不会让整份基线全红）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONFIG = path.join(ROOT, 'tsconfig.kernel.json')
const BASELINE = path.join(ROOT, 'scripts', 'kernel-types-baseline.json')

function runTsc() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '-p', CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/** tsc 输出 → `{ 文件: { 错误码: 条数 } }`（与行号无关） */
function parse(output) {
  const map = {}
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+):/)
    if (!m) continue
    const abs = path.resolve(ROOT, m[1])
    const file = path.relative(ROOT, abs).replace(/\\/g, '/')
    const code = m[4]
    if (!map[file]) map[file] = {}
    map[file][code] = (map[file][code] ?? 0) + 1
  }
  return map
}

function countAll(map) {
  let n = 0
  for (const file of Object.keys(map)) for (const code of Object.keys(map[file])) n += map[file][code]
  return n
}

function loadBaseline() {
  const raw = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  return raw.entries ?? {}
}

/** 实际 vs 基线：返回新增的与「已被修掉的」两组差异 */
function compare(actual, baseline) {
  const added = []
  const fixed = []
  const files = new Set([...Object.keys(actual), ...Object.keys(baseline)])
  for (const file of files) {
    const a = actual[file] ?? {}
    const b = baseline[file] ?? {}
    for (const code of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const an = a[code] ?? 0
      const bn = b[code] ?? 0
      if (an > bn) added.push({ file, code, n: an - bn })
      else if (an < bn) fixed.push({ file, code, n: bn - an })
    }
  }
  return { added, fixed }
}

function writeBaseline(actual) {
  const data = {
    note: '内核 .cjs 的 checkJs 基线：只许下调（修一条改一条），不许上涨。重拍：npm run typecheck:kernel -- --write-baseline',
    total: countAll(actual),
    entries: actual,
  }
  fs.writeFileSync(BASELINE, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`✓ 基线已写入 scripts/kernel-types-baseline.json：${data.total} 条 / ${Object.keys(actual).length} 个文件`)
}

function main() {
  let output
  try {
    output = runTsc()
  } catch (error) {
    console.error(`跑 tsc 失败：${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }

  if (output.includes('error TS18003')) {
    console.error(
      '✗ tsc 报告 TS18003（配置没指到任何输入文件）——\n' +
        '  tsconfig.kernel.json 的 include 八成没匹配到 electron/**/*.cjs。\n' +
        '  直接判红：一份「扫不到文件」的检查等于没有。',
    )
    process.exit(1)
  }

  const actual = parse(output)

  if (process.argv.includes('--write-baseline')) {
    if (countAll(actual) === 0) {
      console.error('✗ 一条错都没解析到 —— 拒绝把空基线写进去（那会让检查永远绿）。检查 tsconfig.kernel.json。')
      process.exit(1)
    }
    writeBaseline(actual)
    process.exit(0)
  }

  const baseline = loadBaseline()
  const { added, fixed } = compare(actual, baseline)

  if (added.length === 0 && fixed.length === 0) {
    console.log(
      `✓ 内核 ${Object.keys(actual).length} 个 .cjs 的类型错误与基线一致（基线 ${countAll(baseline)} 条，只许下调）`,
    )
    process.exit(0)
  }

  if (added.length > 0) {
    console.error(`✗ 出现基线里没有的类型错误 ${added.length} 处：`)
    for (const one of added) console.error(`   ${one.file}  ${one.code} × ${one.n}`)
    console.error(
      '\n这类问题过不了 tsc、`node --check` 和单测（内核不参与 tsc），只能在这里挡。\n' +
        '修掉它，而不是往基线里加 —— 基线是「欠债清单」，不是「豁免清单」。',
    )
  }
  if (fixed.length > 0) {
    console.error(`\n✗ 有 ${fixed.length} 处比基线少（已经修好 / 文件挪了）—— 请同步下调基线：`)
    for (const one of fixed) console.error(`   ${one.file}  ${one.code}  -${one.n}`)
    console.error('\n跑 `npm run typecheck:kernel -- --write-baseline` 重拍（确认没顺手改坏别处再用）。')
  }
  process.exit(1)
}

main()

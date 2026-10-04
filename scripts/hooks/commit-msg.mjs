/* commit-msg：提交标题的前缀闸门
 *
 * 规矩写在 [`CONTRIBUTING.md`](../../CONTRIBUTING.md) 的「提交标题的格式」。
 * ★ **词表只有一份定义，就在本文件里** —— 文档那张表是给人看的摘要，判定一律以这里为准；
 *   想看当前真的词表：`node scripts/hooks/commit-msg.mjs --list`。
 *   （这也是硬约束 8 的老规矩：会变/易抄的清单只准「一份定义 + 命令输出」。）
 *
 * 为什么要有它：这条规矩定下来之前，标题前缀混着十几种写法（`修：` / `测试：` / `test:` /
 * `style:` / 有的干脆没前缀），仓库首页那一列看着就是乱的。文档拦不住人，钩子能 ——
 * 也正是本项目的原则：**拿不出检查方式的规矩不算约束**（`AGENT.md` 第 2 节）。
 *
 * git 调用时传一个参数：提交信息**文件**的路径（通常是 `.git/COMMIT_EDITMSG`）。
 * 放行：合并 / 回滚 / rebase 的 fixup —— 那些标题是 git 自己写的，不该由我们管。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, step } from './lib.mjs'

/** 前缀词表：[前缀, 用在]。**改词表就是改这一处**（文档那张表跟着它走）。 */
export const PREFIXES = [
  ['功能', '新增用户看得见的能力'],
  ['修', '修 bug、修回归、改格式'],
  ['拆', '只挪结构、行为不变（拆文件、抽模块）'],
  ['检查', '测试 / 自检 / 检查脚本 / CI / 钩子'],
  ['文档', '只动 .md'],
  ['规矩', 'AGENT.md、流程、约束机制'],
  ['收尾', '一批活的收口（台账、验证数字）'],
  ['杂项', '兜底：仓库卫生 / 依赖 / 环境配置'],
]

/** git 自己造的标题不受这条管 */
const BYPASS = /^(?:Merge\b|Revert\b|fixup!|squash!|amend!)/

/** 取标题行：跳过空行与 `#` 注释（git 会往提交信息文件里塞注释） */
export function subjectOf(text) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    return line
  }
  return ''
}

/** 标题合不合规矩。只判不打印（测试要用），返回 `{ ok, reason? }` */
export function checkSubject(subject) {
  const line = String(subject ?? '').trim()
  if (line === '') return { ok: false, reason: '标题是空的' }
  if (BYPASS.test(line)) return { ok: true }
  if (PREFIXES.some(([prefix]) => line.startsWith(`${prefix}：`))) return { ok: true }

  /* 最常见的两种错法直接点出来，别只说「不合规」 */
  const halfWidth = PREFIXES.find(([prefix]) => line.startsWith(`${prefix}:`))
  if (halfWidth) {
    return { ok: false, reason: `前缀「${halfWidth[0]}」后面要用**全角**冒号（${halfWidth[0]}：……）` }
  }
  return { ok: false, reason: '没有前缀，或前缀不在词表里' }
}

/** 给人看的词表（`--list` 与拦截时的提示都用它） */
export function table() {
  return PREFIXES.map(([prefix, use]) => `  ${prefix}：  ${use}`).join('\n')
}

function main() {
  const [first] = process.argv.slice(2)

  if (first === '--list') {
    console.log('提交标题前缀词表（唯一定义：scripts/hooks/commit-msg.mjs）')
    console.log(table())
    return 0
  }

  if (!first) {
    console.log('用法：node scripts/hooks/commit-msg.mjs <提交信息文件>')
    console.log('      node scripts/hooks/commit-msg.mjs --list   # 看当前词表')
    return 1
  }

  let text = null
  try {
    text = fs.readFileSync(first, 'utf8')
  } catch {
    /* 读不到就别拦：钩子不该因为环境问题把人堵死。但也不装作查过了 */
    console.log(`\n[钩子] 读不到提交信息文件（${first}）—— 这次不检查标题格式`)
    return 0
  }

  step('提交标题格式')
  const subject = subjectOf(text)
  const verdict = checkSubject(subject)
  if (verdict.ok) {
    console.log(`[钩子] ✓ ${subject}`)
    return 0
  }

  fail(`提交标题不合规矩：${verdict.reason}`, '规矩见 CONTRIBUTING.md 的「提交标题的格式」')
  console.log('\n[钩子] 当前词表：')
  console.log(table())
  console.log(`\n[钩子] 你写的是：${subject || '（空）'}`)
  return 1
}

/* 只有直接跑才执行 —— meta 测试要 import 上面那几个函数 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}

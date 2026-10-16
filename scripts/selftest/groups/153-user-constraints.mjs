/**
 * 自检 / 本轮用户约束判定（「只分析，不修改」）
 *
 * 本组钉的是 **2026-10-15 那次真机事故的回归钉子**：
 *
 *   用户给模型写了一条**输出要求** ——「凡是你没能在网页上核实的，一律标注
 *   「未验证」，**不许写成确定的事实**」—— 里面那三个字「不许写」命中了内核
 *   的正则 `/(…|不许写|…)/`，于是整整一轮 `allowWrite=false`，
 *   `browse` / `run_shell` / `write_file` 全被拒（装机版
 *   `errors/2026-10-15.jsonl` 16:46–16:49 六条全是这个）。
 *
 * 三条要求（用户拍板 A+B+C 一起做）：
 *
 *   A. **泛动词必须带宾语**才算约束 ——「不许写成确定的事实」不再算「别动东西」；
 *   B. 反向的**不能松**：真说「不要改我的文件」必须仍然拦住；
 *   C. 纯读的浏览工具（browse / elements / nav / ax）**不再**被「只分析」拦 ——
 *      那句话的本意是「别改我的文件」，不是「别读网页」。
 *      但 `browse_click` / `browse_type` **仍拦**（会改变外部状态）。
 *
 * ⚠️ 这组用的是**判据模块本身**（`core/user-constraints.cjs`），不是重写一份正则 ——
 *    重写一份就等于又开了第二处真相源（硬约束 9）。
 */

import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/** 2026-10-15 那次误判的**真实原文尾段**（照抄装机版那条会话） */
const REAL_ACCIDENT = `必须标注时效（发布日期 / 是否还在招）。

凡是你没能在网页上核实的，一律标注「未验证」，不许写成确定的事实。

区分「平台型」（如猪八戒、Upwork 这类接单平台）和「具体岗位」（某个公司正在招的某个职位）。`

export async function run() {
  const U = require(join(ROOT, 'electron/core/user-constraints.cjs'))
  const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))
  const loopSrc = require('node:fs').readFileSync(
    join(ROOT, 'electron/core/loop.cjs'),
    'utf8',
  )
  const indexSrc = require('node:fs').readFileSync(
    join(ROOT, 'electron/core/tools/index.cjs'),
    'utf8',
  )

  group('用户约束 · A/B 泛动词必须带宾语（2026-10-15 事故的回归钉子）')

  /* ★ 那条真实原文：这是整件事的由来，钉死在第一位 */
  check('★★ 真实事故原文（「不许写成确定的事实」）不再算禁写', U.noWriteIn(REAL_ACCIDENT) === false)
  check('★ 「不许写成代码」不算禁写', U.noWriteIn('不许写成代码，只描述思路') === false)
  check('★ 「不要修改结论」不算禁写（同类的输出要求）', U.noWriteIn('不要修改你的结论') === false)
  check('★ 「不要改动我的看法」不算禁写', U.noWriteIn('不要改动我的看法') === false)
  check('★ 「别写成文档」不算禁写（(?!成) 挡的固定搭配）', U.noWriteIn('别写成文档') === false)

  /* 反向：真说别动文件，必须拦住（B 不能松过头） */
  check('★ 「只分析，不修改」仍拦（明确短语）', U.noWriteIn('本轮只分析，不修改') === true)
  check('★ 「不要修改代码」仍拦（泛动词 + 文件类宾语）', U.noWriteIn('不要修改代码') === true)
  check('★ 「禁止修改文件」仍拦', U.noWriteIn('禁止修改文件') === true)
  check('★ 「不许写文件」仍拦', U.noWriteIn('不许写文件') === true)
  check('★ 「不要写文件」仍拦', U.noWriteIn('不要写文件') === true)
  check('★ 「不要改我的文件」仍拦', U.noWriteIn('不要改我的文件') === true)
  check('★ 「不许改动仓库」仍拦', U.noWriteIn('不许改动仓库') === true)
  check('★ 「别碰配置文件」仍拦', U.noWriteIn('别碰配置文件') === true)
  check('★ 「严禁删除文件」仍拦', U.noWriteIn('严禁删除文件') === true)
  check('★ 「不要覆盖项目目录」仍拦', U.noWriteIn('不要覆盖项目目录') === true)
  check('★ 「不准改脚本」仍拦', U.noWriteIn('不准改脚本') === true)

  /* 宾语窗口不能无限大：「不要写」隔了半句再说「文件」不算 */
  check(
    '★ 泛动词与宾语隔太远（>12 字）不算禁写',
    U.noWriteIn('不要写，先把这个东西的来龙去脉讲清楚，我那边有个文件想让你看看') === false,
  )
  check(
    '★ 宾语必须在同一句里（不跨句号）',
    U.noWriteIn('不要写。下面这段是文件的内容') === false,
  )

  group('用户约束 · 空与脏输入（判据不能自己炸）')

  check('★ 空串 → 不算禁写', U.noWriteIn('') === false)
  check('★ undefined → 不算禁写', U.noWriteIn(undefined) === false)
  check('★ 非字符串 → 不算禁写（不抛）', U.noWriteIn(12345) === false)

  group('用户约束 · 组合口径（显式设置优先于文本启发式）')

  check(
    '★ 会话级 allowWrite=false 一律禁写（不管文本说什么）',
    U.allowsWrite({ userText: '随便改', threadAllowWrite: false }) === false,
  )
  check('★ plan 模式一律禁写', U.allowsWrite({ userText: '随便改', mode: 'plan' }) === false)
  check('★ 普通文本 → 允许写', U.allowsWrite({ userText: '帮我改一下这个文件' }) === true)
  check('★ 事故原文 → 允许写（这就是修好的那一条）', U.allowsWrite({ userText: REAL_ACCIDENT }) === true)
  check(
    '★ 真说别动文件 → 禁止写',
    U.allowsWrite({ userText: '不要修改代码' }) === false,
  )
  check(
    '★ 联网判据保持原样（不联网 / 离线）',
    U.allowsNetwork({ userText: '离线跑' }) === false && U.allowsNetwork({ userText: '联网查' }) === true,
  )

  group('用户约束 · C 纯读浏览不再被「只分析」拦')

  const M = registry.MUTATING_TOOLS
  check('★ registry 导出了 MUTATING_TOOLS', Boolean(M))
  for (const name of ['browse', 'browse_elements', 'browse_nav', 'browse_ax']) {
    check(`★ ${name} 不在 MUTATING_TOOLS（纯读，不该被「只分析」拦）`, M.has(name) === false)
  }
  for (const name of ['browse_click', 'browse_type']) {
    check(`★ ${name} **仍在** MUTATING_TOOLS（会改变外部状态）`, M.has(name) === true)
  }
  for (const name of ['write_file', 'edit_file', 'run_shell', 'generate_image', 'remember', 'download']) {
    check(`★ ${name} 仍在 MUTATING_TOOLS`, M.has(name) === true)
  }
  check(
    '★ MUTATING_TOOLS ⊇ WRITE_TOOLS 里那些「会改外部状态」的（browse_click/type）',
    ['browse_click', 'browse_type', 'write_file', 'edit_file', 'run_shell'].every((n) => M.has(n) || !registry.WRITE_TOOLS.has(n)),
  )
  check(
    '★ browse 仍在 WRITE_TOOLS（readonly 档要拦、ask 档要确认 —— 这部分没动）',
    registry.WRITE_TOOLS.has('browse') === true,
  )

  group('用户约束 · 接线（真的被用上了，不是躺着的死代码）')

  check('★ loop.cjs 用的是 user-constraints（不再是内联正则）', /userConstraints\.allowsWrite/.test(loopSrc))
  check('★ loop.cjs 里不再有那条把「不许写」当约束的内联正则', !/不许写/.test(loopSrc))
  check(
    '★ 「只分析」那道门的判据是 MUTATING_TOOLS（不是 WRITE_TOOLS）',
    /ctx\.allowWrite === false && MUTATING_TOOLS\.has\(name\)/.test(indexSrc),
  )
  /*
   * ★ 口径改过（2026-10-16，接 edge_* 时）：那道门**不再只看 WRITE_TOOLS** ——
   *   edge_* 写类按用户拍板**不进** WRITE_TOOLS（「需要确认」档不弹风险框），但它们
   *   确实会改外部状态，只读档必须拦。所以判据是 `isWrite || MUTATING_TOOLS.has(name)`。
   */
  check(
    '★ readonly 那道门按 WRITE_TOOLS **或** MUTATING_TOOLS（edge_* 写类不在前者里）',
    /ctx\.permission === 'readonly' && \(isWrite \|\| MUTATING_TOOLS\.has\(name\)\)/.test(indexSrc),
  )
}

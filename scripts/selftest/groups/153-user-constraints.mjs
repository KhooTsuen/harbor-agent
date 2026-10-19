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

  /*
   * ── 2026-10-17 修掉的范围误判：**对象限定的禁改 ≠ 整轮只读** ──
   *
   * 病：`noWriteIn('不修改用户全局 Codex 配置')` 返回 true。那句话只是护住
   * 那一份配置，其余已授权的修改照做；判据却把它升级成整轮 allowWrite=false，
   * 于是 write_file / run_shell 全被拒（这条在真机上连拦了三次正常开发）。
   * 判据见 user-constraints.cjs 的 SCOPED_MODIFIER（看动词与宾语之间的修饰段）。
   */
  group('用户约束 · 对象限定 vs 整轮只读（2026-10-17 范围误判的回归钉子）')

  check('★★ 「不修改用户全局 Codex 配置」不算整轮禁写（只护那一份）', U.noWriteIn('不修改用户全局 Codex 配置') === false)
  check('★★ 「不修改稳定版 Harbor.exe」不算整轮禁写', U.noWriteIn('不修改稳定版 Harbor.exe') === false)
  check('★★ 「不修改历史审计记录」不算整轮禁写', U.noWriteIn('不修改历史审计记录') === false)
  check('★ 「只修改测试脚本，不要动正式数据」不算整轮禁写', U.noWriteIn('只修改测试脚本，不要动正式数据') === false)
  check('★★ 「只分析，不修改」仍拦（明确短语）', U.noWriteIn('只分析，不修改') === true)
  check('★★ 「不要修改任何代码或配置」仍拦（全局量词，不是具体对象）', U.noWriteIn('不要修改任何代码或配置') === true)
  check('★★ 「先调查，未经批准不要修改」仍拦（缺授权的分阶段要求）', U.noWriteIn('先调查，未经批准不要修改') === true)
  /*
   * ★ 全量词优先于具体限定：自测逮到的漏放 —— 「不要修改任何 .js 文件」的修饰段
   *   带着 `.` 和拉丁字母，只按 ②-b 会被当成"具体对象"而**放行**，但它指一整类。
   */
  check('★★ 全量词 + 英文后缀仍拦（「不要修改任何 .js 文件」不是具体对象）', U.noWriteIn('不要修改任何 .js 文件') === true)
  check('★ 全量词 + 专名仍拦（「不许改动任何项目文件」）', U.noWriteIn('不许改动任何项目文件') === true)
  check('★ 反过来：「先分析一下这个 bug 再改」不算禁写（已授权，只是要求顺序）', U.noWriteIn('先分析一下这个 bug 再改') === false)
  check('★ 对象限定不是放行它点名的对象：「不要改我的文件」仍拦', U.noWriteIn('不要改我的文件') === true)
  check('★ allowsWrite 口径跟着对：对象限定 → 允许写', U.allowsWrite({ userText: '不修改用户全局 Codex 配置' }) === true)
  check('★ allowsWrite 口径跟着对：缺授权 → 不许写', U.allowsWrite({ userText: '先调查，未经批准不要修改' }) === false)

  /*
   * ── 2026-10-17（3C-2）修掉的第五次误判：**文件类别**限定 ≠ 整轮只读 ──
   *
   * 真机现场：「不要改测试文件去迁就实现」—— 那是**只保护测试文件**，
   * 恰恰为了让修复必须改源码。判据却把它升级成整轮 allowWrite=false，
   * 于是 run_project_test 与 apply_test_fix 一起被拒，自举第一步就卡死。
   */
  group('用户约束 · 文件类别限定（3C-2 第五次误判的回归钉子）')
  check('★★★ 「不要改测试文件」不算整轮禁写（只护测试文件）', U.noWriteIn('不要改测试文件去迁就实现') === false)
  check('★★ 「别改测试」也不算整轮禁写', U.noWriteIn('别改测试') === false)
  check('★★ 「别动自检文件」同样放行', U.noWriteIn('别动自检文件') === false)
  check('★★★ 但全量词仍然拦：「不要修改任何测试文件」', U.noWriteIn('不要修改任何测试文件') === true)
  check('★★★ 「只分析，不修改任何文件」仍拦（这条不能被上面放软）', U.noWriteIn('本轮只分析，不修改任何文件') === true)

  /*
   * ── 2026-10-17（3B-1）修掉的第三次误判：**「缺授权」短语必须与动作同现** ──
   *
   * 病：`noWriteIn('未经批准创建新的 Git commit')` 返回 true。那句话是在**保护一个
   * 具体动作**（提交要单独批准），用户同一段里其实是在授权开发源码修改；判据只看
   * 「未经批准」四个字就整轮锁死，开发 Agent 连 run_shell / write_file 全被拒。
   *
   * 判据见 user-constraints.cjs 的 PHASED_LACK：短语后 10 字内必须出现写类动作。
   */
  group('用户约束 · 缺授权短语必须与动作同现（3B-1 误判的回归钉子）')

  check('★★★ 「未经批准创建新的 Git commit」不算整轮禁写（护的是一个动作）', U.noWriteIn('未经批准创建新的 Git commit') === false)
  check('★★★ 「不自动写入项目源码」不算整轮禁写（那是"写之前问我"）', U.noWriteIn('不自动写入项目源码') === false)
  check('★★ 「不清理临时文件，不创建 commit，不进入下一阶段」不算整轮禁写', U.noWriteIn('不清理既有临时文件，不创建 Git commit，不进入 3B-2') === false)
  check(
    '★★ 产品运行时只读的表述不锁死开发会话',
    U.noWriteIn('产品功能在运行时必须保持只读；这不限制开发 Agent 对源码进行经授权的修改') === false,
  )
  check('★★ 「只读检查，不执行写入」仍拦（同义明确短语）', U.noWriteIn('只读检查，不执行写入') === true)
  check('★★ 「未经批准不要实施修改」仍拦（短语后紧跟写类动作）', U.noWriteIn('先调查，未经批准不要实施修改') === true)
  check('★★ 「未经批准，先别动」仍拦', U.noWriteIn('未经批准，先别动') === true)
  check('★ 反向自证：「不要自动修改任何文件」不算整轮禁写（"自动"才是被否的）', U.noWriteIn('不要自动修改任何文件') === false)

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

  check('★ loop.cjs 用的是 user-constraints（不再是内联正则）',
    loopSrc.includes('buildToolContext(') && /userConstraints\.allowsWrite/.test(require('node:fs').readFileSync(join(ROOT, 'electron/core/loop-tool-context.cjs'), 'utf8')))
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

import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   3B-2 / 3B-3：受控修复闭环的**判据层**（不碰真实项目源码）

   这里只钉纯逻辑：状态门控、参数形状、预算、恢复点的三种分支、
   哈希复核。真闭环（真跑测试 → 真改文件 → 真重测）由 `tmp/` 下的
   端到端脚本做（需要真子进程，进不了自检）。

   ★ 本组**不写任何项目文件**：恢复点用的是隔离数据根里的临时文件，
     且每个用例自己清理。
   ══════════════════════════════════════════════════════════════ */

const fixArgs = require(join(ROOT, 'electron/core/project-test-fix-args.cjs'))
const loop = require(join(ROOT, 'electron/core/project-test-loop.cjs'))
const restore = require(join(ROOT, 'electron/core/project-test-restore.cjs'))
const rules = require(join(ROOT, 'electron/core/project-test-rules.cjs'))
const fixTool = require(join(ROOT, 'electron/core/tools/apply_test_fix.cjs'))
const restoreTool = require(join(ROOT, 'electron/core/tools/restore_test_fix.cjs'))
const mcpFix = require(join(ROOT, 'electron/core/codex-mcp-fix-tool.cjs'))
const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))

const fs = require('node:fs')
const path = require('node:path')

export async function run() {
  /* ── ① 只有 FAIL 能修（3B-1 的门控继续有效）────────────── */
  group('3B-2 · 只有 FAIL 进修复，其余五态一律拒')
  check('★★★ FAIL 可修', rules.gate('FAIL').fixable === true)
  for (const s of ['PASS', 'TIMEOUT', 'CANCELLED', 'DENIED', 'ERROR']) {
    check(`★★★ ${s} 不可修`, rules.gate(s).fixable === false)
    check(`★ ${s} 有专门说明（不是 FAIL 那套）`, rules.gate(s).note.length > 10 && !/代码缺陷去改断言/.test(rules.gate(s).note) === s !== 'TIMEOUT')
  }
  check('★ 空状态不可修', rules.gate('').fixable === false)

  /* ── ② 起点必须是真实执行记录（不接受自报状态）────────── */
  group('3B-2 · 起点只认已落盘执行记录')
  const needId = fixArgs.pickSnapshot({})
  check('★★★ 既不给 executionId 也不给 testId → 拒', needId.ok === false && needId.code === 'NEED_ID')
  const fake = fixArgs.pickSnapshot({ executionId: 'ptr_definitely_not_there' })
  check('★★★ 伪造 executionId → 拒（B14）', fake.ok === false && fake.code === 'UNKNOWN_EXECUTION')
  const noExec = fixArgs.pickSnapshot({ testId: 'never_ran_test' })
  check('★★ 有 id 但没执行过 → 拒', noExec.ok === false && noExec.code === 'NO_EXECUTION')
  check('★ 拒绝文案点明「只修真实跑过的失败」', /真实跑过/.test(needId.message))

  /* ── ③ 提案形状 ───────────────────────────────────────── */
  group('3B-2 · 提案形状（一次 1 个文件、before≠after）')
  check('★★★ 一次 2 个文件 → 拒', fixArgs.cleanProposals([{ path: 'a' , before: 'x', after: 'y' }, { path: 'b', before: 'x', after: 'y' }]).ok === false)
  check('★★★ before === after → 拒（这不是修改）', fixArgs.cleanProposals([{ path: 'a', before: 'x', after: 'x' }]).ok === false)
  check('★★ 空数组 → 拒', fixArgs.cleanProposals([]).ok === false)
  check('★ 缺 path → 拒', fixArgs.cleanProposals([{ before: 'x', after: 'y' }]).ok === false)
  check('★ 合法提案通过', fixArgs.cleanProposals([{ path: 'a.js', before: 'x', after: 'y' }]).ok === true)
  check('★ 多余字段被丢掉（只留四个）', Object.keys(fixArgs.cleanProposals([{ path: 'a', before: 'x', after: 'y', evil: 1 }]).proposals[0]).sort().join() === 'after,before,note,path')

  /* ── ④ 预算（3B-3）────────────────────────────────────── */
  group('3B-3 · 尝试次数与耗时预算')
  check('★★★ 默认 1 次', loop.DEFAULT_ATTEMPTS === 1)
  check('★★★ 硬上限 3 次', loop.HARD_MAX_ATTEMPTS === 3)
  check('★★ 要 9 次 → 收到 3 次（不猜更大的）', loop.clampAttempts(9) === 3)
  check('★★ 要 0 / 负数 / 非数字 → 落到 1 次', loop.clampAttempts(0) === 1 && loop.clampAttempts(-5) === 1 && loop.clampAttempts('abc') === 1)
  check('★ executionId 形状不合法 → 拒领额度', loop.takeAttempt({ executionId: '../evil' }).ok === false)
  const fresh = loop.takeAttempt({ executionId: 'ptr_selftest_never_used' })
  check('★★ 全新的 executionId → 第 1 次、剩余 0 次（默认 1 次）', fresh.ok === true && fresh.attemptNo === 1 && fresh.remaining === 0)
  const wide = loop.takeAttempt({ executionId: 'ptr_selftest_never_used', maxAttempts: 3 })
  check('★★ 要 3 次 → 剩余 2 次', wide.ok === true && wide.remaining === 2)

  /* ── ⑤ 恢复点：三种分支 ───────────────────────────────── */
  group('3B-3 · 恢复点只回退本轮那一份（三分支）')
  const tmpDir = path.join(require(join(ROOT, 'electron/core/paths.cjs')).DIRS.data, 'selftest-restore')
  const file = path.join(tmpDir, 'sample.txt')
  const ORIGINAL = 'a\nb\n'
  const FIXED = 'a\nB\n'
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(file, ORIGINAL, 'utf8')
    /* root 必填：恢复时要用它把 abs 验回工作区内（见 project-test-restore.cjs 文件头） */
    const captured = restore.capture({ abs: file, rel: 'sample.txt', root: tmpDir, before: ORIGINAL, after: FIXED })
    check('★★ 恢复点记下了前后两个 hash', Boolean(captured.beforeHash) && Boolean(captured.afterHash))
    check('★ 恢复点内容可恢复', captured.restorable === true)
    check('★★ 恢复点记下了写根（恢复侧路径校验的依据）', captured.root === tmpDir)

    /* 分支一：还是修复后那份 → 写回原内容
     * ★ 3C-2：恢复现在还要「写根仍被授权」—— 自检用注入的授权清单（判据仍只有一处） */
    const auth = { items: [{ root: tmpDir, allowWrite: true }], isoDir: tmpDir }
    const saved = restore.savePoint('ptr_selftest_ok', [captured])
    check('★★ 保存成功并带回 pointId', saved.ok === true && Boolean(saved.id))
    fs.writeFileSync(file, FIXED, 'utf8')
    const r1 = restore.restorePoint({ executionId: 'ptr_selftest_ok', ...auth })
    check('★★★ 分支一：文件还是改后那份 → 恢复成功', r1.ok === true && r1.results[0].action === 'restored')
    check('★★★ 分支一：内容真的回到原样', fs.readFileSync(file, 'utf8') === ORIGINAL)

    /* 分支二：已经是原内容 → 什么都不做 */
    const r2 = restore.restorePoint({ executionId: 'ptr_selftest_ok', ...auth })
    check('★★ 分支二：本就已恢复 → 不动它', r2.ok === true && r2.results[0].action === 'already')

    /* 分支三：这之后被别人改过 → 拒绝覆盖 */
    fs.writeFileSync(file, '别人改的\n', 'utf8')
    const r3 = restore.restorePoint({ executionId: 'ptr_selftest_ok', ...auth })
    check('★★★ 分支三：文件被第三方改过 → 拒绝覆盖', r3.ok === false && r3.code === 'PARTIAL_CONFLICT')
    check('★★★ 分支三：绝不抹掉别人的改动', fs.readFileSync(file, 'utf8') === '别人改的\n')
    check('★ 冲突时说清了原因', /拒绝覆盖/.test(r3.results[0].message))

    /* ★★★ 3C-2：写根**不再被授权** → 拒绝恢复（否则「删掉授权条目」形同虚设） */
    fs.writeFileSync(file, FIXED, 'utf8')
    const r4 = restore.restorePoint({ executionId: 'ptr_selftest_ok', items: [], isoDir: tmpDir })
    check('★★★ 授权被撤销后 → 拒绝恢复', r4.ok === false && r4.results[0].action === 'rejected')
    check('★★★ 拒绝时文件没被改回（授权撤销确实生效）', fs.readFileSync(file, 'utf8') === FIXED)
    check('★ 拒绝原因点名「不再被授权」', /不再被授权/.test(r4.results[0].message))
    fs.writeFileSync(file, ORIGINAL, 'utf8')

    /* 不存在的恢复点 */
    check('★★ 没有这个恢复点 → 明确说 NO_POINT', restore.restorePoint({ executionId: 'ptr_nope' }).code === 'NO_POINT')
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }

  /* ── ⑤-b 2026-10-17 可靠性收尾（这一批全是真缺陷的钉子）────── */
  group('3B · 可靠性收尾 · 每次写入独立恢复点')
  check('★★★ 尝试序号拼进 pointId（第 2 次不再覆盖第 1 次）', restore.pointId('ptr_x', 2) === 'ptr_x__a2')
  check('★★ 第 1 次与第 2 次名字不同', restore.pointId('ptr_x', 1) !== restore.pointId('ptr_x', 2))
  check('★ 没有序号 → 退回纯 executionId（兼容老点）', restore.pointId('ptr_x') === 'ptr_x')
  check('★ 非法 executionId → 空串（不拼出危险文件名）', restore.pointId('../evil', 1) === '')

  group('3B · 可靠性收尾 · 恢复点数据保护')
  const restoreSrcText = fs.readFileSync(join(ROOT, 'electron/core/project-test-restore.cjs'), 'utf8')
  check('★★★ 恢复点文件权限 0600（未脱敏源码只给当前用户）', /FILE_MODE = 0o600/.test(restoreSrcText) && /mode: FILE_MODE/.test(restoreSrcText))
  check('★★★ 有过期清理时长（14 天）', /MAX_AGE_MS/.test(restoreSrcText) && /now - x\.at <= MAX_AGE_MS/.test(restoreSrcText))
  check('★★ 单点条目数有上限', restore.MAX_ENTRIES >= 1 && restore.MAX_ENTRIES <= 16)
  check('★★ 恢复点目录在数据根内', restore.dir().includes('project-test-restores'))
  check('★★★ 同名恢复点不覆盖（否则第 2 次把第 1 次的点了）', /已存在 —— 拒绝覆盖/.test(restoreSrcText))

  group('3B · 可靠性收尾 · 恢复侧路径校验（防越界写）')
  const policy = require(join(ROOT, 'electron/core/codex-mcp-policy.cjs'))
  check('★★★ 没有 root 的恢复点 → 拒绝恢复', restore.pathAllowed({ abs: 'E:\\x\\a.txt' }, policy.isInside).ok === false)
  check('★★★ 目标在 root 内 → 放行', restore.pathAllowed({ abs: 'E:\\x\\sub\\a.txt', root: 'E:\\x' }, policy.isInside).ok === true)
  check('★★★ 目标在 root 外 → 拒绝（恢复点文件被改也写不到外面）', restore.pathAllowed({ abs: 'E:\\Windows\\win.ini', root: 'E:\\x' }, policy.isInside).ok === false)

  group('3B · 可靠性收尾 · 预算如实标注（不伪称支持）')
  check('★★ 次数预算有默认值 1', loop.DEFAULT_ATTEMPTS === 1)
  check('★★ 次数硬上限 3', loop.HARD_MAX_ATTEMPTS === 3)
  check('★★ 耗时预算常量存在', loop.DEFAULT_TOTAL_MS > 0)
  const budgetSrc = fs.readFileSync(join(ROOT, 'electron/core/project-test-loop.cjs'), 'utf8')
  check('★★★ 文件头如实写明「模型调用费预算未实现」', /模型调用费预算.*?未实现|未实现.*?模型调用费/.test(budgetSrc))
  check('★★★ 没有导出任何「费用预算」函数（不假装有）', !Object.keys(loop).some((k) => /cost|price|token/i.test(k)))

  group('3B · 可靠性收尾 · 取消/超时/拒绝不写不重测')
  const fixSrc = fs.readFileSync(join(ROOT, 'electron/core/project-test-fix.cjs'), 'utf8')
  check('★★★ 审批后查 cancel（CANCELLED）', /isAborted\(ctx\.signal\)/.test(fixSrc))
  check('★★★ 写入后重测前再查一次 cancel（CANCELLED_AFTER_WRITE）', /CANCELLED_AFTER_WRITE/.test(fixSrc))
  check('★★★ 恢复点保存失败 → 拒绝写源码（RESTORE_FAILED）', /RESTORE_FAILED/.test(fixSrc))
  check('★★★ 检查 savePoint 的返回值（不再丢弃）', /saved\.ok === false/.test(fixSrc))
  check('★★★ 写入后校验磁盘内容（WRITE_INCONSISTENT）', /WRITE_INCONSISTENT/.test(fixSrc))
  check('★★★ 审批后内容被换 → 拒绝写（CONTENT_SWAPPED）', /CONTENT_SWAPPED/.test(fixSrc))
  check('★★★ diff 基线用真实读到的 current（不是模型自报的 before）', /before: current/.test(fixSrc))
  check('★★★ 审批后复核也用 current 比（不再用 prop.before）', /hashOf\(again\) !== hashOf\(current\)/.test(fixSrc))
  check('★★★ 拒绝分支写明「没有修改任何文件」', /用户拒绝或超时 —— 没有修改任何文件/.test(fixSrc))

  group('3B · 可靠性收尾 · 恢复也要审批 + 审计')
  const restoreRunSrc = restoreTool.run.toString()
  check('★★★ restore_test_fix 会弹审批', /confirm/.test(restoreRunSrc))
  check('★★★ 审批不是 true → 不恢复', /approved !== true/.test(restoreRunSrc))
  check('★★★ 恢复写审计', /auditCore\.record/.test(restoreRunSrc))
  check('★★★ 恢复前先算真实 diff 给用户看', /diffFile/.test(restoreRunSrc))
  check('★★★ 拿不到审批通道 → 拒绝恢复', /拿不到审批通道/.test(restoreRunSrc))

  /* ── ⑥ 两个工具都在、且集合语义正确 ───────────────────── */
  group('3B-2/3B-3 · 工具注册与集合语义')
  check('★★★ apply_test_fix 已注册', Boolean(registry.byName('apply_test_fix')))
  check('★★★ restore_test_fix 已注册', Boolean(registry.byName('restore_test_fix')))
  check('★★★ 两个都进 MUTATING_TOOLS（「只分析」那一轮必须拦）', registry.MUTATING_TOOLS.has('apply_test_fix') && registry.MUTATING_TOOLS.has('restore_test_fix'))
  check(
    '★★★ 两个都不在 WRITE_TOOLS：它们自己弹一次带真实 diff 的审批，工具层别再问一遍',
    registry.WRITE_TOOLS.has('apply_test_fix') === false && registry.WRITE_TOOLS.has('restore_test_fix') === false,
  )
  check('★★ 两个都算 FILE_WRITERS（审计要记）', registry.FILE_WRITERS.has('apply_test_fix') && registry.FILE_WRITERS.has('restore_test_fix'))

  /* ── ⑦ 工具参数面：没有可执行入口 ─────────────────────── */
  group('3B-2/3B-3 · 参数面没有 command / shell')
  const applyParams = Object.keys(fixTool.parameters.properties)
  check('★★★ apply_test_fix 没有 command 参数', !applyParams.includes('command'))
  check('★★★ apply_test_fix 没有 cwd 参数', !applyParams.includes('cwd'))
  check('★★ apply_test_fix 有 executionId / testId / proposals / maxAttempts', ['executionId', 'testId', 'proposals', 'maxAttempts'].every((k) => applyParams.includes(k)))
  const restoreParams = Object.keys(restoreTool.parameters.properties)
  check('★★ restore_test_fix 只收 executionId / pointId（没有可执行入口）', restoreParams.length === 2 && restoreParams.includes('executionId') && restoreParams.includes('pointId'))

  /* ── ⑧ MCP 侧：定义与净化 ─────────────────────────────── */
  group('3B-2/3B-3 · Codex MCP 侧')
  check('★★★ MCP 有 harbor_apply_test_fix', Boolean(mcpFix.APPLY_TOOL) && mcpFix.APPLY_TOOL.name === 'harbor_apply_test_fix')
  check('★★★ MCP 有 harbor_restore_test_fix', mcpFix.RESTORE_TOOL.name === 'harbor_restore_test_fix')
  check('★★★ 修复工具如实声明 readOnlyHint:false', mcpFix.APPLY_TOOL.annotations.readOnlyHint === false)
  check('★★ 修复工具声明 destructiveHint:true（会覆盖文件）', mcpFix.APPLY_TOOL.annotations.destructiveHint === true)
  check('★★★ 修复工具没有 command 参数', !Object.keys(mcpFix.APPLY_TOOL.inputSchema.properties).includes('command'))
  const noId = mcpFix.cleanCall('harbor_apply_test_fix', { proposals: [{ path: 'a', before: 'x', after: 'y' }] })
  check('★★★ MCP 不给 id → 拒', noId.ok === false)
  const capped = mcpFix.cleanCall('harbor_apply_test_fix', { executionId: 'ptr_1', proposals: [{ path: 'a', before: 'x', after: 'y' }], maxAttempts: 99 })
  check('★★ MCP 要 99 次 → 收到 3 次', capped.ok === true && capped.args.maxAttempts === 3)
  const twoFiles = mcpFix.cleanCall('harbor_apply_test_fix', { executionId: 'ptr_1', proposals: [{ path: 'a', before: 'x', after: 'y' }, { path: 'b', before: 'x', after: 'y' }] })
  check('★★★ MCP 一次两个文件 → 拒', twoFiles.ok === false)
  const badRestore = mcpFix.cleanCall('harbor_restore_test_fix', { executionId: '../etc' })
  check('★★ MCP 回退的 executionId 形状不对 → 拒', badRestore.ok === false)
}

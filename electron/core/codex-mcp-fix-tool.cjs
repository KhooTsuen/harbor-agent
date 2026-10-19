/**
 * 暴露给 Codex 的 `harbor_apply_test_fix` / `harbor_restore_test_fix` 定义
 * （2026-10-17 · 3B-2 / 3B-3）
 *
 * ── 与只读分析工具的区别（这一条最要紧）────────────────────────
 *
 * `harbor_analyze_test_failure` 是 `readOnlyHint: true`；这两个是
 * **会写项目源码**的，所以 annotations 如实写 `readOnlyHint: false` /
 * `destructiveHint: true` —— codex 侧据此知道自己在请求写操作。
 *
 * ⚠️ annotations **不是安全控制**：真正的边界仍然是 Harbor 侧的
 * 写根校验 + 逐次审批 + 哈希复核 + 审计。
 *
 * ── 参数面刻意窄 ──────────────────────────────────────────────
 *
 * 没有 command、没有 cwd、没有"跑别的测试"的入口：
 *   · `executionId` / `testId` —— 指一次**真实执行过**的失败
 *   · `proposals` —— 具体改法（一次 1 个文件）
 *   · `maxAttempts` —— 1（默认）~3
 *
 * ⚠️ 不 require electron。
 */

/** proposals 的形状（两个工具共用一份定义，别抄两遍） */
const PROPOSALS = {
  type: 'array',
  description: '具体改法（一次只能 1 项；before 必须真的来自读到的源码）',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目根下的相对路径（不接受绝对路径）' },
      before: { type: 'string', description: '修改前的完整文件内容（必须与磁盘一致）' },
      after: { type: 'string', description: '修改后的完整文件内容' },
      note: { type: 'string', description: '这处修改为什么这么改' },
    },
    required: ['path', 'before', 'after'],
    additionalProperties: false,
  },
}

const APPLY_TOOL = {
  name: 'harbor_apply_test_fix',
  description:
    '按失败分析结果**真的修改**项目源码（实验性 · 逐次需用户审批），然后只重跑受影响的那一条测试。' +
    '起点必须是**已经真实执行过**的 FAIL 结果（给 executionId 或 testId），不能自己声明状态。' +
    '一次最多改 1 个文件；写入前会复核文件哈希，文件被别人改过就拒绝覆盖。' +
    '改前会建文件级恢复点，可用 harbor_restore_test_fix 精确回退。' +
    '默认只允许 1 次尝试（最多 3 次）—— 用完即停，不会自己循环。',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      executionId: { type: 'string', description: '要修的那次执行 id' },
      testId: { type: 'string', description: '不给 executionId 时，修这个条目最近一次的失败' },
      proposals: PROPOSALS,
      maxAttempts: { type: 'integer', description: '这条失败允许的总尝试次数（默认 1，上限 3）' },
    },
    required: ['proposals'],
    additionalProperties: false,
  },
}

const RESTORE_TOOL = {
  name: 'harbor_restore_test_fix',
  description:
    '把某一次修复（harbor_apply_test_fix）改过的文件**精确退回修复前的内容**（逐次需用户审批）。' +
    '只回退那一次改过的文件；如果文件在这之后又被改动过，会**拒绝覆盖**并如实报告。' +
    '不删除任何文件，不动目录。不给 pointId 时退的是那次失败**最新一次**写入。',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      executionId: { type: 'string', description: '那次修复用的执行记录 id' },
      pointId: { type: 'string', description: '可选：精确指定恢复点（harbor_apply_test_fix 返回里的 pointId）' },
    },
    required: ['executionId'],
    additionalProperties: false,
  },
}

/** executionId / testId：都只收安全形状的短字符串 */
function cleanId(v, max = 80) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (!s || s.length > max) return ''
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : ''
}

/** 收 proposals：形状不对就整条丢掉（不猜） */
function cleanProposals(input) {
  if (!Array.isArray(input)) return { ok: false, message: 'proposals 必须是数组' }
  if (input.length === 0) return { ok: false, message: 'proposals 是空的 —— 没有具体改法就别调这个工具' }
  if (input.length > 1) return { ok: false, message: '一次最多改 1 个文件' }
  const out = []
  for (const one of input) {
    if (!one || typeof one !== 'object') return { ok: false, message: 'proposals 里每一项都必须是对象' }
    const p = {
      path: typeof one.path === 'string' ? one.path.trim() : '',
      before: typeof one.before === 'string' ? one.before : '',
      after: typeof one.after === 'string' ? one.after : '',
      note: typeof one.note === 'string' ? one.note.slice(0, 300) : '',
    }
    if (!p.path) return { ok: false, message: 'proposal.path 必填' }
    if (p.before === p.after) return { ok: false, message: 'before 与 after 相同 —— 这不是修改' }
    out.push(p)
  }
  return { ok: true, proposals: out }
}

/**
 * 参数净化。
 * @param {string} name @param {object} raw
 */
function cleanCall(name, raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (name === 'harbor_restore_test_fix') {
    const id = cleanId(a.executionId)
    if (!id) return { ok: false, message: 'executionId 必填（那次修复用的执行记录 id）' }
    const pointId = cleanId(a.pointId, 120)
    return { ok: true, args: pointId ? { executionId: id, pointId } : { executionId: id } }
  }
  const executionId = cleanId(a.executionId)
  const testId = cleanId(a.testId, 40)
  if (!executionId && !testId) {
    return { ok: false, message: 'executionId 或 testId 至少要给一个（不能自己声明一次没跑过的失败）' }
  }
  const props = cleanProposals(a.proposals)
  if (props.ok === false) return props
  const out = { proposals: props.proposals }
  if (executionId) out.executionId = executionId
  if (testId) out.testId = testId
  const n = Number(a.maxAttempts)
  if (Number.isFinite(n) && n >= 1) out.maxAttempts = Math.min(3, Math.round(n))
  return { ok: true, args: out }
}

module.exports = { APPLY_TOOL, RESTORE_TOOL, TOOLS: [APPLY_TOOL, RESTORE_TOOL], cleanCall, cleanProposals, cleanId }

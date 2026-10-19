/**
 * 暴露给 Codex 的 **MCP 工具定义**（2026-10-17 · 生产版）
 *
 * ★ 这一层只做两件事：**schema** 与 **参数净化**，一个字节的执行都没有 ——
 * 真正干活的是主进程侧的 `tools.execute`（`codex-mcp-bridge.cjs`）。
 * ★ 形状层（字段 / 类型 / 长度 / 枚举）在这里；**语义**判据（路径越界、命令白名单）
 * 在 `codex-mcp-policy.cjs`。两层都不可省。
 * ★ `annotations.readOnlyHint` 是**诚实的描述**，不是安全控制。
 * ⚠️ 不 require electron。
 */

const policy = require('./codex-mcp-policy.cjs')
const test = require('./codex-mcp-test.cjs')
const imageTool = require('./codex-mcp-image-tool.cjs')

/** 工具名 → 定义 */
const TOOLS = [
  {
    name: 'harbor_read_file',
    description:
      '读取 Harbor **隔离工作区**内的一个文本文件（只读）。只接受工作区内的相对路径；' +
      '绝对路径、含 `..` 的穿越、以及真实路径落到工作区外的符号链接一律被拒绝。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径（如 `sub/a.md`；不接受绝对路径）' },
        offset: { type: 'integer', description: '从第几行开始（1 开始），默认 1' },
        limit: { type: 'integer', description: '最多读多少行，默认 400' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  ...imageTool.TOOLS,
  {
    name: 'harbor_env_diag',
    description:
      '执行**预定义的只读环境诊断**（不接受任意 shell 命令）。可诊断项由 Harbor 固定：' +
      `\`${policy.DIAG_IDS.join('` / `')}\`。不传 checks 就全做一遍。`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: { type: 'string', enum: [...policy.DIAG_IDS] },
          description: '要做的诊断项 id；留空 = 全部',
        },
      },
      additionalProperties: false,
    },
  },
  {
    /*
     * ★ 唯一的**写**能力（默认关到"没配写根就用不了"）。annotations 如实：
     * readOnlyHint:false / destructiveHint:true。⚠️ 它不是安全控制 —— 真正的边界是
     * Harbor 的写根校验 + 逐次审批 + 审计。
     */
    name: 'harbor_write_file',
    description:
      '写入/覆盖 Harbor **隔离测试工作区**内的一个文本文件（实验性 · 逐次需用户审批）。' +
      '只接受工作区内的相对路径；绝对路径、含 `..` 的穿越、符号链接与目录联接一律被拒绝。' +
      '执行前 Harbor 会弹审批卡，用户拒绝或超时则不写入。',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '工作区内的相对路径，例如 `probe.txt`（不接受绝对路径）',
        },
        content: { type: 'string', description: '要写入的完整文本（会覆盖原内容）' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    /*
     * ★ **局部编辑**（第五阶段 · 默认关）：只改一段，不整文件覆盖。
     * 必须带 expectHash（并发冲突检测）—— 版本对不上就拒，绝不把旧内容贴到新文件上。
     * 唯一匹配（0 次 / 多次都拒）由 Harbor 侧的 codex-mcp-edit-rules.cjs 判。
     */
    name: 'harbor_edit_file',
    description:
      '把 Harbor **隔离测试工作区**内某个文件里的一小段文本替换掉（实验性 · 逐次需用户审批）。' +
      '必须先用 harbor_read_file 读到「文件版本」，作为 expectHash 一起传；' +
      'oldText 必须在文件里**恰好出现一次**，且文件版本未变，否则一律拒绝（不会猜位置）。' +
      '比整文件覆盖更安全：只动这一段，其余内容一个字节都不改。',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径（不接受绝对路径）' },
        oldText: { type: 'string', description: '要被替换的原文（必须**恰好出现一次**，逐字匹配，含缩进）' },
        newText: { type: 'string', description: '替换成什么（留空 = 删掉这段）' },
        expectHash: {
          type: 'string',
          description: '文件的期望版本 —— 用 harbor_read_file 返回里的「文件版本」值（并发冲突检测）',
        },
      },
      required: ['path', 'oldText', 'newText', 'expectHash'],
      additionalProperties: false,
    },
  },
  {
    /*
     * ★ 受限**测试执行**（第四阶段 · 默认关）：跑**预先允许的固定命令**，外部只能给 id。
     * 它不改文件但**会执行代码** —— 所以默认关、且必须落在隔离工作区内。
     */
    name: 'harbor_run_test',
    description:
      '在 Harbor **隔离测试工作区**内执行**预先允许的测试**并返回真实输出（不接受自定义命令）。' +
      `可选项固定：\`${test.TEST_IDS.join('` / `')}\`（不传 = unit）。` +
      '命令与工作目录都由 Harbor 固定；失败会**如实返回**（不会包装成成功）。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: [...test.TEST_IDS],
          description: '要跑的测试项 id；留空 = unit',
        },
      },
      additionalProperties: false,
    },
  },
  {
    /* ★ **项目自定义测试**（默认关）：跑**用户亲笔配置**的命令，外部只能给 id。
       cwd = 用户配的那个项目根（主进程校验边界）。与 harbor_run_test 的区别：
       那个跑 Harbor 常量命令，这个跑用户自己的项目测试。 */
    name: 'harbor_run_project_test',
    description:
      '在**用户指定项目的根目录**里执行用户**预先配置好**的一条测试命令（不接受自定义命令）。' +
      '只能给 `id`（用户在 设置 → 项目测试 里配置的条目）。' +
      '结果如实区分 PASS / FAIL / TIMEOUT / CANCELLED / DENIED / ERROR，退出码非 0 一律算失败。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要跑的那一条的 id（见设置 → 项目测试）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    /*
     * ★ **测试失败分析**（3B-1 · 纯只读）：只能给 executionId / testId，
     * 状态从执行记录里读 —— 调用方声明不了一个「未经证实的 FAIL」。
     * 定义与净化住在 `codex-mcp-analyze-tool.cjs`（这个文件贴 300 行红线）。
     */
    ...require('./codex-mcp-analyze-tool.cjs').TOOL,
  },
  /* ★ 受控修复 / 精确回退（3B-2 / 3B-3）：会写项目源码 —— 逐次审批 + 哈希复核 + 恢复点 */
  ...require('./codex-mcp-fix-tool.cjs').TOOLS,
]

/** 认识的工具名 */
const TOOL_NAMES = TOOLS.map((t) => t.name)

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 净化 `harbor_read_file` 的参数。
 * @param {object} args
 * @returns {{ ok: boolean, args?: object, message?: string }}
 */
function cleanReadFile(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const path = a.path
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, message: 'path 必填，且必须是非空字符串' }
  }
  if (path.length > imageTool.MAX_PATH_LEN) return { ok: false, message: `path 过长（上限 ${imageTool.MAX_PATH_LEN} 字符）` }
  const out = { path: path.trim() }
  if (a.offset !== undefined) {
    if (!isNum(Number(a.offset))) return { ok: false, message: 'offset 必须是数字' }
    out.offset = Math.trunc(Number(a.offset))
  }
  if (a.limit !== undefined) {
    if (!isNum(Number(a.limit))) return { ok: false, message: 'limit 必须是数字' }
    out.limit = Math.trunc(Number(a.limit))
  }
  return { ok: true, args: out }
}

/**
 * 净化 `harbor_env_diag` 的参数（复用宿主侧那份**唯一清单**做枚举校验）。
 * @param {object} args
 * @returns {{ ok: boolean, args?: object, message?: string }}
 */
function cleanEnvDiag(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const picked = policy.pickChecks(a.checks)
  if (picked.ok === false) return { ok: false, message: picked.message }
  return { ok: true, args: { checks: picked.checks } }
}

/**
 * 净化 `harbor_write_file` 的参数（形状层面；语义层面在宿主 policy 里）。
 * @param {object} args
 * @returns {{ ok: boolean, args?: object, message?: string }}
 */
function cleanWriteFile(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const path = a.path
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, message: 'path 必填，且必须是非空字符串' }
  }
  if (path.length > imageTool.MAX_PATH_LEN) return { ok: false, message: `path 过长（上限 ${imageTool.MAX_PATH_LEN} 字符）` }
  if (typeof a.content !== 'string') return { ok: false, message: 'content 必填，且必须是字符串' }
  if (a.content.length > policy.MAX_WRITE_CHARS) {
    return { ok: false, message: `content 过大（上限 ${policy.MAX_WRITE_CHARS} 字符）` }
  }
  return { ok: true, args: { path: path.trim(), content: a.content } }
}

/**
 * 净化 `harbor_edit_file` 的参数（形状层面；语义层面在 codex-mcp-edit-rules.cjs）。
 * @param {object} args
 * @returns {{ ok: boolean, args?: object, message?: string }}
 */
function cleanEditFile(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const path = a.path
  if (typeof path !== 'string' || !path.trim()) return { ok: false, message: 'path 必填，且必须是非空字符串' }
  if (path.length > imageTool.MAX_PATH_LEN) return { ok: false, message: `path 过长（上限 ${imageTool.MAX_PATH_LEN} 字符）` }
  if (typeof a.oldText !== 'string' || !a.oldText) return { ok: false, message: 'oldText 必填，且必须是非空字符串' }
  if (typeof a.newText !== 'string') return { ok: false, message: 'newText 必填，且必须是字符串（删除就传空串）' }
  if (a.oldText.length + a.newText.length > policy.MAX_WRITE_CHARS) {
    return { ok: false, message: `oldText + newText 过大（上限 ${policy.MAX_WRITE_CHARS} 字符）` }
  }
  if (typeof a.expectHash !== 'string' || !a.expectHash.trim()) {
    return { ok: false, message: 'expectHash 必填（用 harbor_read_file 返回的「文件版本」值）' }
  }
  return {
    ok: true,
    args: { path: path.trim(), oldText: a.oldText, newText: a.newText, expectHash: a.expectHash.trim() },
  }
}

/** 净化 `harbor_run_test` 的参数：**只认白名单里的 id**（命令由宿主常量拼）。 */
function cleanRunTest(args) {
  const picked = test.pickTest(args)
  if (picked.ok === false) return { ok: false, message: picked.message }
  return { ok: true, args: { name: picked.name } }
}

/** 净化 `harbor_run_project_test` 的参数：**只认 id**（命令来自用户配置，给不出命令）。 */
function cleanProjectTest(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const id = typeof a.id === 'string' ? a.id.trim() : ''
  if (!id) return { ok: false, message: 'id 必填（要跑哪一条项目测试；见设置 → 项目测试）' }
  if (id.length > 40) return { ok: false, message: 'id 过长（上限 40 字符）' }
  /* 只回 id —— 就算外部多塞 command/root 也一律丢掉（命令只能来自用户配置） */
  return { ok: true, args: { id } }
}

/** 净化 `harbor_analyze_test_failure` 的参数（判据在 3B-1 那个文件里，这里只转发） */
const cleanAnalyze = (args) => require('./codex-mcp-analyze-tool.cjs').clean(args)

/** 净化 `harbor_apply_test_fix` / `harbor_restore_test_fix` 的参数（判据在 3B-2/3-3 那个文件里） */
const cleanFix = (name, args) => require('./codex-mcp-fix-tool.cjs').cleanCall(name, args)

/**
 * 工具名 + 原始参数 → 干净参数（或明确拒绝）。
 * @param {string} name @param {object} rawArgs
 * @returns {{ ok: boolean, args?: object, message?: string }}
 */
function cleanCall(name, rawArgs) {
  if (!TOOL_NAMES.includes(name)) {
    return { ok: false, message: `没有名为 ${String(name)} 的工具（只有：${TOOL_NAMES.join(' / ')}）` }
  }
  if (name === 'harbor_read_file') return cleanReadFile(rawArgs)
  if (name === 'harbor_read_image') return imageTool.cleanReadImage(rawArgs)
  if (name === 'harbor_write_file') return cleanWriteFile(rawArgs)
  if (name === 'harbor_edit_file') return cleanEditFile(rawArgs)
  if (name === 'harbor_run_test') return cleanRunTest(rawArgs)
  if (name === 'harbor_run_project_test') return cleanProjectTest(rawArgs)
  if (name === 'harbor_analyze_test_failure') return cleanAnalyze(rawArgs)
  if (name === 'harbor_apply_test_fix' || name === 'harbor_restore_test_fix') return cleanFix(name, rawArgs)
  return cleanEnvDiag(rawArgs)
}

module.exports = {
  TOOLS,
  TOOL_NAMES,
  cleanCall,
  cleanAnalyze,
  MAX_PATH_LEN: imageTool.MAX_PATH_LEN,
  cleanWriteFile,
  cleanEditFile,
  cleanRunTest,
  cleanProjectTest,
}

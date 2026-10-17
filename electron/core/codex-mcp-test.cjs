/**
 * `harbor_run_test` 的**执行段**（2026-10-17 第四阶段 · 受限测试执行）
 *
 * ── 它证明什么 ────────────────────────────────────────────────
 *
 * 「Codex 改完代码，能**经 Harbor** 跑一次测试、拿到真实结果」—— 让「读码 → 改 →
 * 审批 → 测试 → 汇报」这条闭环能在**不开放任意 shell** 的前提下走通。
 *
 * ── ★ 五道不变量（用户第 4 条：只能跑预先允许的测试，固定 cwd / 命令 / 参数）──
 *
 *   ① **命令是常量**：外部只能给 **id**（`unit`），给不出命令 —— 命令行由这里的
 *      常量表拼，与 `policy.diagCommands` 同一范式（少一处能漂的判据）。
 *   ② **参数固定**：不接受任何路径 / 参数 / 环境变量。想加测试就在**代码里**加一项。
 *   ③ **工作目录固定**：= 受信任的隔离测试工作区（`testRoot`），且必须过
 *      `policy.resolveWriteRoot` 的 realpath 校验（**必须落在隔离数据根内**）。
 *   ④ **默认关闭**：`testEnabled` 不为 true → `TEST_DISABLED`（跟写能力同一个前提：
 *      都得先有一个隔离项目工作区）。
 *   ⑤ **如实返回**：走 `toolsIndex.execute('run_shell', …)` —— 权限档、风险分级、
 *      路径授权、**审计落盘**全在里面。失败时 `toolOk=false`（见 bridge 文件头 ③），
 *      绝不把「测试失败」包装成成功（用户第 6 条）。
 *
 * ⚠️ 不 require electron。
 */

/** 允许跑的测试项 id —— **唯一清单**（MCP 侧与宿主侧共用这一份） */
const TEST_IDS = ['unit']

/** 每项的人话标签（给结果正文用） */
const TEST_LABELS = { unit: '单元测试（node --test）' }

/**
 * 测试项 → **固定命令**（**不接受任何外部输入**）。
 * @returns {Record<string,string>}
 */
function testCommands() {
  return {
    /*
     * Node 内置 test runner，**不带路径参数** —— 它会在 cwd 里自动发现
     * `*.test.js` 一类文件。
     * ⚠️ 不要写成 `node --test test/`：Node 24 会把它当**模块路径**去 require，
     *    报 `Cannot find module ...\test`（2026-10-17 实测），而不是扫目录。
     */
    unit: 'node --test',
  }
}

/**
 * 从 `run_shell` 的输出里读退出码。
 *
 * ── 为什么必须有它（用户第 6 条：测试失败不得包装成成功）────────
 *
 * Harbor 的 `run_shell` **只要进程起来了就算工具成功**：输出末尾附一行
 * `[退出码 N]`，但**不以「错误：」开头**。所以 `policy.isToolFailure` 判不出
 * 「测试跑了、断言挂了」这种失败 —— 2026-10-17 实测：`node --test` 退出码 1，
 * 上层却拿到 `toolOk=true`（等于向 Codex 报成功）。
 *
 * 所以这里补一条**只属于测试**的判据：退出码非 0 = 测试失败。
 *
 * @param {string} text `run_shell` 的返回原文
 * @returns {number|null} 读不到（命令根本没跑起来）→ null
 */
function parseExitCode(text) {
  const m = /\[退出码 (\d+)\]/.exec(String(text ?? ''))
  return m ? Number(m[1]) : null
}

/**
 * 净化外部给的目标：只认 `name`，且必须在白名单内。**只返回 id，不接受命令**。
 *
 * @param {unknown} args
 * @returns {{ ok: true, name: string } | { ok: false, message: string }}
 */
function pickTest(args) {
  /** @type {Record<string, unknown>} */
  const a = args && typeof args === 'object' && !Array.isArray(args) ? /** @type {Record<string, unknown>} */ (args) : {}
  const name = String(a.name ?? '').trim() || 'unit'
  if (!TEST_IDS.includes(name)) {
    return { ok: false, message: `不认识的测试项：${JSON.stringify(name)}（只允许：${TEST_IDS.join(' / ')}）` }
  }
  return { ok: true, name }
}

/**
 * 跑一次受限测试。
 *
 * @param {{ toolsIndex: object, testEnabled: boolean, testRoot: string, isoDir: string,
 *           args: object, ctx: object, startedAt: number, toolReply: Function }} input
 * @returns {Promise<{ ok: true, payload: object } | { ok: false, error: { code: string, message: string } }>}
 */
async function runTestTool(input) {
  const { toolsIndex, testEnabled, testRoot, isoDir, args, ctx, startedAt, toolReply } = input
  const policy = require('./codex-mcp-policy.cjs')

  if (!testEnabled) {
    return { ok: false, error: { code: 'TEST_DISABLED', message: '测试执行未启用（没有配置隔离测试工作区）' } }
  }
  /* ★ 工作目录必须是**隔离数据根之内**的真实目录 —— 与写根同一道判据（唯一一处） */
  const root = policy.resolveWriteRoot(testRoot, isoDir)
  if (root.ok === false) return { ok: false, error: { code: root.code, message: root.message } }

  const picked = pickTest(args)
  if (picked.ok === false) return { ok: false, error: { code: 'BAD_INPUT', message: picked.message } }

  const command = testCommands()[picked.name]
  /* cwd = 隔离工作区（不接受外部指定）；命令 = 常量；没有任何外部参数进来 */
  const out = await toolsIndex.execute('run_shell', { command, cwd: root.abs }, ctx)
  /*
   * ★ 失败判据**两条都要**（用户第 6 条）：
   *   ① 工具层失败（命令压根没跑起来）→ isToolFailure
   *   ② **测试跑了但断言挂了** → 退出码非 0（run_shell 不会把它当错误，见 parseExitCode）
   */
  const exitCode = parseExitCode(out)
  const failed = policy.isToolFailure(out) || exitCode === null || exitCode !== 0
  /*
   * ★ `toolOk` **必须由这里给**，不能交给 bridge 那个按「错误：」前缀判的 toolReply：
   *   「测试跑了但断言挂了」不是「工具失败」，前缀判据认不出来（会变成 toolOk=true，
   *   等于向 Codex 报成功 —— 正是用户第 6 条禁止的）。
   */
  return {
    ok: true,
    payload: {
      text: failed ? `测试失败（退出码 ${exitCode ?? '未知'}）：\n${String(out)}` : String(out),
      toolOk: !failed,
      meta: { harborTool: 'run_shell', test: picked.name, command, cwd: root.abs, exitCode, failed, ms: Date.now() - startedAt },
    },
  }
}

module.exports = { TEST_IDS, TEST_LABELS, testCommands, parseExitCode, pickTest, runTestTool }

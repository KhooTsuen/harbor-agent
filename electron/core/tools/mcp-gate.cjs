/**
 * MCP 工具的运行时闸门
 *
 * 为什么需要这个文件（2026-11-04，C-2）：
 *
 *   MCP 分支在 `tools/index.cjs` 里**最早**就被判断（函数开头就 `return`），
 *   而「本轮用户约束」那三道闸（`allowTools` / `allowWrite` / `allowNetwork`）
 *   在它**后面**几十行。于是 MCP 调用一条都没经过那三道闸 —— 不是文案问题，
 *   是「被明令禁止的操作**真的执行了**」。动态探针实测：三种约束下
 *   `mcp.callTool()` 的实际调用次数都是 1（应该都是 0）。
 *
 *   还有一个 fail-open：`permission === 'ask'` 而 `ctx.confirm` 不存在时，
 *   旧代码 `typeof ctx.confirm === 'function'` 不成立就**直接往下执行** ——
 *   没有确认通道 = 静默放行。现在按拒绝处理（与 `risk-gate.cjs` 同口径）。
 *
 * ★ 为什么单独一个文件，而不是写在 `index.cjs` 里：
 *   `index.cjs` 顶在 300 行红线上（靠删注释维持），往里加十几行必然破线
 *   （AGENT.md 硬约束 2）。这是**行数约束的硬需求**，不是为抽象而抽象。
 *   顺带解决第二个问题：内置工具和 MCP 工具原来各有一套判据顺序，分叉正是这次的病因。
 *
 * ★ MCP 工具的能力（会不会写盘、会不会联网）**目前无法信得过地分类** ——
 *   第三方进程自己声明的 `readOnlyHint` 不可信，本轮不实施分级。所以
 *   `allowWrite:false` / `allowNetwork:false` 时一律按「会写 + 会联网」处理
 *   （fail-closed）。这条判据**只写在这里**，别在调用方再抄一份（硬约束 9）。
 *
 * ★ 判据顺序与内置工具那一节（`index.cjs` 的 allowTools → allowWrite →
 *   allowNetwork → readonly）**保持一致**。老 MCP 分支只有 readonly 一条，
 *   所以它的位置与文案都没变；新增的三条只会在它**之前**没命中时才轮到。
 *
 * ★ 边界：这道闸只管「Harbor 要不要**发起**这次 MCP 调用」。已经起来的 MCP
 *   服务器进程自己的文件系统 / 网络权限不在这里，也没有进程沙箱 —— 别把这条
 *   说成「已经隔离了外部进程」。
 */

const approvals = require('./approval.cjs')

/**
 * MCP 工具能力未知时的统一说明。**只在这里写一次**，三条拒绝文案共用。
 */
const UNKNOWN_CAPABILITY = '（MCP 工具的能力无法预先确认，按「可能写入 / 可能联网」处理）'

/**
 * 拒绝文案。
 *
 * 前三条与内置工具那边**同句式**（`index.cjs` 的 allowTools / allowWrite /
 * `allowNetwork`），后面缀一句 MCP 特有的解释 —— 模型得知道为什么「别的工具
 * 能跑、这个不行」，否则它只会换个写法重试。`readonly` 那条**逐字沿用**旧 MCP
 * 分支的原话（审计里那个 `只读模式下拒绝 MCP 工具` 也一样）。
 *
 * @type {{ toolsOff: (name: string) => string, writeOff: (name: string) => string,
 *          networkOff: (name: string) => string, readonly: () => string,
 *          noConfirm: () => string, denied: (name: string) => string }}
 */
const TEXTS = {
  toolsOff: (name) => `错误：本次对话已关闭工具调用，${name} 被拒绝。`,
  writeOff: (name) =>
    `错误：本轮对话的运行时约束是「只分析，不修改」，${name} 被拒绝。\n${UNKNOWN_CAPABILITY}`,
  networkOff: (name) => `错误：本轮对话禁止联网，${name} 被运行时拒绝。\n${UNKNOWN_CAPABILITY}`,
  readonly: () => '错误：当前是「只读」权限，MCP 工具（外部进程）被拒绝。需要在设置里放宽权限。',
  noConfirm: () =>
    '错误：MCP 工具（外部进程，行为不受本应用控制）需要用户确认，但当前没有可确认的界面，按拒绝处理。',
  denied: (name) => `用户拒绝了这个操作：${name}`,
}

/**
 * 审计里记的原因。都是「拒绝」，`ok:false` 由调用方（这里）统一写死 ——
 * 绝不允许出现「拒了却记成成功」的记录（真实工具没执行 = 不是成功）。
 */
const REASONS = {
  toolsOff: '本次对话关闭工具（MCP）',
  writeOff: '本轮约束禁止写入（MCP）',
  networkOff: '本轮约束禁止联网（MCP）',
  /* 逐字沿用旧 MCP 分支的原话，历史审计可以继续用同一个字符串查 */
  readonly: '只读模式下拒绝 MCP 工具',
  noConfirm: '没有可用的确认界面，按拒绝处理（MCP）',
  denied: '用户拒绝',
}

/**
 * 过一遍 MCP 调用前的所有硬约束。
 *
 * @param {{ name: string, args: Record<string, unknown>|undefined, ctx: object,
 *           startedAt: number, audit: (entry: object) => void }} input
 *   `audit` 由 `index.cjs` 传进来（就是 `auditCall`）—— 本文件不直接 require 审计，
 *   免得和调用方各记一条（拒绝只能记一次）。
 * @returns {Promise<{ blocked?: string, approval?: boolean|null }>}
 *   `blocked` 非空 = **不要执行**，把这句话还给模型；
 *   `approval` = 放行时这次调用的批准状态（`null` = 没问过，`true` = 用户批了）
 *   ★ 两个字段都是**可选**：写成 `{blocked} | {approval}` 那种联合类型，
 *     checkJs 会让调用方两边字段都访问不了（内核类型棘轮会红）。
 */
async function check({ name, args, ctx = {}, startedAt, audit }) {
  /** 拒绝 = 审计一笔（ok:false）+ 把话还给模型。两件事在这里绑死，不许只做一半 */
  const deny = (reason, text, extra = {}) => {
    audit({ tool: name, args, startedAt, ok: false, error: reason, ...extra })
    return { blocked: text }
  }

  /* ① 本轮工具整体关闭 —— 比只读档更根本，先判 */
  if (ctx.allowTools === false) {
    return deny(REASONS.toolsOff, TEXTS.toolsOff(name))
  }

  /* ② 「只分析，不修改」：MCP 的能力未知 → 按会写盘处理 */
  if (ctx.allowWrite === false) {
    return deny(REASONS.writeOff, TEXTS.writeOff(name))
  }

  /* ③ 「不联网」：同上，按会联网处理 */
  if (ctx.allowNetwork === false) {
    return deny(REASONS.networkOff, TEXTS.networkOff(name))
  }

  /* ④ 只读档：老 MCP 分支唯一的一条判据，位置与文案都保持不变 */
  if (ctx.permission === 'readonly') {
    return deny(REASONS.readonly, TEXTS.readonly())
  }

  /* ⑤ 完全访问档 = 不问（用户在设置里选的，界面上写着「不给任何确认」） */
  if (ctx.permission === 'full') return { approval: null }

  /*
   * ⑥ 其余档位（`ask`，以及缺省 —— 缺省在老代码里也是「要问」）一律先问人。
   *    ★ 没有确认通道 = 拒绝（fail-closed）：旧代码是**直接放行**，
   *      那等于「弹不出窗」就变成了「不用批准」。
   */
  if (typeof ctx.confirm !== 'function') {
    return deny(REASONS.noConfirm, TEXTS.noConfirm())
  }

  const approval = await approvals.ask(ctx, {
    kind: 'mcp',
    name,
    args,
    summary: `调用 MCP 工具 ${name}（外部进程，行为不受本应用控制）`,
  })
  /* 严格 `!== true`：`approvals.ask` 可能回 `{ ok: false }` 这类假值，
     老代码在这里踩过 —— 本意拒绝却被当成同意、还写进了磁盘 */
  if (approval !== true) {
    return deny(REASONS.denied, TEXTS.denied(name), { approval: false })
  }
  return { approval: true }
}

module.exports = { check, TEXTS, REASONS, UNKNOWN_CAPABILITY }

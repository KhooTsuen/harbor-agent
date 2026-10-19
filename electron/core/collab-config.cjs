/**
 * **双模型协作的配置与角色表**（2026-10-17）
 *
 * ── 缺省态度：关 ─────────────────────────────────────────────
 *
 * `enabled` 只认严格 `true`。装了 Harbor 不会因为升级就变成"两个模型一起干活"——
 * 那是用户主动开的功能（用户第 1 条：默认仍是单模型模式）。
 *
 * ── ★ 角色可参数化，能力看 kind ───────────────────────────────
 *
 *   A = 指导模型：检查 / 规划 / 分派 / 验收
 *   B = 工作模型：执行 / 修改 / 测试 / 汇报
 *
 * 每个角色声明「能胜任它的后端 kind 集合」；能不能真的用，由执行路径决定：
 *
 *   · `codex-cli` 做 A：只读沙箱读项目 + 输出结构化计划（`collab-codex.cjs`）
 *   · `openai` 做 A：走 loop 只读读项目 + 输出计划（`collab-planner.cjs`）
 *   · `openai` 做 B：走 loop.run + 工具链（四道闸全在）
 *   · `codex-cli` 做 B：走 MCP 桥调 Harbor 工具（`codex-mcp-bridge.cjs`）
 *
 * ★ 后端种类 `kind` 与「模型能力」是两件事（见 models.ts）。这里只按 kind 声明
 *   「哪条执行路径存在」，能不能跑由 runCollaboration 运行时判。
 *
 * ⚠️ 不 require electron。
 */

/**
 * 角色表（唯一真相源：编排层、界面、审计都读这一份）。
 * `kinds` = 能胜任这个角色的后端 kind 集合（能力声明，非探测）。
 */
const ROLES = {
  /** A 方：检查 / 规划 / 分派 / 验收 */
  planner: {
    id: 'planner',
    label: '指导模型',
    duty: '检查项目 · 规划任务 · 分派 · 验收结果',
    kinds: ['codex-cli', 'openai'],
  },
  /** B 方：执行 / 修改 / 测试 / 汇报 */
  executor: {
    id: 'executor',
    label: '工作模型',
    duty: '执行 · 修改 · 测试 · 汇报（读文件 / 改代码 / 跑测试）',
    kinds: ['openai', 'codex-cli'],
  },
}

/** 双模型默认关闭；用户在聊天框主动选择后才开启。 */
const COLLAB_DEFAULTS = {
  enabled: false,
}

/** 允许的键（多一个都会被丢掉） */
const COLLAB_KEYS = Object.keys(COLLAB_DEFAULTS)

/**
 * 归一化（脏数据一律落回全关 —— 宁可不开，不可"看起来开了其实没开"）。
 * @param {unknown} raw
 * @returns {{ enabled: boolean }}
 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {}
  return { enabled: src.enabled === true }
}

/** 当前是否开启（读不到配置时使用默认值）。 */
function enabled() {
  try {
    const cfg = require('./config.cjs').get()
    const raw = cfg && typeof cfg === 'object' ? /** @type {any} */ (cfg).collab : null
    return normalize(raw).enabled === true
  } catch {
    return COLLAB_DEFAULTS.enabled
  }
}

/**
 * 一个后端 kind 能否胜任某个角色（能力声明的唯一判据）。
 * @param {string} role 'planner' | 'executor'
 * @param {string} kind 'codex-cli' | 'openai' | ...
 * @returns {boolean}
 */
function canRole(role, kind) {
  const r = ROLES[role]
  if (!r) return false
  return Array.isArray(r.kinds) && r.kinds.includes(kind)
}

module.exports = { ROLES, COLLAB_DEFAULTS, COLLAB_KEYS, normalize, enabled, canRole }

/**
 * 规模闸门（A2 的闸门层）—— 拦下来、要授权、留痕。
 *
 * 识别在 `core/scale.cjs`（纯函数，喂一次调用判规模）；这里只负责**行为**：
 * 什么时候拦、谁批过了、写什么账。形状照 `risk.cjs` ↔ `tools/risk-gate.cjs` 那一对。
 *
 * ── 形态：**模型判断 + 闸门兜底**（用户 2026-10-03 点名要的）──
 * 闸门**不替模型决定该不该问**。它拦下时**不执行工具**，只把话还给模型：
 * 「先用 ask_user 把范围和代价说清楚」。为什么不硬判：`npm test` 和「扫描整个项目」
 * 在字符串上长得一样，而「整个项目」多大只有模型看得出来
 * （用户原话：「代码判断不了，模型可以看」）。
 *
 * ── 本对话内同类不再问（用户 2026-10-03 亲自调整）──
 * 复用 `tools/approval.cjs` 的思路，但**不设时间窗口**：他批了扫 C 盘，紧接着扫 D 盘
 * 不该再问一次。授权在「这个对话里 `ask_user` 真被答过一次」时记下
 * （`noteAsked`，调用点在 `tools/ask_user.cjs` 的「答了」那一支）。
 *
 * ── 留痕（用户要的「不靠拍，靠数据」）──
 * 每次触发都写审计（`extras.scale`：预估秒数/文件数/命中的信号/判决）
 * + 一行 `[规模预检]` 日志。跑一段时间后拿审计里的**实际耗时**回头校准默认值。
 *
 * ⚠️ 不 require electron（自检能裸跑）。
 */

const log = require('../log.cjs')
const auditCore = require('../audit.cjs')
const taskCore = require('../task.cjs')
const configCore = require('../config.cjs')
const scale = require('../scale.cjs')
const scaleConfig = require('../scale-config.cjs')

const { KINDS, HARD_SECONDS, HARD_FILES, NOTE_SECONDS, BLOCKED_MARK, inspect, kindOf } = scale

/**
 * 这次生效的阈值与开关（配置 → 闸门）。
 *
 * 读相照 `risk-gate.cjs` 读 `shellPolicy` 那个写法：`ctx` 里给了就用它（自检/测试注入），
 * 否则问 `config`（归一化已保证是干净的）。读不到就用默认值 —— 宁可按默认拦，也不能哑。
 */
function limitsOf(ctx = {}) {
  const fromCtx = ctx.assistant
  const fromConfig = (() => {
    try {
      return configCore.get()?.assistant
    } catch {
      return null
    }
  })()
  const merged = scaleConfig.normalize({ ...(fromConfig ?? {}), ...(fromCtx ?? {}) })
  return {
    enabled: merged.scaleFirst !== false,
    limits: {
      hardSeconds: merged.scaleHardSeconds,
      warnSeconds: merged.scaleWarnSeconds,
      maxFiles: merged.scaleMaxFiles,
    },
  }
}

/* ── 对模型说的话 ─────────────────────────────────────────── */

const WHAT = {
  [KINDS.SCAN]: '范围可能很大的扫描',
  [KINDS.BATCH]: '批量的复制 / 压缩 / 下载上传 / 爬站',
  [KINDS.LONG]: '明显耗时的操作',
}

function blockText(kind, reasons, estimate) {
  const files = estimate.files === null ? '文件数未知' : `约 ${estimate.files} 个文件`
  const secs = estimate.seconds === null ? '耗时未知' : `约 ${estimate.seconds} 秒`
  return (
    `${BLOCKED_MARK}（${WHAT[kind] ?? '规模不小'}）。` +
    `看出来的信号：${reasons.join('；')}；预估 ${files} / ${secs}。` +
    '请先用 ask_user 把「打算做什么、多大范围、大约多久」说清楚（选项里写**具体数字**），' +
    '用户点头之后再按刚才那次调用重试一遍。' +
    '★ 别换个写法绕过去 —— 同类操作在这个对话里还会被同样拦下。'
  )
}

/* ── 本对话内的授权 ───────────────────────────────────────── */

/** sessionId → 已批过的 kind 集合 */
const grants = new Map()
/** sessionId → 刚被拦下的 kind（等这个对话里 ask_user 被答一次就转成授权） */
const pending = new Map()

/**
 * 这个对话里 `ask_user` 真被答过一次 —— 把刚才那次规模拦截记成「用户批了」。
 *
 * 为什么只按 kind、只在本对话内：「他答了」是那条路上唯一确定的事实，
 * 「他答的是同意」不是代码能判的 —— 范围含糊时宁可下次再问一遍。
 *
 * @returns {string|null} 转成授权的 kind
 */
function noteAsked(sessionId) {
  const key = String(sessionId ?? '')
  const kind = pending.get(key)
  if (!key || !kind) return null
  pending.delete(key)
  if (!grants.has(key)) grants.set(key, new Set())
  grants.get(key).add(kind)
  log.info(`[规模预检] 用户答过一次规模确认 → 本对话内「${kind}」不再问`)
  return kind
}

function granted(sessionId, kind) {
  return grants.get(String(sessionId ?? ''))?.has(kind) === true
}

/** 测试与排查用 */
function grantsFor(sessionId) {
  return [...(grants.get(String(sessionId ?? '')) ?? [])]
}

function reset() {
  grants.clear()
  pending.clear()
}

/* ── 用户那句话从哪来 ─────────────────────────────────────── */

/**
 * 判「他这轮说了范围」要用用户那句话。
 *
 * `ctx` 是 `loop.cjs` 拼的，而那是**硬禁区**，加不了字段 —— 所以走**既有链路**：
 * 任务台账里的 `goal` 就是用户那句话（`handlers/chat.cjs` 传
 * `goal: lastUserText(history)`，`loop-run.cjs` 建任务时存进台账）。
 *
 * 取不到就不判 —— 然后照常问一次。**问是安全方向**（最多多一次点击）。
 */
function goalOf(taskId) {
  const id = String(taskId ?? '')
  if (!id) return ''
  try {
    return String(taskCore.get(id)?.goal ?? '')
  } catch {
    return ''
  }
}

/* ── 留痕 ─────────────────────────────────────────────────── */

/**
 * 两处都写，理由不同：
 *   · **审计**（`data/audit/*.jsonl`）：一条被规模拦下的调用就该像别的调用一样有账，
 *     `extras.scale` 带预估，将来和**实际耗时**比就能校准；
 *   · **日志**（`data/logs/*.log`）：一行 `[规模预检]`，真机探针和排查直接 grep 它。
 */
function record(audit, ctx, name, args, verdict, decision) {
  const scaleInfo = {
    decision,
    kind: verdict.kind,
    scope: verdict.scope,
    reasons: verdict.reasons,
    files: verdict.estimate.files,
    seconds: verdict.estimate.seconds,
    basis: verdict.estimate.basis,
  }
  try {
    audit({
      sessionId: String(ctx.sessionId ?? ''),
      taskId: String(ctx.taskId ?? ''),
      tool: `scale-gate:${name}`,
      args,
      approval: null,
      ok: false,
      error: decision === 'blocked' ? '规模确认：先问用户' : `规模预检：${decision}`,
      startedAt: Date.now(),
      extras: { scale: scaleInfo },
    })
  } catch {
    /* 审计写不进去不能把主流程弄挂（和 log.cjs 一个态度） */
  }
  const files = verdict.estimate.files === null ? '未知' : verdict.estimate.files
  const secs = verdict.estimate.seconds === null ? '未知' : `${verdict.estimate.seconds}s`
  log.info(
    `[规模预检] ${decision} · ${verdict.kind} · ${verdict.scope} · 预估 ${files} 文件 / ${secs}` +
      ` · ${verdict.reasons.join('；')} · 会话 ${log.shortId(String(ctx.sessionId ?? ''))}`,
  )
}

/* ── 闸门 ─────────────────────────────────────────────────── */

/**
 * @param {{ name: string, args?: object, ctx?: object,
 *           audit?: (entry: object) => void, dry?: boolean }} input
 *   `ctx` 用到 `workdir` / `sessionId` / `taskId` / `lastUserText`（后者可选，
 *   没有就回落到台账里的 `goal`）。
 *   `dry: true` = **只看不判**（给调用方拿预估写进「已经要弹的那个确认框」用）：
 *   不记授权、不写账、不改状态；返回的是**原始判决**（`'ok'|'note'|'ask'`）。
 * @returns {{ level: 'ok'|'note'|'blocked', kind?: string, text?: string,
 *             estimate?: object, reasons?: string[] }}
 */
function gate({ name, args = {}, ctx = {}, audit = auditCore.record, dry = false }) {
  const { enabled, limits } = limitsOf(ctx)
  /*
   * `scaleFirst: false` = **只关「规模」这一层**，直接放行。
   * ★ 危险度那一层**不受影响**：`risk-gate.cjs` / 权限层 / 敏感文件提示一个字没改 ——
   *   危险命令该拦照拦、该问照问。这个开关是规模层的回滚开关，不是「关掉安全检查」
   *   （自检里有一条专门钉这个语义：关掉之后「递归删盘」仍然会被危险度拦下）。
   */
  if (!enabled) return { level: 'ok', disabled: true }
  const verdict = inspect({
    name,
    args,
    workdir: String(ctx.workdir ?? ''),
    userText: String(ctx.lastUserText ?? '') || goalOf(ctx.taskId),
    limits,
  })
  if (dry) {
    return {
      level: verdict.level,
      kind: verdict.kind ?? undefined,
      estimate: verdict.estimate,
      reasons: verdict.reasons,
      ...(verdict.level === 'ask'
        ? { text: blockText(verdict.kind, verdict.reasons, verdict.estimate) }
        : {}),
    }
  }
  if (verdict.level === 'ok') return { level: 'ok', kind: verdict.kind ?? undefined }

  const sessionId = String(ctx.sessionId ?? '')

  /* 有界重活（note）：**不拦**，只留痕。提示词层会要求模型主动说一句规模。 */
  if (verdict.level === 'note') {
    record(audit, ctx, name, args, verdict, 'note')
    return { level: 'note', kind: verdict.kind, estimate: verdict.estimate, reasons: verdict.reasons }
  }

  /* 本对话已经批过同类 —— 记一行（这也是「授权省掉了几次打扰」的数据） */
  if (granted(sessionId, verdict.kind)) {
    record(audit, ctx, name, args, verdict, 'granted')
    return { level: 'ok', kind: verdict.kind, granted: true }
  }

  if (sessionId) pending.set(sessionId, verdict.kind)
  record(audit, ctx, name, args, verdict, 'blocked')
  return {
    level: 'blocked',
    kind: verdict.kind,
    estimate: verdict.estimate,
    reasons: verdict.reasons,
    text: blockText(verdict.kind, verdict.reasons, verdict.estimate),
  }
}

module.exports = {
  /* 阈值与识别（从 `core/scale.cjs` / `core/scale-config.cjs` 转出去：调用方一个入口就够） */
  KINDS,
  HARD_SECONDS,
  HARD_FILES,
  NOTE_SECONDS,
  BLOCKED_MARK,
  limitsOf,
  inspect,
  kindOf,
  /* 闸门 */
  gate,
  noteAsked,
  granted,
  grantsFor,
  reset,
}

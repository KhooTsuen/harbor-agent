/**
 * 规模识别（A2）：**这次要花多大代价** —— 只看一次工具调用，不碰任何状态。
 *
 * 为什么单独一个文件：管事的原本只有两层 —— 权限层（能不能读写）和 `risk.cjs`
 * 的**危险度**（做错了会不会毁东西），**没人管规模**（见 `docs/安全模型.md` §8）。
 * 这一层就是补那一维，形状照 `risk.cjs`：**纯函数、不 require electron、不带副作用**，
 * 所以自检能拿一堆「肯定该问 / 肯定不该问」的输入直接喂它（`108-scale-gate` 组）。
 * 闸门（要不要拦、授权、留痕）在 `tools/scale-gate.cjs`。
 *
 * ★ **宁可漏判也不误伤**：误伤（动不动就拦）会让用户很快学会闭眼点确认，
 *   那比不问更糟。所以每条信号都要「一眼能认出来」，拿不准就交给模型。
 */

const scaleConfig = require('./scale-config.cjs')
/* 认信号那一层（模式表 + 判范围）在 `scale-signals.cjs` —— 拆出去是为了守住 300 行 */
const { RECURSIVE, BATCH, EXTERNAL, URL_TOKEN, LONG_TABLE, scopeOf, userSaidScope } =
  require('./scale-signals.cjs')

/** 三类规模（授权按这三个键记：批过一次「扫描」，下一次扫描不必再问） */
const KINDS = { SCAN: 'scan', BATCH: 'batch', LONG: 'long' }

/*
 * 阈值现在是**配置项**（默认值与夹取在 `scale-config.cjs`）。
 * 这里只把它们转出去，让老引用（自检 / 验收判据）不用改；
 * `inspect()` 收 `limits` 入参、不传就回落默认 —— 形状和 `clarify-timeout.cjs` 一致。
 */
const HARD_SECONDS = scaleConfig.DEFAULTS.scaleHardSeconds
const NOTE_SECONDS = scaleConfig.DEFAULTS.scaleWarnSeconds
const HARD_FILES = scaleConfig.DEFAULTS.scaleMaxFiles

/**
 * 拦截文案的开头（**一处定义**）。
 *
 * 闸门用它拼给模型看的话，验收判据（T12）用它区分「尝试被拦下」与「真的执行了」——
 * 两者在台账里都是一条步骤，只差 `summary` 里有没有这句话。
 * 两处各写一份字符串，哪天改文案就会静默失配（纪律 #9）。
 */
const BLOCKED_MARK = '先别做：这次的规模不小'


/* ── 判规模 ───────────────────────────────────────────────── */

/**
 * 看一次工具调用：规模大不大。
 *
 * @param {{ name: string, args?: object, workdir?: string, userText?: string,
 *           limits?: { hardSeconds?: number, warnSeconds?: number, maxFiles?: number } }} call
 *   `limits` 由调用方注入（闸门从配置读）—— 不传就回落 `scale-config.cjs` 的默认值，
 *   所以自检与验收判据直接 `inspect(...)` 也能跑。
 * @returns {{ level: 'ok'|'note'|'ask', kind: string|null, scope: string,
 *             reasons: string[], estimate: { files: number|null, seconds: number|null, basis: string },
 *             tokens: string[] }}
 */
function inspect({ name, args = {}, workdir = '', userText = '', limits = {} }) {
  const hard = Number.isFinite(Number(limits.hardSeconds)) ? Number(limits.hardSeconds) : HARD_SECONDS
  const warn = Number.isFinite(Number(limits.warnSeconds)) ? Number(limits.warnSeconds) : NOTE_SECONDS
  const maxFiles = Number.isFinite(Number(limits.maxFiles)) ? Number(limits.maxFiles) : HARD_FILES
  const none = {
    level: 'ok',
    kind: null,
    scope: 'workdir',
    reasons: [],
    estimate: { files: null, seconds: null, basis: 'unknown' },
    tokens: [],
  }

  let recursive = false
  let batch = false
  let external = false
  let text = ''
  const reasons = []

  if (name === 'run_shell') {
    text = String(args.command ?? '')
    recursive = RECURSIVE.some((re) => re.test(text))
    batch = BATCH.some((re) => re.test(text))
    for (const [re, what] of EXTERNAL) {
      if (re.test(text)) {
        external = true
        reasons.push(`批量外联：${what}`)
        break
      }
    }
    /* 一条命令里挂着多个地址（curl a b c）也算批量；单条 curl 不算 */
    if (!external && /\b(?:curl|wget)\b/i.test(text) && (text.match(URL_TOKEN) ?? []).length >= 2) {
      external = true
      reasons.push('一条命令里多个地址')
    }
  } else if (name === 'list_dir') {
    const depth = Number(args.depth) || 1
    text = String(args.path ?? '')
    recursive = depth > 1
    if (recursive) reasons.push(`列目录递归 ${depth} 层`)
  } else {
    /* 别的工具（read_file / browse / search_web…）都是一次一个目标，不构成规模 */
    return none
  }

  if (recursive) reasons.push('递归 / 遍历')
  if (batch) reasons.push('批量（复制 / 压缩 / 解压）')

  /* 长耗时类别（估个秒数；不构成硬拦，只用来 note） */
  let seconds = null
  if (name === 'run_shell') {
    for (const [re, est, what] of LONG_TABLE) {
      if (re.test(text)) {
        seconds = est
        reasons.push(`像是${what}`)
        break
      }
    }
  }

  if (!recursive && !batch && !external && seconds === null) return none

  const { scope, tokens } = scopeOf(text, workdir)
  if (scope === 'drive-root' && (recursive || batch)) {
    seconds = Math.max(seconds ?? 0, 300)
    reasons.push('范围是盘根 / 全盘')
  }

  const escapes = scope === 'drive-root' || scope === 'outside'
  const estimate = {
    files: null /* 预检不数文件 —— 数一遍本身就是它要拦的那种操作；如实写「未知」 */,
    seconds,
    basis: seconds === null ? 'unknown' : 'table',
  }

  /* ① 用户这轮字面上说了这个范围 → 他已经授权了，不问（也不拦） */
  if (escapes && userSaidScope(userText, tokens)) {
    return {
      level: 'ok',
      kind: null,
      scope,
      reasons: [...reasons, '用户这轮说了这个范围'],
      estimate,
      tokens,
    }
  }

  /*
   * 硬拦两条：
   *   · **批量外联** —— 范围不可控（爬一个站、镜像一个仓库），和它逃不逃出工作目录无关；
   *   · **递归/批量 且逃出工作目录** —— 「扫全盘」这类，代价值得先问一句。
   * 再加一条估时闸门（阈值可从配置改，见 `scale-config.cjs`）。
   */
  const isHard =
    external ||
    (escapes && (recursive || batch)) ||
    (seconds !== null && seconds >= hard) ||
    (estimate.files !== null && estimate.files > maxFiles)

  const kind = kindOf(recursive, batch, external, seconds)
  if (isHard) return { level: 'ask', kind, scope, reasons, estimate, tokens }

  const worth = recursive || batch || external || (seconds ?? 0) >= warn
  return {
    level: worth ? 'note' : 'ok',
    kind: worth ? kind : null,
    scope,
    reasons,
    estimate,
    tokens,
  }
}

/** 归到三类里的哪一类（授权按它记：批过一次「扫描」，下一次扫描不必再问） */
function kindOf(recursive, batch, external, seconds) {
  if (external || batch) return KINDS.BATCH
  if (recursive) return KINDS.SCAN
  /* 只因为估时长 —— 归「耗时」那一类（`npm test` 不是「扫描」，审计里别记错） */
  if (seconds !== null) return KINDS.LONG
  return KINDS.SCAN
}

module.exports = {
  KINDS,
  HARD_SECONDS,
  HARD_FILES,
  NOTE_SECONDS,
  BLOCKED_MARK,
  inspect,
  kindOf,
  scopeOf,
  userSaidScope,
}

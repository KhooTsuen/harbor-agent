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

/** 三类规模（授权按这三个键记：批过一次「扫描」，下一次扫描不必再问） */
const KINDS = { SCAN: 'scan', BATCH: 'batch', LONG: 'long' }

/** 估时到这儿 = 硬拦（用户 2026-10-03 定的默认值；将来靠审计里的真实数据校准） */
const HARD_SECONDS = 120
/** 估时到这儿起记 note（更短的连提都不值得提） */
const NOTE_SECONDS = 30
/** 能算出文件数时，超过它就硬拦（现在基本算不出来，见下面 estimate.files） */
const HARD_FILES = 2000

/* ── 认信号 ───────────────────────────────────────────────── */

/** 递归写法 */
const RECURSIVE = [
  /-Recurse\b/i,
  /(?:^|[\s"'])\/s(?=[\s"']|$)/, // dir /s
  /\bgci\b[^|]*\s-r\b/i, // PowerShell 的简写
  /(?:^|[\s"'])-r(?=[\s"']|$)/, // 单独一个 -r
  /\*\*/, // glob 的 **
  /\b(?:find|fd)\b[^|]*\s\/(?=[\s"']|$)/, // find / —— 从根上找
]

/** 批量（本地批处理） */
const BATCH = [
  /\b(?:robocopy|xcopy)\b/i,
  /\b(?:7z|tar)\b[^|]*\s(?:a|x|--extract)\b/i, // 整包压缩 / 解压
]

/**
 * 批量**外联**（下载 / 上传 / 镜像 / 爬站）。
 *
 * ★ 分界是「**批量 vs 单次**」，不是「联网 vs 本地」（用户 2026-10-03 亲自定的）：
 *   · 一次网页抓取（`browse` / 单条 curl）→ **不拦**，那是正常操作；
 *   · 批量下载/上传 / 爬整个站 → **硬拦**，范围不可控。
 * 所以只有当命令看着「要抓一批」时才算 —— 单看有没有网络字眼会把正常活全拦下。
 */
const EXTERNAL = [
  [/\bwget\b[^|]*(?:-r\b|--recursive|--mirror|\s-m\b)/i, 'wget 递归/镜像'],
  [/\bhttrack\b/i, '整站抓取'],
  [/\brclone\b/i, 'rclone 批量同步'],
  [/\bgit\s+clone\b[^|]*--mirror/i, '镜像克隆'],
]

/** 一条命令里出现了几个网址（≥ 2 个 = 批量） */
const URL_TOKEN = /https?:\/\/[^\s"']+/g

/** 长耗时的类别表（都是**有界**的常见开发动作 → 只 note 不拦） */
const LONG_TABLE = [
  [/\b(?:npm|pnpm|yarn)\s+(?:ci|install|i|add)\b/, 60, '装依赖'],
  [/\bgit\s+clone\b/, 60, '克隆仓库'],
  [
    /\b(?:npm|pnpm|yarn)\s+run\s+build\b|\bvite\s+build\b|\bcargo\s+build\b|\bdocker\s+build\b/,
    60,
    '构建',
  ],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bvitest\b/, 45, '跑测试'],
]

/* ── 判范围 ───────────────────────────────────────────────── */

/** 盘根：`C:\` / `C:` / `/` 单独出现（不是某个子目录） */
const DRIVE_ROOT = /(?:^|[\s"'=])([A-Za-z]:[\\/]?|\/)(?=$|[\s"';|>&)])/
/** 绝对路径（Windows 盘符 / UNC） */
const ABS_PATH = /[A-Za-z]:\\[^\s"';|>&]*|\\\\[^\s"';|>&]+/g

/**
 * 一个盘符的几种写法 —— 用户说话时写的是「C 盘」，不是 `C:`。
 * 比对时会**去掉空格**，所以「C盘」「C 盘」「c:」都能对上。
 */
function driveTokens(letter) {
  const one = String(letter ?? '').toUpperCase()
  if (!/^[A-Z]$/.test(one)) return []
  return [`${one}:`, `${one}盘`, `${one.toLowerCase()}:`, `${one.toLowerCase()}盘`]
}

/**
 * 这次动的是哪儿。
 *
 * @returns {{ scope: 'workdir'|'outside'|'drive-root', tokens: string[] }}
 *   `tokens` 是「用户要是提过这个范围，就算他说清了」的比对串（盘符的各种写法 / 目录名）。
 */
function scopeOf(text, workdir) {
  const tokens = []
  if (DRIVE_ROOT.test(text)) {
    const hit = text.match(DRIVE_ROOT)?.[1] ?? ''
    const letter = String(hit).match(/^([A-Za-z]):/)?.[1]
    if (letter) tokens.push(...driveTokens(letter))
    return { scope: 'drive-root', tokens }
  }
  const wd = String(workdir ?? '').toLowerCase()
  for (const path of text.match(ABS_PATH) ?? []) {
    const lowered = path.toLowerCase()
    if (wd && (lowered === wd || lowered.startsWith(`${wd}\\`))) continue
    /* 工作目录之外：记下盘符（各种写法）和最后一段目录名（用户说「扫 D 盘那个项目」也算说清了） */
    const letter = path.match(/^([A-Za-z]):/)?.[1]
    if (letter) tokens.push(...driveTokens(letter))
    const tail = path.split(/[\\/]/).filter(Boolean).at(-1)
    if (tail) tokens.push(tail)
    return { scope: 'outside', tokens }
  }
  if (/~[\\/]/.test(text) || /(?:^|\s)~(?=\s|$)/.test(text)) {
    tokens.push('~', '家目录', '用户目录')
    return { scope: 'outside', tokens }
  }
  return { scope: 'workdir', tokens: [] }
}

/** 用户这句话字面上提到过这个范围吗（**不猜意图**，只认字面；去掉空格后比，「C 盘」=「c盘」） */
function userSaidScope(userText, tokens) {
  const said = String(userText ?? '').toLowerCase().replace(/\s+/g, '')
  if (!said || tokens.length === 0) return false
  return tokens.some((one) => {
    const token = String(one).toLowerCase().replace(/\s+/g, '')
    return token.length >= 2 && said.includes(token)
  })
}

/* ── 判规模 ───────────────────────────────────────────────── */

/**
 * 看一次工具调用：规模大不大。
 *
 * @param {{ name: string, args?: object, workdir?: string, userText?: string }} call
 * @returns {{ level: 'ok'|'note'|'ask', kind: string|null, scope: string,
 *             reasons: string[], estimate: { files: number|null, seconds: number|null, basis: string },
 *             tokens: string[] }}
 */
function inspect({ name, args = {}, workdir = '', userText = '' }) {
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
   * 再加一条估时闸门（估时能算出来时才生效）。
   */
  const hard =
    external ||
    (escapes && (recursive || batch)) ||
    (seconds !== null && seconds >= HARD_SECONDS) ||
    (estimate.files !== null && estimate.files > HARD_FILES)

  const kind = kindOf(recursive, batch, external, seconds)
  if (hard) return { level: 'ask', kind, scope, reasons, estimate, tokens }

  const worth = recursive || batch || external || (seconds ?? 0) >= NOTE_SECONDS
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
  inspect,
  kindOf,
  scopeOf,
  userSaidScope,
}

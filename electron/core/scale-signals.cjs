/**
 * 规模识别的**信号层**：模式表 + 「这次动的是哪儿」。
 *
 * 为什么从 `scale.cjs` 拆出来：那边加完「环境变量 / Unix 根也算工作目录之外」之后
 * 到了 **312 行**（硬约束 #2 是 300）。缝按职责切：
 *   · 这里 —— **认信号**：正则表（递归 / 批量 / 外联 / 长耗时）和 `scopeOf`（范围）；
 *   · `scale.cjs` —— **判规模**：`inspect()` 把信号拼成 `ok / note / ask`。
 * 两边都是纯函数、不 require electron（自检能裸跑），拆开不引入任何状态。
 *
 * ⚠️ 表里的每一条都要「一眼能认出来」—— 拿不准的交给模型，宁可漏判也不误伤
 *   （见 `docs/安全模型.md` §8 的分工说明）。
 */

/* ── 认信号 ───────────────────────────────────────────────── */

/** 递归写法 */
const RECURSIVE = [
  /-Recurse\b/i,
  /(?:^|[\s"'])\/s(?=[\s"']|$)/, // dir /s
  /\bgci\b[^|]*\s-r\b/i, // PowerShell 的简写
  /(?:^|[\s"'])-r(?=[\s"']|$)/, // 单独一个 -r
  /\*\*/, // glob 的 **
  /*
   * `find` / `fd` **本身就是递归遍历**，不限定目标（目标是不是逃出工作目录由 `scopeOf` 判：
   * 工作目录内只 note，不会打扰人）。原来只认 `find /` 这一种写法，于是
   * `find /usr -name "*.so"` 连「递归」都不算 —— 2026-10-03 量口径时撞出来的。
   */
  /\b(?:find|fd)\b/,
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
/** 绝对路径（Windows 盘符 / UNC）—— 两种斜杠都算（`C:\Users` 和 `C:/Users` 是同一个地方） */
const ABS_PATH = /[A-Za-z]:[\\/][^\s"';|>&]*|\\\\[^\s"';|>&]+/g
/*
 * 环境变量指向的路径（`$env:USERPROFILE` / `%TEMP%`）—— **指到哪儿运行时才知道**，
 * 一律当「工作目录之外」。为什么必须算进来：2026-10-03 真机跑 T12 前离线量了一次，
 * `Get-ChildItem $env:USERPROFILE -Recurse` 被当成 `workdir` → 只 note 不拦；
 * 而用户目录递归一趟十几万个文件，**正是这一层该拦的东西**。
 * 为什么不给 tokens（不认「用户说了范围」的豁免）：这些写法说不清是哪个目录
 * （`$env:USERPROFILE` 换台机器就不是同一个地方），宁可多问一句 —— 问是安全方向。
 * ⚠️ 不带 `g`：`.test()` 带 `g` 会记住 lastIndex，同一行连着判会时真时假。
 */
const ENV_PATH = /\$env:[A-Za-z_]+|%[A-Za-z_]+%/i
/** Unix 侧的绝对根（Git Bash / WSL 里跑得到的写法，`ABS_PATH` 一条都不认） */
const POSIX_ROOT = /\/(?:home|usr|var|etc|mnt|opt|root|srv|boot|bin|lib)\b/i

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
  /*
   * 环境变量 / Unix 根：判成「外面」，理由见 `ENV_PATH` 那段注释。
   * 位置在**显式绝对路径之后** —— 有 `C:\Users` 这种说得清的目标时用它自己的 tokens
   * （用户说了「扫 C:\Users」就该豁免），只有光靠绝对路径判不出来时才回落到这里。
   */
  if (ENV_PATH.test(text) || POSIX_ROOT.test(text)) return { scope: 'outside', tokens }
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

module.exports = {
  RECURSIVE,
  BATCH,
  EXTERNAL,
  URL_TOKEN,
  LONG_TABLE,
  scopeOf,
  userSaidScope,
}

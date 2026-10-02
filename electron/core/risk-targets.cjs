/**
 * 「递归删除 + 危险目标」的判定 —— 补齐 critical 那一层漏掉的识别
 *
 * 为什么单独一个文件：理由和 `risk-patterns.cjs` 当初被拆出来一样 ——
 * 这张表**还要继续长**，塞回 `risk.cjs` 会顶到 300 行红线。
 *
 * 旧规则（`risk-patterns.cjs` 里那两条 PowerShell 正则）要求盘根**恰好在最后一个参数**：
 * 参数顺序一换（`-Recurse C:\ -Force`）、加个引号（`"C:\"`）就掉出 critical。
 * 2026-10-03 实测 46 条 → **28 条漏判**，其中就有 `rm -rf /` —— 而旧注释一直把它
 * 当「同一件事」的参照写着。清单在 `docs/踩坑记录.md`（「递归删盘根：曾经漏过的 28 条」）。
 *
 * 现在的做法：**先把命令归一化，再判目标** —— 位置、引号、额外开关都无关。
 *   腿 1  认动作：`rm -r` / `del /s` / `rd /s` / `Remove-Item -Recurse`，
 *         以及**不带 `-r` 的 `rm -f`**（`rm -f /` 删不掉目录 —— 但那是命令自己失败，
 *         不该由命令来替判据兜底。2026-10-03 修的口子 A）
 *   腿 2  认目标：盘根、系统目录、家目录（本身 + 一级标准目录）、所有用户的家目录
 *   腿 3  绕一层：`find -delete` / `xargs rm` / 脚本里**写死**的路径
 *
 * ⚠️ 判错的代价不对称（和 `risk-patterns.cjs` 同一条）：漏判 = 静默毁数据，
 *    误判 = 多问一次。所以拿不准就往上判 —— 但**相对路径一律不算**：
 *    `rm -rf ./build`、`rm -rf ~/projects/foo` 只是 high。误报多了用户会把整个分级关掉，
 *    那比不修更糟。反向用例钉在自检组 `61-destructive`。
 */

/* ── 腿 1：认「递归删除」这个动作 ───────────────────────────── */

/*
 * `[^\n|;&]*?` 是防止「跨段」匹配（`rm -rf ./build && grep -r x /usr` 里的 `/usr` 不是目标）。
 * `\s-[a-z]*r[a-z]*` 要求那个开关**紧跟在空白后面** —— 这样 `--preserve-root` 这种
 * 长开关里出现的 `r` 不会被误当成递归（它的第一个 `-` 后面是 `-`，不是 `r`）。
 */
const RECURSIVE_ACTION = [
  /\brm\b[^\n|;&]*?\s-[a-z]*r[a-z]*(?=[\s;|&]|$)/,
  /\brm\b[^\n|;&]*?\s--recursive\b/,
  /\b(del|erase)\b[^\n|;&]*?\s\/[a-z]*s(?=[\s;|&]|$)/,
  /\b(rmdir|rd)\b[^\n|;&]*?\s\/[a-z]*s(?=[\s;|&]|$)/,
  /\bremove-item\b[^\n|;&]*?-recurse\b/,
]

/*
 * 不带 `-r` 的强制删除。单独一张表，因为它不是「递归」—— 但**目标是盘根时后果一样**：
 * `rm -f /` 会去删根目录下的每一项（能不能删掉是命令的事，判据不该赌这个）。
 * 原来这条只判 medium，而 medium 可以被配成**静默放行**（`rm -f /` 就是这么溜过去的）。
 * 反向锁：`rm -f ./build/file.txt`、`rm -f ~/Documents/x.pdf` 仍然只是 medium。
 */
const FORCE_ACTION = [/\brm\b[^\n|;&]*?\s-[a-z]*f[a-z]*(?=[\s;|&]|$)/]

/* ── 腿 2：认「危险目标」 ───────────────────────────────────── */

/** 家目录下的一级标准目录：只有它们**本身**算危险，再往下一层就不算 */
const HOME_STANDARD = 'documents|desktop|downloads|pictures|videos|music'

/** 家目录的四种写法（归一化后已经全小写）—— 只白名单这几个变量，未知变量一律不判 */
const HOME = '(?:~|\\$home|\\$env:userprofile|%userprofile%)'

/** 目标前面必须是这些：`./usr` 里的那个 `/` 前面是 `.`，所以不会被当成绝对路径 */
const BOUNDARY = '(?:^|[\\s;|&(,])'

/** 目标结尾：允许尾随 `/` 和通配（`C:\`、`/*`、`/usr/*`、`C:\*.*`），后面必须是分隔符或行尾 */
const END = '[\\/*]*\\*?(?:\\.[a-z*]+)?(?=[\\s;|&),]|$)'

/** 允许继续往下 —— 系统目录是「含其下任意路径」（`C:\Windows\Temp\x` 也算删系统目录） */
const DEEPER = '(?=[\\s;|&)\\/]|$)'

const DANGEROUS_TARGET = [
  [new RegExp(`${BOUNDARY}${HOME}(?:\\/*(?:${HOME_STANDARD}))?${END}`), '家目录（或家目录下的一级目录）'],
  /* 盘根：`/`、`/*`、`C:`、`C:\`、`C:/`、`C:\*` —— 归一化后都长一样 */
  [new RegExp(`${BOUNDARY}[a-z]:${END}`), '整个盘'],
  [new RegExp(`${BOUNDARY}\\/+${END}`), '根目录'],
  /* 系统目录 */
  [new RegExp(`${BOUNDARY}[a-z]:\\/+(?:windows|program files(?: \\(x86\\))?)${DEEPER}`), '系统目录'],
  [
    new RegExp(`${BOUNDARY}\\/+(?:usr|etc|bin|sbin|lib|boot|opt|var|system|library)${DEEPER}`),
    '系统目录',
  ],
  /* 所有用户的家目录（`C:\Users` / `/home`）—— 这里结尾**不允许**跟 `/`，否则
     `C:\Users\me\projects` 会被当成「C:\Users 的子树」而误判 */
  [new RegExp(`${BOUNDARY}[a-z]:\\/+users${END}`), '所有用户的家目录'],
  [new RegExp(`${BOUNDARY}\\/+home${END}`), '所有用户的家目录'],
  /* 某个用户的家目录本身（含其下的一级标准目录） */
  [
    new RegExp(`${BOUNDARY}[a-z]:\\/+users\\/+[^/\\s;|&]+(?:\\/*(?:${HOME_STANDARD}))?${END}`),
    '某个用户的家目录',
  ],
  [
    new RegExp(`${BOUNDARY}\\/+home\\/+[^/\\s;|&]+(?:\\/*(?:${HOME_STANDARD}))?${END}`),
    '某个用户的家目录',
  ],
]

/**
 * 归一化：去掉引号、反斜杠统一成正斜杠、转小写。
 * 目的只有一个 —— **位置 / 引号 / 额外开关不该影响判定**：
 * `"C:\"`、`C:\\`、`-Path C:\` 归一化之后是同一样东西。
 * @param {string} text
 */
function normalize(text) {
  return String(text ?? '')
    .replace(/["']/g, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

/**
 * 这段（已归一化的）文字里有没有危险目标。
 * @param {string} normalized
 * @returns {string|null} 目标类别（给人看的），没有就 null
 */
function matchDangerousTarget(normalized) {
  for (const [pattern, label] of DANGEROUS_TARGET) {
    if (pattern.test(normalized)) return label
  }
  return null
}

/* ── 腿 3：绕一层的写法 ─────────────────────────────────────── */

/**
 * `find` / `xargs` / 脚本字面量 —— 危险的东西藏在参数里。
 * @param {string} text 原始命令（腿 3 的脚本字面量要看引号，所以这里不吃归一化后的）
 * @returns {string|null}
 */
function indirectReason(text) {
  const normalized = normalize(text)

  /* find 边搜边删：判的是**搜索起点**（`{}` 是相对它算的） */
  if (/\bfind\b/.test(normalized) && /-delete\b|\s-exec\s+(?:rm|rmdir)\b/.test(normalized)) {
    const root = /\bfind\b\s+(\S+)/.exec(normalized)
    const hit = root ? matchDangerousTarget(root[1]) : null
    if (hit) return `find 边搜边删（起点是${hit}）`
  }

  /* xargs 把结果喂给 rm：判的是**管道左边**给出来的东西 */
  if (/\bxargs\b[^\n|;&]*\brm\b/.test(normalized)) {
    const hit = matchDangerousTarget(normalized.split('|')[0])
    if (hit) return `xargs 把${hit}喂给 rm`
  }

  /* 脚本里的字面量：`shutil.rmtree('E:/')`、`fs.rmSync('C:\\')`。
     参数是变量就看不见了，所以只抓**写死**的这种 —— 和旧规则同一口径。 */
  const literal = /\b(rmtree|rmSync|rmdirSync|delTree)\s*\(\s*['"]([^'"]+)['"]/i.exec(text)
  if (literal) {
    const hit = matchDangerousTarget(normalize(literal[2]))
    if (hit) return `脚本里写死了${hit}`
  }

  return null
}

/* ── 出口 ───────────────────────────────────────────────────── */

/**
 * 这段里有「删了就没」的动作吗？返回给用户看的说法（null = 没这种动作）。
 * @param {string} normalized
 */
function actionOf(normalized) {
  if (RECURSIVE_ACTION.some((pattern) => pattern.test(normalized))) return '递归删除'
  if (FORCE_ACTION.some((pattern) => pattern.test(normalized))) return '强制删除'
  return null
}

/**
 * 这条命令是不是「递归删除 + 危险目标」。
 * @param {string} command
 * @returns {string|null} 理由（给用户看的一句话）；不是这一类返回 null
 */
function dangerousDeleteReason(command) {
  const text = String(command ?? '')
  if (!text) return null

  /*
   * 按 `&&` / `||` / `;` / `|` 切段：**目标和动作必须在同一段里**。
   * 不然 `rm -rf ./build && grep -r x /usr` 会因为旁边那句 grep 里的 `/usr` 被判危急。
   */
  for (const segment of text.split(/&&|\|\||;|\|/)) {
    const normalized = normalize(segment)
    const action = actionOf(normalized)
    if (!action) continue
    const hit = matchDangerousTarget(normalized)
    if (hit) return `${action}${hit}`
  }

  return indirectReason(text)
}

module.exports = { dangerousDeleteReason, matchDangerousTarget, normalize }

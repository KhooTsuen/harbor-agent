/**
 * Harbor 侧宿主的**策略层**（2026-10-17 第二阶段 · 生产版）
 *
 * 两件事，都是「什么允许、什么拒绝」的判据 —— 与执行分离，便于单测与审查。
 *
 *   ① `resolveInWorkspace` —— `harbor_read_file` 的**真实路径校验**（用户要求：
 *      「必须由 Harbor 主进程校验实际路径，拒绝目录穿越及符号链接越界」）。
 *   ② `diagCommands` / `pickChecks` —— `harbor_env_diag` 的**白名单**
 *      （用户要求：「仅允许执行预定义的只读诊断操作，不接受任意 shell 命令」）。
 *
 * ── ★ 为什么 read_file 还要自己再校验一遍 ────────────────────
 *
 * MCP 这条入口的来源**不是 Harbor 自己的模型**，而是**外部 Codex 进程**。
 * 外部输入应该在**边界处**就被收紧（拒绝绝对路径、拒绝 `..`），而不是把
 * 「一个任意字符串」直接交给下游去判。两层都过才读 —— 纵深防御。
 *
 * ⚠️ 不 require electron（纯函数，可在纯 Node 里跑）。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 拒绝原因码（给 MCP 那边的文案用；与 ext-protocol 的错误码风格一致） */
const REASON = {
  BAD_INPUT: 'BAD_INPUT',
  ABSOLUTE: 'ABSOLUTE_PATH',
  TRAVERSAL: 'PATH_TRAVERSAL',
  SYMLINK: 'SYMLINK_ESCAPE',
  NOT_FOUND: 'NOT_FOUND',
}

/** target 是否落在 root 之内（含 root 本身） */
function isInside(root, target) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  if (t === r) return true
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * 把一个「工作区内的相对路径」解析成**真实绝对路径**。
 *
 * 规则（逐条对应「拒绝目录穿越及符号链接越界」）：
 *   1. 必须是非空字符串，不含 NUL
 *   2. **拒绝绝对路径**（外部入口只接受相对路径 —— 收紧边界）
 *   3. `path.resolve` 之后必须仍在 root 内（挡住 `..` 与 `a/../../b`）
 *   4. **realpath 之后再判一次**（挡住「工作区内的软链接指向工作区外」）
 *
 * @param {string} root 已经 realpath 过的工作区绝对路径
 * @param {unknown} input 外部传来的路径
 * @returns {{ ok: true, abs: string } | { ok: false, code: string, message: string }}
 */
function resolveInWorkspace(root, input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, code: REASON.BAD_INPUT, message: 'path 必须是非空字符串' }
  }
  const raw = input.trim()
  if (raw.includes('\0')) {
    return { ok: false, code: REASON.BAD_INPUT, message: 'path 含非法字符（NUL）' }
  }
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return { ok: false, code: REASON.ABSOLUTE, message: '只接受工作区内的**相对**路径，不接受绝对路径' }
  }

  const abs = path.resolve(root, raw)
  if (!isInside(root, abs)) {
    return { ok: false, code: REASON.TRAVERSAL, message: '路径越出了工作区（含 .. 穿越）' }
  }

  /* ── 符号链接：解析真实路径之后**再判一次** ── */
  let real = ''
  try {
    real = fs.realpathSync(abs)
  } catch {
    /* 文件本身不存在时，退一步对**父目录**做 realpath（父目录可能是个软链接） */
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs))
    } catch {
      return { ok: false, code: REASON.NOT_FOUND, message: '文件或目录不存在（或父目录不可达）' }
    }
  }
  if (!isInside(root, real)) {
    return { ok: false, code: REASON.SYMLINK, message: '真实路径落到了工作区之外（符号链接越界）' }
  }

  return { ok: true, abs: real }
}

/* ══════════════════════════════════════════════════════════════
   harbor_write_file：**受限写**（第三阶段 · 默认关闭）
   ══════════════════════════════════════════════════════════════ */

/** 写路径的拒绝码（比读多几条：根没配 / 目标是目录 / 版本与匹配问题） */
const WRITE_REASON = {
  NO_ROOT: 'WRITE_ROOT_MISSING',
  ROOT_OUTSIDE_ISO: 'WRITE_ROOT_OUTSIDE_ISOLATION',
  IS_DIRECTORY: 'TARGET_IS_DIRECTORY',
  TOO_BIG: 'CONTENT_TOO_BIG',
  NO_VERSION: 'EXPECT_HASH_MISSING',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  NO_MATCH: 'NO_MATCH',
  MULTIPLE_MATCH: 'MULTIPLE_MATCH',
}

/** 单次写入的内容上限（1 MB）—— 畸形输入别把磁盘与审计撑爆 */
const MAX_WRITE_CHARS = 1024 * 1024

/**
 * 这个「写根」允不允许（★ 用户第 4 条：只允许写指定的 E 盘隔离测试工作区）。
 *
 * 判据**不是**「根看起来像隔离目录」，而是**它必须真的落在隔离数据根之内**
 * （`isoDir` = 主进程的 `DIRS.data`，开发版下即 `<repo>/data/unit-test-data`）。
 * 这样「指向正式源码 / 配置 / 打包产物」在**代码层面**不可能 —— 不是靠约定。
 *
 * @param {string} root 候选写根（绝对路径）
 * @param {string} isoDir 隔离数据根（绝对路径）
 * @returns {{ ok: true, abs: string } | { ok: false, code: string, message: string }}
 */
function resolveWriteRoot(root, isoDir) {
  const raw = String(root ?? '').trim()
  if (!raw) return { ok: false, code: WRITE_REASON.NO_ROOT, message: '没有配置可写的隔离工作区 —— 写工具未启用' }
  const iso = String(isoDir ?? '').trim()
  if (!iso) {
    return { ok: false, code: WRITE_REASON.ROOT_OUTSIDE_ISO, message: '拿不到隔离数据根 —— 拒绝写入' }
  }
  /* 两侧都 realpath 后再比（父目录可能是软链/junction，比字符串会被绕过） */
  let realRoot = ''
  let realIso = ''
  try {
    realRoot = fs.realpathSync(raw)
  } catch {
    return { ok: false, code: REASON.NOT_FOUND, message: `写根不存在或不可达：${raw}` }
  }
  try {
    realIso = fs.realpathSync(iso)
  } catch {
    return { ok: false, code: WRITE_REASON.ROOT_OUTSIDE_ISO, message: `隔离数据根不可达：${iso}` }
  }
  if (!isInside(realIso, realRoot)) {
    return {
      ok: false,
      code: WRITE_REASON.ROOT_OUTSIDE_ISO,
      message: `写根必须落在隔离数据根之内（${realIso}），实际是 ${realRoot} —— 拒绝`,
    }
  }
  return { ok: true, abs: realRoot }
}

/**
 * 把「写根内的相对路径」解析成真实绝对路径（**专给写入用**）。
 *
 * 复用 `resolveInWorkspace` 的全部判据（非空 / NUL / 绝对路径 / `..` 穿越 /
 * symlink 解析后再判），再加两条**写才需要**的：
 *   · 目标已存在且是**目录** → 拒绝（写文件到目录上必失败，早拒早清楚）
 *   · 目标已存在且是**符号链接/联接** → 拒绝（跟随链接会写到别处；
 *     即使 realpath 落在写根内也不放行 —— 写这个动作**不该有跟随语义**）
 *
 * @param {string} root 已通过 `resolveWriteRoot` 的写根（真实路径）
 * @param {unknown} input 外部传来的相对路径
 * @param {unknown} content 要写的内容（用来判大小）
 * @returns {{ ok: true, abs: string } | { ok: false, code: string, message: string }}
 */
function resolveForWrite(root, input, content) {
  const base = resolveInWorkspace(root, input)
  if (base.ok === false) return base

  if (typeof content !== 'string') {
    return { ok: false, code: REASON.BAD_INPUT, message: 'content 必须是字符串' }
  }
  if (content.length > MAX_WRITE_CHARS) {
    return {
      ok: false,
      code: WRITE_REASON.TOO_BIG,
      message: `内容过大（${content.length} 字符，上限 ${MAX_WRITE_CHARS}）`,
    }
  }

  /* 目标存在时：目录 / 符号链接都必须拒（见上面那两条理由） */
  try {
    const st = fs.lstatSync(base.abs)
    if (st.isDirectory()) {
      return { ok: false, code: WRITE_REASON.IS_DIRECTORY, message: '目标是一个目录，不能当文件写' }
    }
    if (st.isSymbolicLink()) {
      return { ok: false, code: REASON.SYMLINK, message: '目标是符号链接/联接 —— 写入会跟到别处，拒绝' }
    }
  } catch {
    /* 不存在 = 正常的新建路径，继续 */
  }

  /*
   * ★ 最后一道：写**父目录**必须真实存在且在写根内。
   * 不存在就直接拒（Harbor 的 write_file 会建父目录，但那是**工作区内**的
   * 约定；从外部入口进来时，多一层「父目录已存在且已确认在界内」更稳）。
   */
  const parent = path.dirname(base.abs)
  let realParent = ''
  try {
    realParent = fs.realpathSync(parent)
  } catch {
    return { ok: false, code: REASON.NOT_FOUND, message: '父目录不存在（本工具不建父目录）' }
  }
  if (!isInside(root, realParent)) {
    return { ok: false, code: REASON.SYMLINK, message: '父目录的真实路径落到写根之外（链接越界）' }
  }

  return { ok: true, abs: base.abs }
}

/* ══════════════════════════════════════════════════════════════
   harbor_env_diag：**固定的只读诊断项**（不接受任意命令）
   ══════════════════════════════════════════════════════════════ */

/** 允许的诊断项 id —— **唯一清单**（MCP 侧与宿主侧共用这一份） */
const DIAG_IDS = ['node', 'git', 'workdir', 'isolated', 'codex_home']

/** 每项的人话标签（给最终诊断报告用） */
const DIAG_LABELS = {
  node: 'Node.js 版本',
  git: 'Git 版本',
  workdir: 'Harbor 工作区路径',
  isolated: '隔离测试目录',
  codex_home: 'CODEX_HOME 配置',
}

/**
 * 诊断项 → **固定命令**。命令由宿主用常量拼出来，**外部只能指定 id，不能给命令**。
 *
 * @param {{ isoDir: string, codexHome: string }} env 宿主读到的环境事实
 * @returns {Record<string, string>}
 */
function diagCommands(env) {
  const iso = String(env?.isoDir ?? '')
  const home = String(env?.codexHome ?? '').trim()
  return {
    node: 'node -v',
    git: 'git --version',
    /* cmd 的 `cd` 不带参数就打印当前目录 —— 只读，且 cwd 由宿主设成工作区 */
    workdir: 'cd',
    isolated: `echo ${iso}`,
    codex_home: `echo ${home || '(未设置)'}`,
  }
}

/**
 * 净化外部给的 `checks`：只留**认识的 id**，去重保序；非法输入明确拒绝。
 * 不传 = 全部（默认全量诊断）。
 *
 * @param {unknown} input
 * @returns {{ ok: true, checks: string[] } | { ok: false, message: string }}
 */
function pickChecks(input) {
  if (input === undefined || input === null) return { ok: true, checks: [...DIAG_IDS] }
  if (!Array.isArray(input)) return { ok: false, message: 'checks 必须是字符串数组' }
  const out = []
  for (const item of input) {
    if (typeof item !== 'string' || !DIAG_IDS.includes(item)) {
      return {
        ok: false,
        message: `不认识的诊断项：${JSON.stringify(item)}（只允许：${DIAG_IDS.join(' / ')}）`,
      }
    }
    if (!out.includes(item)) out.push(item)
  }
  if (out.length === 0) return { ok: false, message: 'checks 不能是空数组' }
  return { ok: true, checks: out }
}

/**
 * Harbor 工具**执行结果**算不算失败 —— 判据的唯一一处（本桥专用）。
 *
 * ★ 这是 Harbor 的**既有契约**，不是我新造的：`tools/index.cjs` 的 `execute()`
 *   **恒返回字符串**，失败时以 `错误：` 或 `用户拒绝了` 开头（成功的工具不会这么开头）。
 *   同一个判据在别处也用过：`tools/index.cjs:255` · `loop-tools.cjs:25` ·
 *   `tool-runner.cjs:33`。
 *
 * ⚠️ 那 3 处是各自写的一份（重复实现）；本模块是第 4 份，本批不重构它们。
 *
 * @param {unknown} text
 */
function isToolFailure(text) {
  const s = String(text ?? '')
  return s.startsWith('错误：') || s.startsWith('用户拒绝了')
}

module.exports = {
  REASON, WRITE_REASON, isInside, resolveInWorkspace, resolveWriteRoot, resolveForWrite,
  MAX_WRITE_CHARS, isToolFailure, DIAG_IDS, DIAG_LABELS, diagCommands, pickChecks,
}

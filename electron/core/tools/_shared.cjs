/**
 * 工具公用：路径解析与文本工具
 *
 * 路径规则变了（以前是「绝对路径原样用」—— 等于没有边界）：
 * 一律先过 `capability.check`，只允许在工作目录里自由读写，
 * 出去要用户授权；敏感文件即便在目录里也要单独批。
 *
 * 拒绝时抛 `PermissionRequiredError`，让上层（tools/index.cjs）
 * 能识别出这是「需要授权」而不是「碰错了」，进而去问用户。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 需要用户授权才能访问（可被上层捕获并弹确认框） */
class PermissionRequiredError extends Error {
  constructor(target, reason, sensitive) {
    super(`需要授权才能访问：${target}\n${reason}`)
    this.name = 'PermissionRequiredError'
    this.code = 'PERMISSION_REQUIRED'
    this.target = target
    this.reason = reason
    this.sensitive = sensitive ?? ''
  }
}

/**
 * 把用户/模型给的路径变成绝对路径，并检查是否允许。
 *
 * @param {string} input
 * @param {string} workdir
 * @param {{ sessionId?: string }} [ctx]
 */
function resolvePath(input, workdir, ctx) {
  if (!input) throw new Error('缺少路径参数')

  const capability = require('../capability.cjs')
  const raw = String(input)

  /* 相对路径先按工作目录展开 —— 否则 capability 会拿 process.cwd() 去比，全都不在工作目录里 */
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(workdir || process.cwd(), raw)

  const decision = capability.check(absolute, {
    workdir,
    sessionId: ctx?.sessionId ?? ctx?.threadId ?? '',
  })

  if (!decision.ok) {
    throw new PermissionRequiredError(absolute, decision.reason, decision.sensitive)
  }

  /* 用 realpath 之后的结果继续操作 —— 防止「先过检查、后换软链接」那条路 */
  return decision.absolute
}

/**
 * 写文件**之前**留一份快照（改动事务）。
 *
 * 必须在真正写之前调 —— 事务的价值全在「拿到原始内容」这一步。
 * 写失败、事务没开、文件太大，都不应该让写入本身失败，
 * 所以这里吞掉异常，只记一条日志。
 *
 * @param {{ changeSetId?: string, log?: object }} ctx
 * @param {string} file 已解析过的绝对路径
 */
function snapshotBefore(ctx, file) {
  if (!ctx?.changeSetId) return
  try {
    require('../changeset.cjs').record(ctx.changeSetId, file)
  } catch (error) {
    ctx.log?.warn?.(`记文件快照失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 文件太大就别整个读进来 */
const MAX_READ_BYTES = 512 * 1024

function readTextFile(file, maxBytes = MAX_READ_BYTES) {
  const stat = fs.statSync(file)
  if (stat.isDirectory()) throw new Error(`${file} 是目录，不是文件`)
  if (stat.size > maxBytes) {
    throw new Error(
      `文件太大（${Math.round(stat.size / 1024)} KB），上限 ${Math.round(maxBytes / 1024)} KB`,
    )
  }
  return fs.readFileSync(file, 'utf8')
}

/** 给每行加上行号，方便模型定位 */
function withLineNumbers(text, startLine = 1) {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(4, ' ')}| ${line}`)
    .join('\n')
}

/** 统一换行符，避免 CRLF 把精确匹配搞崩 */
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n')
}

/** 把过长的输出截断，保留头尾 */
function truncateMiddle(text, maxChars = 12000) {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n\n…（中间省略 ${text.length - maxChars} 字符）…\n\n${text.slice(-tail)}`
}

module.exports = {
  PermissionRequiredError,
  resolvePath,
  snapshotBefore,
  readTextFile,
  withLineNumbers,
  normalizeNewlines,
  truncateMiddle,
  MAX_READ_BYTES,
}

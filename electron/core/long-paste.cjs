/**
 * 长消息落文件 —— 「贴一两万字，模型能真读到」的那一半（2026-10-04）
 *
 * 背景（真机实测）：对话层的预算是个有限的数（见 `context-builder.cjs` 的
 * `DEFAULT_CONTEXT_TOKENS`）。一条超长粘贴塞进提示词，超出的部分**模型根本看不到**，
 * 而它自己也不知道「后面还有」—— 实测里模型回答得很诚实：「我看到的内容末尾被截断了」。
 *
 * 做法：超过阈值的消息，完整原文写进**工作目录里**的一个文件（目录里的文件模型免授权
 * 就能 `read_file`），发给模型的是「原文开头 + 一行指路」：
 *
 *     [这条消息太长（20000 字符），完整内容已存为 <路径> —— 需要看全文、数行数、
 *      找某一段时，用 read_file 读它；上面只是开头部分]
 *
 * 三条规矩：
 *   ① **不静默**：落盘之后把路径交给渲染层（`chat.cjs` 发 `attachment` 事件），
 *      界面上留一行看得见的提示；
 *   ② **原文不动**：会话文件与气泡里一直是完整原文（消息只改「发出去的那一份」）；
 *   ③ **幂等**：文件名由「会话 + 内容哈希」决定 —— 同一条长消息在后续每一轮里
 *      都会再次经过这里（历史里它一直在），第 2 次起只复用，不重写。
 *
 * 刻意不 require('electron')，自检/单测能直接跑。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * 超过这么多字符就落文件。
 *
 * 取 8000 的理由：对话层额度现在是 14745 字符（`DEFAULT_CONTEXT_TOKENS × 3 × 30%`），
 * 阈值压在额度一半左右 —— 这样「开头 + 指路行」一定塞得进，还留得出位置给别的消息，
 * 而且这个数**用户能记住**（不像「额度减去已有消息」那种动态判据，说不清什么时候会变文件）。
 */
const THRESHOLD = 8000

/** 消息里保留的原文长度（够看清结构：标题、前几段、格式） */
const KEEP_HEAD = 4000

/** 单条消息落盘上限（防呆：别让一次粘贴把磁盘写满） */
const MAX_BYTES = 8 * 1024 * 1024

/** 附件目录（相对工作目录） */
const DIR_PARTS = ['.harbor', 'attachments']

function dirFor(workdir) {
  return path.join(String(workdir), ...DIR_PARTS)
}

/** 文件名：`<会话>-paste-<内容哈希前 8 位>.txt` —— 内容一样就是同一个文件（幂等） */
function nameFor(sessionId, text) {
  const safe = String(sessionId || 'nosess').replace(/[^a-zA-Z0-9_-]/g, '')
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8)
  return `${safe}-paste-${hash}.txt`
}

/** 发给模型的那段「指路」，和开头一起拼进消息 */
function hintFor(file, chars) {
  return (
    `\n\n[这条消息太长（共 ${chars} 字符），完整内容已存为 ${file} ——` +
    ` 需要看全文、数行数、找某一段时用 read_file 读它；上面只是开头部分]`
  )
}

/**
 * 处理一条消息：要不要落文件？落哪儿？发给模型的是什么？
 *
 * @param {{ text?: unknown, workdir?: string, sessionId?: string }} input
 * @returns {{ changed: boolean, reason: string, path?: string, created?: boolean,
 *             chars?: number, kept?: number, outgoing?: string, error?: string }}
 *   `changed: true` 时调用方要把消息内容换成 `outgoing`；
 *   `error` 有值时是「该落但没落成」（磁盘满 / 权限），调用方要提示用户。
 */
function offload(input = {}) {
  const text = input.text
  /* 多模态（带图）的消息不是纯文本，不动它 —— 图片那条路另有处理（见 context-builder.cjs） */
  if (typeof text !== 'string') return { changed: false, reason: 'not-text' }
  if (text.length <= THRESHOLD) return { changed: false, reason: 'short' }
  const workdir = String(input.workdir ?? '')
  if (!workdir) return { changed: false, reason: 'no-workdir' }

  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BYTES) {
    return {
      changed: false,
      reason: 'too-big',
      error: `这条消息 ${(bytes / 1048576).toFixed(1)}MB，超过落盘上限 ${MAX_BYTES / 1048576}MB`,
    }
  }

  const dir = dirFor(workdir)
  const file = path.join(dir, nameFor(input.sessionId, text))
  let created = false
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, text, 'utf8')
      created = true
    }
  } catch (error) {
    return {
      changed: false,
      reason: 'write-failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  return {
    changed: true,
    reason: 'offloaded',
    path: file,
    created,
    chars: text.length,
    kept: KEEP_HEAD,
    outgoing: text.slice(0, KEEP_HEAD) + hintFor(file, text.length),
  }
}

module.exports = { THRESHOLD, KEEP_HEAD, MAX_BYTES, offload }

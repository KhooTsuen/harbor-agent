/**
 * `harbor_edit_file` 的**判据层**（2026-10-17 第五阶段 · 安全局部编辑）
 *
 * ── 为什么单列一个文件 ────────────────────────────────────────
 *
 * `codex-mcp-policy.cjs` 已经 291 行（贴着 300 红线），而「局部编辑能不能做」
 * 这组判据自成一体：版本标识 + 三条拒绝条件。搬出来既腾行，也能被自检直接
 * 喂假数据跑（不必起整个桥、不必有隔离工作区）。
 *
 * ── ★ 三条拒绝（用户第 3 条：绝不能猜替换位置）──────────────────
 *
 *   ① **版本对不上** → `VERSION_CONFLICT`。Codex 编辑前先用 `harbor_read_file`
 *      拿到「文件版本」，编辑时回填 `expectHash`；这中间文件被别人改过就拒绝，
 *      **绝不把按旧内容算出来的结果贴到新文件上**。
 *   ② **0 次匹配** → `NO_MATCH`。原文根本不在文件里（模型记错了内容）。
 *   ③ **多次匹配** → `MULTIPLE_MATCH`。同一段原文出现两次以上 —— 猜位置就会改错地方。
 *
 * 路径 / 大小 / 目录 / 符号链接那几条**不在这里重写**：直接复用
 * `policy.resolveForWrite`（唯一一处，见 codex-mcp-policy.cjs）。
 *
 * ⚠️ 不 require electron（纯函数，可在纯 Node 里跑）。
 */

const fs = require('node:fs')
const path = require('node:path')
const policy = require('./codex-mcp-policy.cjs')

/**
 * 内容的版本标识（sha256 前 16 位）。
 * 用途只有一个：**并发冲突检测**。不是安全摘要，不必更长。
 *
 * @param {unknown} text
 * @returns {string}
 */
function hashOf(text) {
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 换行归一（与 `tools/edit_file.cjs` 同口径：CRLF → LF）。
 * 不做这一步的话，Windows 上的文件（CRLF）配 Codex 给的 LF 原文会**假失败**成 0 次匹配。
 *
 * @param {unknown} text
 * @returns {string}
 */
function lf(text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

/**
 * 局部编辑的**语义预检**。
 *
 * @param {string} root 已通过 `policy.resolveWriteRoot` 的写根（真实路径）
 * @param {unknown} input 外部传来的相对路径
 * @param {string} oldText 待匹配原文
 * @param {string} newText 替换内容
 * @param {string} expectHash 期望版本（`hashOf` 的结果）
 * @returns {{ ok: true, abs: string, hash: string } | { ok: false, code: string, message: string }}
 */
function resolveForEdit(root, input, oldText, newText, expectHash) {
  /* ① 路径边界 + 大小 + 目录 / 符号链接：全部复用写路径那套判据 */
  const target = policy.resolveForWrite(root, input, String(newText ?? ''))
  if (target.ok === false) return target

  if (typeof oldText !== 'string' || !oldText) {
    return { ok: false, code: policy.REASON.BAD_INPUT, message: 'oldText 必填（要被替换的原文）' }
  }

  const want = String(expectHash ?? '').trim()
  if (!want) {
    return {
      ok: false,
      code: policy.WRITE_REASON.NO_VERSION,
      message: 'expectHash 必填 —— 先用 harbor_read_file 读一次，把返回里「文件版本」那个值填进来',
    }
  }

  let before = ''
  try {
    before = fs.readFileSync(target.abs, 'utf8')
  } catch {
    return {
      ok: false,
      code: policy.REASON.NOT_FOUND,
      message: '目标文件不存在 —— 局部编辑**不新建**文件（新建请用 harbor_write_file）',
    }
  }

  /* ② 版本冲突 */
  const current = hashOf(before)
  if (want !== current) {
    return {
      ok: false,
      code: policy.WRITE_REASON.VERSION_CONFLICT,
      message: `文件版本已变（期望 ${want}，实际 ${current}）—— 请重新读文件后再试，本次不写入`,
    }
  }

  /* ③ 唯一匹配（0 次 / 多次都拒，绝不猜位置） */
  const hay = lf(before)
  const needle = lf(oldText)
  const first = hay.indexOf(needle)
  if (first === -1) {
    return {
      ok: false,
      code: policy.WRITE_REASON.NO_MATCH,
      message: '在文件里找不到 oldText（0 次匹配）—— 请先 harbor_read_file 核对原文与缩进',
    }
  }
  if (hay.indexOf(needle, first + needle.length) !== -1) {
    return {
      ok: false,
      code: policy.WRITE_REASON.MULTIPLE_MATCH,
      message: 'oldText 在文件里出现多次 —— 请带上前后文让它唯一（拒绝猜位置）',
    }
  }

  return { ok: true, abs: target.abs, hash: current }
}

/**
 * 把「已经校验过的绝对路径」归一成写根内的相对路径。
 *
 * 为什么要它：`resolveForEdit` 走的是**外部入口**那套判据（拒绝绝对路径是收紧边界用的）。
 * 而复核阶段的路径来自 `runEditTool` 内部的 `before.abs` —— 本来就是合法的绝对路径。
 * 不归一的话，复核会拿 `ABSOLUTE_PATH` 把**已经批准的编辑**判成拒绝
 * （2026-10-17 本地复现：卡点了允许、文件没改）。
 *
 * @param {string} root 写根
 * @param {unknown} p
 * @returns {string} 落在根内 → 相对路径；落在根外 → **原样返回**（让下游照常拒）
 */
function toWorkspaceRelative(root, p) {
  const t = String(p ?? '')
  if (!t || !path.isAbsolute(t)) return t
  const rel = path.relative(root, t)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return t
  return rel
}

/**
 * 审批**通过之后**的复核（用户第 4 条：审批期间不许变）。
 *
 * 为什么整段重跑而不是只比哈希：卡挂着的时候可能发生三件事 —— 文件被别的回合改
 * （哈希变）、写根被指向别处（边界变）、写入被关掉（权限变）。只比哈希会漏后两件。
 *
 * @param {{ writeEnabled?: boolean, mcpEnabled?: boolean, writeRoot?: string }} live 此刻的开关
 * @param {string} isoDir 隔离数据根
 * @param {{ path?: unknown, oldText?: unknown, newText?: unknown, expectHash?: unknown }} args
 * @returns {{ ok: boolean, code?: string }}
 */
function recheckEdit(live, isoDir, args) {
  if (live?.mcpEnabled !== true || live?.writeEnabled !== true) return { ok: false, code: 'WRITE_DISABLED' }
  const root = policy.resolveWriteRoot(String(live?.writeRoot ?? ''), isoDir)
  if (root.ok === false) return { ok: false, code: root.code }
  const rel = toWorkspaceRelative(root.abs, args?.path)
  const again = resolveForEdit(root.abs, rel, String(args?.oldText ?? ''), String(args?.newText ?? ''), String(args?.expectHash ?? ''))
  return again.ok === true ? { ok: true } : { ok: false, code: again.code }
}

/**
 * 读一个文件的当前版本（读不到 → 空串）。
 * 空串会让 `resolveForEdit` 因缺 expectHash 拒绝 —— 这正是想要的（没有版本就别改）。
 *
 * @param {string} file
 * @returns {string}
 */
function versionOf(file) {
  try {
    return hashOf(fs.readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
}

module.exports = { hashOf, lf, versionOf, resolveForEdit, recheckEdit }

/**
 * 「这次写会改成什么」—— 给确认弹窗的预览（AG-036 Diff First）
 *
 * 文档要求「必须让用户明确看到修改内容」，而确认框原来只有一行摘要
 * （`写文件 x（1291 字节）`）—— 看不出会改成什么样，点「允许」等于闭眼签。
 *
 * 两件事在这里做：
 *   · `write_file`：拿**当前文件内容**和新内容比（文件不存在就是全新文件）
 *   · `edit_file`：把 oldText→newText **贴回文件里的位置**再比 —— 这样行号
 *     是真的行号，上下文也是真上下文（只比片段的话，界面上的行号会骗人）
 *
 * 读盘只为看一眼，所以有大小上限：超了就不预览，说明一句就完。
 */

const fs = require('node:fs')
const path = require('node:path')
const { diffFile } = require('./diff-text.cjs')

/** 超过这个大小不读盘预览（读它只是为了让人看一眼） */
const MAX_BYTES = 1024 * 1024

function absolute(workdir, target) {
  const text = String(target ?? '')
  if (!text) return ''
  return path.isAbsolute(text) ? text : path.join(String(workdir ?? ''), text)
}

/** 读得动就读；读不动（不存在 / 太大）不抛，把原因带回去 */
function readForPreview(file) {
  try {
    const stat = fs.statSync(file)
    if (stat.size > MAX_BYTES) return { tooBig: true, size: stat.size }
    return { content: fs.readFileSync(file, 'utf8') }
  } catch {
    /* 不存在 = 要新建 —— 这不是错误 */
    return { missing: true }
  }
}

/**
 * @param {{ tool: string, args?: object, workdir?: string }} input
 * @returns {{ diff: object[], note: string }} `diff` 恒为**数组**（渲染层按数组收：
 *   写文件就是一项，算不出来就是空数组）—— 单文件也要和别处一个形状。
 */
function preview({ tool, args = {}, workdir = '' } = {}) {
  const target = args.path ?? args.file
  if (!target) return { diff: [], note: '' }

  const file = absolute(workdir, target)
  const read = readForPreview(file)

  if (read.tooBig) {
    return { diff: [], note: `文件约 ${Math.round(read.size / 1024)} KB，太大就不预览了` }
  }

  const before = read.missing ? '' : read.content

  if (tool === 'write_file') {
    const diff = diffFile({ path: file, before, after: String(args.content ?? '') })
    return { diff: [diff], note: read.missing ? '这是新文件（原来不存在）' : '' }
  }

  if (tool === 'edit_file') {
    const oldText = String(args.oldText ?? '')
    const newText = String(args.newText ?? '')

    /*
     * 定位不到那段原文，本身就是**重要信息**：要么文件已经被人改过，
     * 要么模型记错了内容。这时候退回「片段预览」并直说，不要装成整篇 diff。
     */
    const at = oldText ? before.indexOf(oldText) : -1
    if (oldText && at === -1) {
      return {
        diff: [diffFile({ path: file, before: oldText, after: newText })],
        note: '原文件里没找到它要改的这段（可能已经改过）—— 下面是它打算改成什么',
      }
    }

    const after =
      at === -1 ? before : before.slice(0, at) + newText + before.slice(at + oldText.length)
    return { diff: [diffFile({ path: file, before, after })], note: '' }
  }

  return { diff: [], note: '' }
}

module.exports = { preview, MAX_BYTES }

/**
 * 附件解析 —— 把用户选的文件，变成「模型读得懂的东西」（2026-10-08）
 *
 * 在这之前附件只会读**文本**文件（`handlers/fs.cjs` 的 `fs:pickAndRead`，
 * `buffer.includes(0)` 一撞上二进制就拒）—— PDF / Word / Excel / PPT /
 * 压缩包 / exe 全进不来。这里按扩展名分流：
 *
 *   text     代码 / 纯文本   → 原文（扩展名表复用 `handlers/fs-text-ext.cjs`，不另立一份）
 *   image    图片           → data URL（交给现有的图片预览条，模型当多模态看）
 *   pdf      PDF            → `file-extract-docs.cjs` 用 pdfjs-dist 抽文本
 *   docx     Word           → 同上，mammoth
 *   xlsx     Excel          → 同上，SheetJS
 *   pptx     PPT            → 同上，自解 zip 抽文字
 *   archive  zip/rar/7z…    → 只列条目名（内容太杂，抽不出有意义的正文）
 *   binary   exe/dll/音视频 → **不读内容**，只登记「有这个文件」，界面照实说
 *
 * 三条规矩（第 3 条是这次特意加的）：
 *   ① **解析库一律懒加载**：它们是纯 JS，但主进程跑的是 CJS —— 真用到才 import，
 *      装不上也只是「这一类用不了」，**不会连累整个 handler 注册**
 *      （`ipc-channels.cjs` 的 `EXPECTED_CHANNELS` 防的就是「注册段中间抛错、
 *       后面全静默不注册」）。
 *   ② **不静默截断**：抽出来的正文超过 `MAX_TEXT` 就截断，并在返回值里带
 *      `truncated: true` —— 界面据实说一句，别让用户以为拿到了全文。
 *   ③ **二进制不假装能读**：`kind: 'binary'` 的 `text` 是空的，别拿
 *      「文件名」冒充内容。
 *
 * 刻意不 require('electron')（只碰 fs / path），自检和单测能直接跑。
 */
const fs = require('node:fs')
const path = require('node:path')
const { isTextFile } = require('../handlers/fs-text-ext.cjs')
const docs = require('./file-extract-docs.cjs')

/** 单文件大小上限（字节）。0 / 缺省 = 不限制（那些本来就不读内容） */
const MAX_BYTES = {
  image: 10 * 1024 * 1024,
  text: 4 * 1024 * 1024,
  pdf: 40 * 1024 * 1024,
  docx: 20 * 1024 * 1024,
  xlsx: 20 * 1024 * 1024,
  pptx: 20 * 1024 * 1024,
}

/**
 * 抽出来的正文上限（字符）。
 * 100000 ≈ 2.5 万 token，比对话层预算大得多 —— 超出部分本来也塞不进提示词，
 * 由 `core/long-paste.cjs` 落盘、模型按需 read_file 读全文（那条路已经在了）。
 */
const MAX_TEXT = 100000

/** 压缩包最多列这么多条目名（再多用户也看不完，界面会标「还有 N 个」） */
const MAX_ENTRIES = 500

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const DOC_KIND = { '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.xls': 'xlsx', '.pptx': 'pptx' }
const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'])

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

/** 扩展名 → 类别。**判定看扩展名，不去读内容猜**（理由同 fs-text-ext.cjs 的文件头） */
function kindOf(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (DOC_KIND[ext]) return DOC_KIND[ext]
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (isTextFile(name)) return 'text'
  return 'binary'
}

/** 类别 → 用户看得懂的称呼（界面和错误提示共用一处） */
const KIND_LABEL = {
  text: '文本',
  image: '图片',
  pdf: 'PDF',
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  pptx: 'PPT 演示',
  archive: '压缩包',
  binary: '二进制文件',
}

/** 把正文收进上限里；超了就切并标记（规矩②） */
function clamp(text) {
  if (text.length <= MAX_TEXT) return { text }
  return { text: text.slice(0, MAX_TEXT), truncated: true }
}

function readText(file) {
  const buffer = fs.readFileSync(file)
  if (buffer.includes(0)) {
    /* 扩展名说是文本、内容却是二进制 —— 照实说，别把乱码塞给模型 */
    return { text: '', note: '扩展名像是文本，内容却是二进制，没读' }
  }
  return clamp(buffer.toString('utf8'))
}

function readImage(file, ext) {
  const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.replace('.', '')}`
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

/** 压缩包：只列条目名。zip 能列，rar/7z 纯 JS 解不了 —— 照实说 */
function listArchive(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext !== '.zip') {
    return { entries: [], entryCount: 0, note: `${ext} 暂时只能登记大小，列不了里面的清单` }
  }
  const AdmZip = require('adm-zip')
  const all = new AdmZip(file).getEntries().map((e) => e.entryName)
  return {
    entries: all.slice(0, MAX_ENTRIES),
    entryCount: all.length,
    truncated: all.length > MAX_ENTRIES,
  }
}

/**
 * 解析一个文件。
 * @param {string} filePath 绝对路径（用户从系统选择框里显式选的，不限工作目录）
 * @returns {Promise<object>} 形状见各分支；`ok:false` 时带 `error`
 */
async function extract(filePath) {
  const name = path.basename(String(filePath))
  const ext = path.extname(name).toLowerCase()
  const kind = kindOf(name)

  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (error) {
    return { ok: false, name, ext, kind, error: error instanceof Error ? error.message : String(error) }
  }
  if (!stat.isFile()) return { ok: false, name, ext, kind, error: '这不是一个文件' }

  const base = { ok: true, name, path: filePath, size: stat.size, ext, kind, label: KIND_LABEL[kind] }
  const limit = MAX_BYTES[kind] ?? 0
  if (limit && stat.size > limit) {
    return { ...base, ok: false, error: `${KIND_LABEL[kind]}太大（${mb(stat.size)}），最多 ${mb(limit)}` }
  }

  try {
    if (kind === 'text') return { ...base, ...readText(filePath) }
    if (kind === 'image') return { ...base, dataUrl: readImage(filePath, ext) }
    if (kind === 'archive') return { ...base, ...listArchive(filePath) }
    /* 二进制不读内容 —— 只留路径、大小、扩展名（规矩③） */
    if (kind === 'binary') return base
    return { ...base, ...(await docs.extract(filePath, kind, MAX_TEXT)) }
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

module.exports = { extract, kindOf, KIND_LABEL, MAX_TEXT, MAX_BYTES, MAX_ENTRIES }

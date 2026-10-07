/**
 * 文档类附件抽取：PDF / Word / Excel / PPT（2026-10-08）
 *
 * 从 `file-extract.cjs` 拆出来的 —— 那边只管「分到哪一类」，这里管
 * 「真去把字节变成字」。四个库都是**纯 JS**（无原生 ABI，不影响打包平台）：
 *
 *   PDF   pdfjs-dist（Mozilla 官方，零依赖）—— 注意走 legacy build，
 *         主入口是 ESM，主进程是 CJS，只能 `await import()`（懒加载，见下）
 *   Word  mammoth
 *   Excel SheetJS（xlsx）
 *   PPT   没有顺手的纯 JS 库 → 自己用 adm-zip 解包，抽 `<a:t>` 里的文字
 *
 * ★ **懒加载 + 缓存**：`require` / `import` 都放在**函数里**、第一次真用到才执行。
 *   这样即便某个库没装上（或将来版本升挂了），也只是「这一类抽不了」，
 *   不影响另外三类、更不会在**注册 handler 时**就把整段注册搞崩。
 *
 * ★ **边抽边掐**：每加一段就比一次 `limit`，超了立刻停手 —— 不去把
 *   一个 300 页 PDF 全抽完再截断（那要几百毫秒到几秒，界面会觉得卡）。
 *
 * 不 require('electron')，自检能直接跑。
 */
const fs = require('node:fs')
const path = require('node:path')

let _pdf
async function pdfjsLib() {
  if (!_pdf) _pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return _pdf
}

/** XML 文本节点里的实体还原（pptx 的 <a:t> 会带这些） */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

async function fromPdf(file, limit) {
  const pdfjs = await pdfjsLib()
  const data = new Uint8Array(fs.readFileSync(file))
  /*
   * useWorkerFetch / isEvalSupported 关掉：主进程里跑不需要 worker 与动态求值，
   * 开着会多走一条路、在打包后更容易踩到路径问题。
   */
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise
  const pages = doc.numPages
  let out = ''
  let truncated = false
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const line = content.items.map((it) => it.str ?? '').join(' ').replace(/[ \t]+/g, ' ')
    out += `\n\n[第 ${i} 页]\n${line.trim()}`
    page.cleanup?.()
    if (out.length > limit) {
      truncated = true
      out = out.slice(0, limit)
      break
    }
  }
  try {
    await doc.destroy()
  } catch {
    /* destroy 失败不影响已经抽到的文本 */
  }
  return { text: out.trim(), pages, truncated }
}

async function fromDocx(file, limit) {
  const mammoth = require('mammoth')
  const result = await mammoth.extractRawText({ path: file })
  const text = String(result.value ?? '')
  if (text.length > limit) return { text: text.slice(0, limit), truncated: true }
  return { text }
}

function fromXlsx(file, limit) {
  const XLSX = require('xlsx')
  const wb = XLSX.readFile(file)
  let out = ''
  for (const name of wb.SheetNames) {
    out += `\n\n[工作表：${name}]\n`
    out += XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false })
    if (out.length > limit) {
      return { text: out.slice(0, limit), sheets: wb.SheetNames.length, truncated: true }
    }
  }
  return { text: out.trim(), sheets: wb.SheetNames.length }
}

const slideNo = (name) => Number((name.match(/slide(\d+)\.xml$/) ?? [])[1] ?? 0)

function fromPptx(file, limit) {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(file)
  const slides = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => slideNo(a.entryName) - slideNo(b.entryName))
  let out = ''
  for (const entry of slides) {
    const xml = zip.readAsText(entry.entryName)
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]).trim())
    out += `\n\n[第 ${slideNo(entry.entryName)} 张]\n${texts.filter(Boolean).join('\n')}`
    if (out.length > limit) {
      return { text: out.slice(0, limit), slides: slides.length, truncated: true }
    }
  }
  return { text: out.trim(), slides: slides.length }
}

/**
 * 把一份文档抽成正文。
 * @param {string} file 绝对路径
 * @param {'pdf'|'docx'|'xlsx'|'pptx'} kind
 * @param {number} limit 正文上限（字符），来自 file-extract.cjs 的 MAX_TEXT
 */
async function extract(file, kind, limit) {
  if (kind === 'pdf') return fromPdf(file, limit)
  if (kind === 'docx') return fromDocx(file, limit)
  if (kind === 'xlsx') return fromXlsx(file, limit)
  if (kind === 'pptx') return fromPptx(file, limit)
  throw new Error(`不认识的文档类型：${kind}`)
}

module.exports = { extract }

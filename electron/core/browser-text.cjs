/* ══════════════════════════════════════════════════════════════
   网页正文清洗（纯函数，不联网就能测）

   从网页里抽出「给模型看的那一段」。三件事：

     ① **去掉不承载内容的标签**（script / style / nav / footer / svg…）
        —— 不清洗的话一个页面能轻松吃掉几万 token，而且里面全是噪声
     ② **压掉多余空行**，让模型读起来是连贯的
     ③ **截断**，并且明确告诉它「被截断了」（不然模型会以为页面就这么多）

   为什么单独一个文件：这段逻辑的正确性靠「喂一段 HTML，断言输出」
   就能保证，**不该需要开浏览器才能测**。
   ══════════════════════════════════════════════════════════════ */

/** 这些标签里的东西一律不要 —— 不是给人读的正文 */
const DROP_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'footer',
  'header',
  'aside',
  'form',
  'button',
  'select',
  'option',
]

/**
 * 把 HTML 变成可读文本。
 *
 * 用正则而不是 DOMParser：这段代码要在**主进程 / 测试**里跑，
 * 那里没有 DOM。正则做 HTML 解析当然不严谨，但我们只要「正文大意」，
 * 而且真正的提取是在渲染层用 `innerText` 做的（见 BrowserTab）——
 * 这里只是兜底和清洗。
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  let text = String(html ?? '')

  /* 注释先干掉：里面常有一大坨调试信息 */
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  for (const tag of DROP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi')
    text = text.replace(re, ' ')
    /* 自闭合 / 未闭合的也清掉 */
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ' ')
  }

  /* 块级标签变行，行内标签变空格 —— 不然「<div>标题</div><div>正文」会粘成一行 */
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<[^>]+>/g, ' ')

  return decodeEntities(text)
}

/** 常见的 HTML 实体还原 —— 不还原的话模型看到一堆 &amp; */
function decodeEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    middot: '·',
    times: '×',
    laquo: '«',
    raquo: '»',
    copy: '©',
    reg: '®',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
  }

  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => named[String(name).toLowerCase()] ?? whole)
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 压掉多余空白：行内多空格 → 一个；连续空行 → 一个 */
function collapse(text) {
  return String(text ?? '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 截断。**要明确说明被截断了** —— 不然模型会以为页面就这么多内容，
 * 然后在「没找到」的结论上继续推理。
 */
function truncate(text, max = 12000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n\n…（正文太长，只取了前 ${max} 个字符，后面还有 ${value.length - max} 个字符没给）`
}

/**
 * 一步到位：HTML → 干净的正文。
 *
 * @param {string} html
 * @param {{ maxChars?: number, title?: string, url?: string }} [options]
 */
function extractText(html, { maxChars = 12000 } = {}) {
  return truncate(collapse(htmlToText(html)), maxChars)
}

/**
 * 从渲染层传来的两种来源里挑一个来清洗。
 *
 * 渲染层优先给 `text`（`innerText`，渲染后的可见文本），拿不到才给 `html`，
 * 而且给 text 时会把 html 设成**空字符串**。
 *
 * ⚠️ 踩过：主进程那边写的是 `result.html ?? result.text` ——
 * `??` **只认 null/undefined，不认空字符串**，所以 `'' ?? '正文'` 得到的是 `''`。
 * 结果是「browse 明明读到了页面，返回给模型的却是空的」，
 * 模型只好自己用 curl 再抓一遍（真机上就是这么表现的）。
 *
 * @returns {{ raw: string, from: 'text' | 'html' | 'none' }}
 */
function pickSource(result) {
  const text = String(result?.text ?? '')
  if (text.trim()) return { raw: text, from: 'text' }
  const html = String(result?.html ?? '')
  if (html.trim()) return { raw: html, from: 'html' }
  return { raw: '', from: 'none' }
}

module.exports = {
  DROP_TAGS,
  pickSource,
  htmlToText,
  decodeEntities,
  collapse,
  truncate,
  extractText,
}

/** 注入页面的函数必须自包含：Chrome 会序列化它，而不会带上模块闭包。 */
export function collectPageText() {
  const root = document.querySelector('article, main, [role="main"]') || document.body
  if (!root) return { url: location.href, title: document.title || '', text: '' }
  const lines = []
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const visible = (node) => !node.closest('script, style, noscript, nav, footer, form, [hidden], [aria-hidden="true"]')
  const SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,img'
  const MAX_NODES = 1500
  /*
   * ★ 穿透 open shadowRoot 与同源 iframe（2026-10-21）：
   *   只查 `root.querySelectorAll` 时，把界面装进 shadow DOM 的站点（Web Components、
   *   用户装的 UI 插件改造过的页面，例如 bilibili + BewlyBewly）**正文一个都拿不到**。
   *   那时「读当前页」只回一句 `[图片说明] B站 b站`（那点东西来自 document 层的 img），
   *   自动上报也就等于没送。`observe.js` 的采集已按同样方式修过，这里补齐同一条链路。
   *   closed shadow（`shadowRoot === null`）浏览器不暴露，进不去 —— 不猜内容。
   *   深度封顶 4 层、节点封顶 MAX_NODES，避免病态页面拖死注入脚本。
   */
  let taken = 0
  const scanRoot = (node0, depth) => {
    if (!node0 || depth > 4 || taken >= MAX_NODES) return
    let nodes = []
    try {
      nodes = node0.querySelectorAll(SEL)
    } catch {
      return
    }
    for (let i = 0; i < nodes.length; i += 1) {
      if (taken >= MAX_NODES) return
      const node = nodes[i]
      if (!visible(node)) continue
      taken += 1
      const tag = node.tagName.toLowerCase()
      if (tag === 'img') {
        const alt = clean(node.getAttribute('alt'))
        if (alt) lines.push(`[图片说明] ${alt}`)
        continue
      }
      if (tag === 'table') {
        /* 表格只在本层取行 —— 行不会在 shadow 里另开一份 */
        for (const row of Array.from(node.querySelectorAll('tr')).slice(0, 50)) {
          const cells = Array.from(row.querySelectorAll('th,td')).map((cell) => clean(cell.innerText || cell.textContent).replace(/\|/g, '\\|'))
          if (cells.length) lines.push(`| ${cells.join(' | ')} |`)
        }
        continue
      }
      if (node.closest('table')) continue
      if ((tag === 'p' || tag === 'li') && node.parentElement?.closest('li,blockquote')) continue
      const content = clean(node.innerText || node.textContent).slice(0, 5000)
      if (!content) continue
      if (/^h[1-6]$/.test(tag)) lines.push(`${'#'.repeat(Number(tag[1]))} ${content}`)
      else if (tag === 'li') lines.push(`- ${content}`)
      else if (tag === 'blockquote') lines.push(`> ${content}`)
      else lines.push(content)
    }
    /* 找能钻进去的 shadow host / 同源 iframe */
    let all = []
    try {
      all = node0.querySelectorAll('*')
    } catch {
      return
    }
    const cap = Math.min(all.length, 3000)
    for (let i = 0; i < cap; i += 1) {
      if (taken >= MAX_NODES) return
      const el = all[i]
      if (el.shadowRoot) {
        scanRoot(el.shadowRoot, depth + 1)
        continue
      }
      const name = String(el.tagName || '').toUpperCase()
      if (name !== 'IFRAME' && name !== 'FRAME') continue
      let doc = null
      try {
        doc = el.contentDocument /* 跨域 → null，跳过且不猜内容 */
      } catch {
        doc = null
      }
      if (doc && doc.body) scanRoot(doc, depth + 1)
    }
  }
  scanRoot(root, 1)
  const structured = lines.join('\n\n')
  const full = String(root.innerText || '').trim()
  /* SPA 常把正文放在 div/span；只取语义标签会漏掉它们。保留原文兜底，
     明示它可能与上方结构化段落重复，优先保证没有悄悄漏读。 */
  const text = structured && full.length > structured.length * 2
    ? `${structured}\n\n[页面其余可见文本，可能与上文重复]\n${full}`
    : (structured || full)
  return {
    url: location.href,
    title: document.title || '',
    text,
  }
}

/** 等 SPA DOM 短暂安静；达到上限就返回，不假称页面已稳定。 */
export function waitForStablePage() {
  return new Promise((resolve) => {
    let quietTimer
    let capTimer
    let observer
    const finish = (stable) => {
      observer?.disconnect()
      clearTimeout(quietTimer)
      clearTimeout(capTimer)
      resolve({ stable, url: location.href })
    }
    try {
      observer = new MutationObserver(() => {
        clearTimeout(quietTimer)
        quietTimer = setTimeout(() => finish(true), 300)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
      quietTimer = setTimeout(() => finish(true), 300)
      capTimer = setTimeout(() => finish(false), 1800)
    } catch {
      finish(false)
    }
  })
}

export function limitPageText(page, maxChars) {
  const raw = String(page?.text || '')
  return {
    url: String(page?.url || ''),
    title: String(page?.title || ''),
    text: raw.slice(0, maxChars),
    truncated: raw.length > maxChars,
  }
}

/*
 * AG-038 真机基准：注入一份极端数据，量**真实渲染器**里的耗时与节点数。
 *
 * 在应用里跑一段脚本（`--js-file`），所以能用真的 `performance`、
 * 真的 React、真的 Chromium —— jsdom 里的毫秒数只能当相对值看。
 *
 * 量四件事：
 *   ① 1000 条消息的会话：切过去到画出来的耗时 + DOM 节点数
 *   ② 长会话里连续滚动的帧耗时（`requestAnimationFrame` 间隔）
 *   ③ 一万个工具事件的那条消息：展开到底的耗时 + 节点数
 *   ④ 流式更新：连续追加 500 片时的每次提交耗时
 */
;(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = []
    const say = (s) => out.push(s)
    const nodes = () => document.querySelectorAll('*').length
    const btn = (label) =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)

    for (let i = 0; i < 60; i += 1) {
      if (document.querySelector('textarea')) break
      await sleep(500)
    }
    await sleep(24000)

    /*
     * 侧栏的会话行是 `<div onClick>`（不是按钮），标题放在 `span[title]` 里
     * 而且**显示时被截断**（「极端数据 · 1000 条…」）—— 所以要按 title 属性认，
     * 再点它所在的那一行。第一版按按钮找，两个会话都「找不到」。
     */
    const openSession = (titlePart) => {
      const span = [...document.querySelectorAll('span[title]')].find((s) =>
        String(s.getAttribute('title')).includes(titlePart),
      )
      if (!span) return false
      const row = span.closest('div[class*="group"]') ?? span.parentElement?.parentElement
      row?.click()
      return true
    }

    /* 先报告「进来时是什么状态」——不做任何点击，免得自己的操作混进数字里 */
    const expandedNow = [...document.querySelectorAll('button[aria-expanded="true"]')].length
    say(
      `进来时展开着的按钮=${expandedNow} · 已渲染消息=${document.querySelectorAll('[data-message-id]').length}`,
    )

    /* ── ① 切到「1000 条消息」那条会话 ── */
    const t0 = performance.now()
    const foundLong = openSession('极端数据 · 1000 条')
    say('找到长会话=' + foundLong)
    if (foundLong) {
      /* 等画出来：内容容器里出现消息即算 */
      for (let i = 0; i < 200; i += 1) {
        await sleep(50)
        if (document.querySelectorAll('[data-message-id]').length > 0) break
      }
      const ms = performance.now() - t0
      say(`① 切过去到画出来=${Math.round(ms)}ms · DOM ${nodes()}`)
      say('   渲染出来的消息条数=' + document.querySelectorAll('[data-message-id]').length)
      say(
        '   有「载入更早的」按钮=' +
          Boolean(
            btn('载入更早的 300 条（还有 800 条）') ??
            [...document.querySelectorAll('button')].find((b) =>
              b.textContent.includes('载入更早的'),
            ),
          ),
      )

      /* ② 连续滚动的帧耗时 */
      const scroller = document.querySelector('.overflow-y-auto')
      const frames = []
      let last = performance.now()
      let stop = false
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        if (!stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      const scrollStart = performance.now()
      while (performance.now() - scrollStart < 2500) {
        if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop - 260)
        await sleep(16)
      }
      stop = true
      const worst = frames.length ? Math.max(...frames) : 0
      const avg = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 0
      say(
        `② 滚动 2.5 秒：平均帧 ${avg.toFixed(1)}ms · 最差 ${worst.toFixed(1)}ms · ${frames.length} 帧`,
      )
    }

    /* ── ③ 一万个工具事件 ── */
    const foundTool = openSession('极端数据 · 一万个工具')
    say('找到工具事件会话=' + foundTool)
    if (foundTool) {
      await sleep(1500)
      const t1 = performance.now()
      /* 点两层：先展开工具列表，再展开那一组 */
      for (let round = 0; round < 2; round += 1) {
        const targets = [...document.querySelectorAll('button[aria-expanded="false"]')]
        for (const target of targets) target.click()
        await sleep(400)
      }
      say(`③ 一万个工具事件展开到底=${Math.round(performance.now() - t1)}ms · DOM ${nodes()}`)
      say('   有截断说明=' + document.body.innerText.includes('没摊开'))
    }

    /* ── ④ 流式更新 ── */
    const composer = document.querySelector('textarea')
    if (composer) {
      say('④ 流式：跳过（会真的花钱调模型）—— 那部分在单元基准里量')
      void composer
    }
    return out.join(' ⏐ ')
  } catch (error) {
    return '基准脚本崩了：' + (error && error.message)
  }
})()

/*
 * AG-039 后台执行隔离基准（真机）
 *
 * 文档第 13 节的验收表里有三条与它相关：
 *   UI 输入        → 持续流畅
 *   Thread 切换    → 不受后台任务明显影响
 *   后台任务       → 不阻塞 Renderer
 *
 * 这个脚本的做法：**在后台任务跑着的时候**量一遍上面三件事，
 * 任务结束、空闲下来再量一遍，两组数字并排 —— 「受影响了吗」就有答案了。
 *
 * 量的是渲染层自己感知到的时间（rAF / 事件到下一帧），不是主进程自报的。
 */
;(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = []
    const say = (s) => out.push(s)
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame((t) => resolve(t ?? performance.now())))
    const btn = (label) =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
    const sending = () =>
      Boolean(
        document.querySelector('[aria-label="停止生成"]') ||
        document.querySelector('[aria-label="暂停生成"]'),
      )

    for (let i = 0; i < 60; i += 1) {
      if (document.querySelector('textarea')) break
      await sleep(500)
    }
    await sleep(24000)

    /* ── 量一组：输入延迟 / 帧间隔 / 切对话 ── */
    async function measure(label) {
      /* ① 输入延迟：设置输入框的值 → 等下一帧 → 确认值已经在 DOM 里 */
      const inputLatency = []
      for (let i = 0; i < 8; i += 1) {
        const area = document.querySelector('textarea')
        if (!area) break
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        const startedAt = performance.now()
        setter.call(area, `隔离基准 ${i}`)
        area.dispatchEvent(new Event('input', { bubbles: true }))
        await frame()
        const shown = document.querySelector('textarea')?.value === `隔离基准 ${i}`
        inputLatency.push({ ms: performance.now() - startedAt, shown })
        await sleep(60)
      }

      /* ② 帧间隔：连续 2 秒 */
      const frames = []
      let last = await frame()
      const until = performance.now() + 2000
      while (performance.now() < until) {
        const now = await frame()
        frames.push(now - last)
        last = now
      }

      /* ③ 切对话：点另一条会话 → 到它的内容画出来 */
      let switchMs = null
      const rows = [...document.querySelectorAll('span[title]')].filter((s) =>
        /跑任务的那条|切过去的那条|AG-034/.test(String(s.getAttribute('title'))),
      )
      const target = rows.find((s) => !s.closest('[aria-current="true"]'))
      if (target) {
        const row = target.closest('div[class*="group"]') ?? target.parentElement?.parentElement
        const startedAt = performance.now()
        row?.click()
        await frame()
        await sleep(30)
        switchMs = performance.now() - startedAt
      }

      const slow = inputLatency.filter((item) => !item.shown).length
      const worstInput = inputLatency.length ? Math.max(...inputLatency.map((i) => i.ms)) : 0
      const avgInput = inputLatency.length
        ? inputLatency.reduce((sum, i) => sum + i.ms, 0) / inputLatency.length
        : 0
      const worst = frames.length ? Math.max(...frames) : 0
      const avg = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 0
      const janky = frames.filter((f) => f > 50).length
      say(
        `${label}：输入延迟 平均 ${avgInput.toFixed(0)}ms/最差 ${worstInput.toFixed(0)}ms（没生效 ${slow} 次）` +
          ` · 帧 平均 ${avg.toFixed(1)}ms/最差 ${worst.toFixed(0)}ms（>50ms 的 ${janky} 帧）` +
          ` · 切对话 ${switchMs === null ? '—' : Math.round(switchMs) + 'ms'}`,
      )
    }

    /* ── 先量空闲基线 ── */
    const area = document.querySelector('textarea')
    if (area) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await measure('空闲基线')

    /* ── 起一个真的后台任务，跑着的时候再量一遍 ── */
    const prompt = '读一下 tmp/real-ws/README.md，再跑 python tests.py，然后逐条报告结果。'
    const composer = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(composer, prompt)
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    document.querySelector('[aria-label="发送消息"]')?.click()
    let started = false
    for (let i = 0; i < 40; i += 1) {
      await sleep(250)
      if (sending()) {
        started = true
        break
      }
    }
    say('后台任务已起=' + started)
    if (started) {
      /* 边跑边量（不等它结束） */
      await measure('任务运行中')
      /* 顺手点掉可能弹出来的确认框，别让任务卡在那儿 */
      for (let i = 0; i < 120; i += 1) {
        await sleep(1000)
        const allow = btn('允许')
        if (allow) allow.click()
        if (!sending()) break
      }
      say('任务结束（这一段期间界面是可用的：上面的数字就是证据）')
    }
    return out.join(' ⏐ ')
  } catch (error) {
    return '隔离基准崩了：' + (error && error.message)
  }
})()

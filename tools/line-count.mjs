/**
 * 行数口径 —— **唯一真相源**
 *
 * 为什么单列一个模块：行数被两个地方用到 ——
 *   · `tools/line-limit.mjs`：守 `AGENT.md` 硬约束 2（单文件 ≤ 300 行）
 *   · `scripts/project-map.mjs`：画项目地图（各目录 / 各扩展名的体量）
 * 两处各写一套 `split('\n')` 迟早会漂 —— 本项目「同一件事写两份」翻过车
 * （`scripts/check-rules/checks.mjs` 里已经为 SCAN / CODE_EXTS 各留过一份松散副本）。
 * 所以口径只在这里定义，两边都 import 这一份。
 *
 * 两条踩过的坑（原先写在 `line-limit.mjs` 里，搬过来免得再踩）：
 *   · **末尾换行不算一行** —— 不然一个正好 300 行的文件会被数成 301
 *     （真踩过，那一轮扫描报了 51 个「超标」，其中一大批其实是刚好合规）。
 *   · `--code-only` 是**近似**（不解析字符串里的 `//`），但服务于一条更重要的原则：
 *     解释「为什么」的注释不该被行数惩罚（`AGENT.md` 说「踩过的坑写进去是最值钱的」）。
 */

/** 项目认的代码扩展名：行数红线、地图的「代码」口径都只看这些 */
export const CODE_EXTS = new Set(['.ts', '.tsx', '.cjs', '.mjs'])

/** 总行数：**末尾换行不算一行** */
export function countLines(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** 只留代码行：去掉行注释、块注释、纯注释行（近似，不解析字符串里的 `//`） */
export function countCodeLines(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    /* 去掉块注释（可能跨行） */
    for (;;) {
      const start = line.indexOf('/*')
      if (start < 0) break
      const end = line.indexOf('*/', start + 2)
      if (end < 0) {
        line = line.slice(0, start)
        inBlock = true
        break
      }
      line = line.slice(0, start) + line.slice(end + 2)
    }
    /* 去掉行注释（粗略：不区分是否在字符串里） */
    const slash = line.indexOf('//')
    if (slash >= 0) line = line.slice(0, slash)
    if (line.trim()) out.push(line)
  }
  return out.length
}

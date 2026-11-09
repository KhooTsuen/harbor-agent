import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   过程折叠区的**插入位置**

   ── 病（2026-11-09 真机看到）────────────────────────────────────
   一条「正文 → 工具 → 结论」的消息，界面上是：
     `1 个步骤`（折叠区） → 第一段正文 → 结论
   而真实执行顺序是「第一段正文 → 工具 → 结论」。重启回放时尤其刺眼：
   用户记得先看到那段话，重开却倒在工具入口下面。

   ── 为什么用源码断言而不是渲染快照 ──────────────────────────────
   这套渲染依赖 Markdown / 平滑文本 / 折叠状态，快照会锁死大量无关细节，
   改一处样式就红。这里钉的是**结构契约**：折叠区必须按 `insertAt` 插入，
   不许再回到「恒排最前」或「恒排最后」。
   ══════════════════════════════════════════════════════════════ */

const SRC = readFileSync(
  join(process.cwd(), 'src/components/chat/message/MessageRounds.tsx'),
  'utf8',
)
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('显示顺序 / ⑥ 折叠区按真实位置插入', () => {
  it('★★★ 算出插入点：第一个「过程项」的下标', () => {
    const body = strip(SRC)
    expect(body).toContain('const insertAt = items.findIndex(isProcessItem)')
  })

  it('★★★ 折叠区只渲染一次（重复挂载 = 同一段过程出现两遍）', () => {
    const body = strip(SRC)
    const panels = body.split('<ProcessPanel').length - 1
    expect(panels, 'ProcessPanel 必须恰好出现一次（提取成常量 processPanel）').toBe(1)
    /*
     * 它被**使用**两次：兜底分支（`insertAt < 0` 时放最前）+ flatMap 里的插入点。
     * 按变量名数，不按 `{processPanel}` 数 —— 兜底那处是三元表达式里的裸引用。
     */
    const uses = body.split('processPanel').length - 1
    /* 定义 1 次 + 使用 2 次 = 3 */
    expect(uses, 'processPanel 要在「无过程项兜底」和「插入点」各用一次').toBe(3)
  })

  it('★★★ 插入位置跟着 items 走，不是恒排最前 / 最后', () => {
    const body = strip(SRC)
    expect(body).toContain('if (index === insertAt) parts.push(processPanel)')
    /* 老写法（折叠区在前、正文整批在后）必须彻底消失 */
    expect(body).not.toMatch(/\{items\.map\(bodyOf\)\}/)
  })

  it('★★ 一轮都还没结束时兜底放最前（那时 insertAt 是 -1）', () => {
    const body = strip(SRC)
    expect(body).toContain('{insertAt < 0 ? processPanel : null}')
  })

  it('★★ 正文仍然排除「过程话」那一轮（降噪口径没被这次改动松开）', () => {
    const body = strip(SRC)
    expect(body).toContain('if (isProcessSpeech(rounds, item.index)) return null')
  })

  it('★★ 出错 / 中断仍然默认展开（这条从来没松过）', () => {
    const body = strip(SRC)
    expect(body).toContain('defaultOpen={abnormal}')
    expect(body).toContain('message?.interrupted === true')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MessageRound } from '@/types'
import { reconcileFinalRounds } from '../finalRounds'

/* ══════════════════════════════════════════════════════════════
   收尾全文该写到哪里：「整段显示两遍」的病根 + 不许丢协作汇报

   2026-10-21 用户报：同一条回答从头到尾显示了两遍。
   排查（磁盘 / collapseByKey / 渲染组件 / 思考正文交叉全查过）结论：
   病根在 `done` 分支 —— 汇总全文与逐轮流式正文**差一个字符**时，
   它把全文当「新的一轮」push 进去，界面上就多出一整份。

   但 `streamEventsRounds.test.ts` 有一条必须保住的判据：双模型协作时
   「规划与执行过程」和「最终协作汇报」是**两段不同的话**，都得显示。
   所以这里同时钉两侧：像的要合并，不像的要保留。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const streamSrc = readFileSync(join(ROOT, 'src/stores/thread/streamEvents.ts'), 'utf8')

function round(content: string, reasoning = '', tools: number[] = []): MessageRound {
  return { reasoning, content, tools }
}

const tight = (s: string) => s.replace(/\s+/g, '')
const joined = (rounds: MessageRound[]) => rounds.map((r) => r.content).join('')
const times = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('不许把回答整段排两遍', () => {
  it('★★ 用户报的那一幕：只差一个末尾换行，轮次数也不许涨', () => {
    const rounds = [round('第一段'), round('第二段'), round('第三段')]
    const final = '第一段第二段第三段\n' /* 就是这一点差异曾经造成整段重复 */
    const out = reconcileFinalRounds(rounds, final)
    expect(out.length, '多出来的那一轮就是用户看到的第二遍').toBe(3)
    expect(tight(joined(out))).toBe(tight(final))
  })

  it('★★ 只差内部空格 / 换行（上游重排版）→ 也算同一份', () => {
    const rounds = [round('A 段'), round('B 段')]
    const out = reconcileFinalRounds(rounds, 'A段B段')
    expect(out.length).toBe(2)
  })

  it('★ 完全一致 → 原样返回（连对象都不重建）', () => {
    const rounds = [round('甲', '想'), round('乙')]
    expect(reconcileFinalRounds(rounds, '甲乙')).toEqual(rounds)
  })

  it('★ 空全文（done 没带 content）→ 一个字段都不动', () => {
    const rounds = [round('已经写好的')]
    expect(reconcileFinalRounds(rounds, '')).toEqual(rounds)
  })

  it('★ 不改入参（store 里那份是正在渲染的草稿）', () => {
    const rounds = [round('原文')]
    const before = JSON.stringify(rounds)
    reconcileFinalRounds(rounds, '完全不同的一段')
    expect(JSON.stringify(rounds)).toBe(before)
  })

  /*
   * ★★ 2026-10-21 用户第三次报同一件事（原话：「这不是流式消失，就是工作过程
   *   不是完了吗，那不得发个总结吗？就那处会有重复」）。
   *
   *   前两次修的是「整段重来」：拼接与全文只差几个字符（覆盖度 ≥ 90%）。
   *   而这次是**总结里复述了刚显示完的那一段**：过程有多轮、final = 末轮正文 +
   *   新总结 —— 前缀被「过程开头的另一段」挡掉、后缀被「新总结的结尾」挡掉，
   *   覆盖度算出来是 0，于是整份 final 又被 push 成一轮，那段就显示两遍。
   */
  it('★★ 收尾总结复述了刚显示完的那段 → 那段只许出现一次', () => {
    const shown = '三处规则都改完了，测试全绿，构建产物已重建。'
    const rounds = [round('先读一遍相关源码。', '想一下', [0]), round(shown, '再确认一遍', [1, 2])]
    const final = `${shown}\n\n## 总结\n这次只动了一条判定规则：复述过的部分不再重复显示。`
    const out = reconcileFinalRounds(rounds, final)
    expect(times(joined(out), shown), '同一段话在时间线上出现了两遍').toBe(1)
    /* 真正新增的总结必须留着（用户要的就是这份总结） */
    expect(joined(out)).toContain('这次只动了一条判定规则')
    /* 过程里的思考与工具一条都不许丢 */
    expect(out[0].reasoning).toBe('想一下')
    expect(out[0].tools).toEqual([0])
    expect(out[1].reasoning).toBe('再确认一遍')
    expect(out[1].tools).toEqual([1, 2])
  })

  it('★★ 总结把整场过程逐行重排了一遍 → 一个字都不用再加', () => {
    const a = '第一处：把判据换成覆盖度，避免中途一处差异就判成另一段话。'
    const b = '第二处：补上落盘顺序，别让磁盘上留下没对齐的那份。'
    const out = reconcileFinalRounds([round(a), round(b)], `${b}\n\n${a}`)
    expect(out.length, '重排过的复述不该再占一轮').toBe(2)
    expect(tight(joined(out))).toBe(tight(a + b))
  })

  /*
   * ★★ 同一件事的另一种形状 —— **只有一条正文轮**（2026-10-21 真机抓到的）：
   *
   *   轮0 = 「这一轮的改动只碰了一条判定规则，其余一字未动。」
   *   final = 那段 + 「## 收尾总结」+ 【同一段再来一遍】+ 结尾一句
   *
   * 这时「拼接 vs final」覆盖度是 100%（final 就是它的超集），走的是第 5 条。
   * 以前第 5 条拿「前面各轮的正文」当锚点 —— 一条轮时那个锚点是空串，
   * `text.startsWith('')` 恒真，于是整份 final 盖进那一轮，复述照样留在中间。
   * 真机实测：keyTimes=2、rounds=1（没有多出一轮，是一轮内部重复）。
   */
  it('★★ 只有一条正文轮 + 总结复述 → 复述只留一处', () => {
    const shown = '这一轮的改动只碰了一条判定规则，其余一字未动。'
    const final = `${shown}\n## 收尾总结\n${shown}\n以上是本轮的最终结论`
    const out = reconcileFinalRounds([round(shown, '想了一下', [0])], final)
    expect(times(joined(out), shown), '同一段在一条轮内部又排了一遍').toBe(1)
    expect(joined(out)).toContain('以上是本轮的最终结论')
    expect(out[0].reasoning, '思考不许丢').toBe('想了一下')
    expect(out[0].tools, '工具不许丢').toEqual([0])
  })

  /*
   * ★★ 真机抓到的第三种形状（2026-10-21，`--dev` 实例 + 真模型）：
   *   模型在**同一轮流式里**先给结论、又在总结里原样复述 —— 数据里只有一条轮，
   *   且 `content` 与该轮逐字相同。以前第 2 条直接原样返回，屏幕上就是两遍。
   */
  it('★★ 轮内容与 final 逐字相同、但里面自己复述了一遍 → 折成一次', () => {
    const shown = '这一轮的改动只碰了一条判定规则，其余一字未动。'
    const same = `${shown}\n\n## 收尾总结\n${shown}\n以上是本轮的最终结论`
    const out = reconcileFinalRounds([round(same, '想了一下', [0, 1])], same)
    expect(times(joined(out), shown), '数据里自己就写了两遍').toBe(1)
    expect(joined(out)).toContain('以上是本轮的最终结论')
    expect(out[0].reasoning).toBe('想了一下')
    expect(out[0].tools).toEqual([0, 1])
  })

  it('★ 代码块里的重复行一个字都不许动（代码要完整）', () => {
    const block = '```js\nconst a = 1\nconst a = 1\n```'
    const out = reconcileFinalRounds([round('说明如下。\n' + block)], '说明如下。\n' + block)
    expect(joined(out)).toContain('const a = 1\nconst a = 1')
  })

  /*
   * ★★ 第四种形状（2026-10-21 真机 `--dev` 抓到，假上游复现）：
   *   上游流到一半报可重试的错（限流 / 超时）→ `callModel` 重新请求**整段**，
   *   渲染层把新分片往后追加 → 同一轮里变成「半截 + 整段重说」。
   *
   *   真机读回：`r0` = 「这一轮的改动只碰了一条判定规则，这一轮的改动只碰了一条
   *   判定规则，其余一字未动。」—— 前半截排了两遍（`retry` 事件在主窗口只提示、
   *   不回滚，侧栏那条已经修了）。
   */
  it('★★ 重试前半截 + 重试后整段重说 → 那句只许出现一次', () => {
    const shown = '这一轮的改动只碰了一条判定规则，其余一字未动。'
    const final = `${shown}\n\n## 收尾总结\n这次只动了一条判定规则：复述过的部分不再重复显示。`
    /* 半截正好停在「其余」之前，重试后从同一句开头整段重说 */
    const out = reconcileFinalRounds([round(shown.slice(0, 16) + shown)], final)
    expect(times(joined(out), '这一轮的改动只碰了一条判定规则'), '半截被重说了一遍').toBe(1)
    expect(joined(out)).toContain('复述过的部分不再重复显示')
  })

  it('★ 重试后半截 + 重发的那份与 final 排版不同（空白差异）→ 仍只留一份', () => {
    const half = '先读一遍相关源码，再动手改这一处判定规则。'
    const full = '先读一遍相关源码，再动手改这一处判定规则。\n\n改完跑了一遍单测。'
    const out = reconcileFinalRounds([round(half + '\n' + full)], full)
    expect(times(joined(out), '先读一遍相关源码'), '半截被重说了一遍').toBe(1)
    expect(joined(out)).toContain('改完跑了一遍单测')
  })

  it('★ 没有 final 可锚（done 没带 content）也要折掉重说的半截', () => {
    const shown = '这一轮的改动只碰了一条判定规则，其余一字未动。'
    const out = reconcileFinalRounds([round(shown.slice(0, 16) + shown)], '')
    expect(times(out[0].content, '这一轮的改动只碰了一条判定规则')).toBe(1)
  })

  it('★ 代码块开头那段重复时不许切（代码要完整）', () => {
    const block = '```js\nconst a = 1\nconst a = 1\nconst b = 2\n```'
    const out = reconcileFinalRounds([round(block)], '')
    expect(joined(out)).toContain('const a = 1\nconst a = 1\nconst b = 2')
  })

  it('★ 短标题（< 16 字）重复不触发折叠（结构不能被吞）', () => {
    const text = '## 总结\n## 总结\n正文一句。'
    const out = reconcileFinalRounds([round(text)], '')
    expect(joined(out)).toContain('## 总结\n## 总结')
  })
})

describe('但要保住协作汇报（两段不同的话都得在）', () => {
  it('★★ 过程 + 最终汇报（毫无重合）→ 必须新增一轮', () => {
    const out = reconcileFinalRounds([round('规划与执行过程')], '最终协作汇报')
    expect(out.map((r) => r.content)).toEqual(['规划与执行过程', '最终协作汇报'])
  })

  it('★ 最后一轮已经就是汇报 → 不重复追加', () => {
    const rounds = [round('过程'), round('最终正文')]
    expect(reconcileFinalRounds(rounds, '最终正文').length).toBe(2)
  })
})

describe('汇总比流式更长 / 只有思考时怎么落', () => {
  it('★ 同一份但更长（上游补了尾巴）→ 补在最后那条正文轮上', () => {
    const out = reconcileFinalRounds([round('前文'), round('结论')], '前文结论（补充一句）')
    expect(out.length).toBe(2)
    expect(out[0].content).toBe('前文')
    expect(out[1].content).toBe('结论（补充一句）')
  })

  it('★ 已有的更全（上游给了短的）→ 别用短的盖掉', () => {
    const rounds = [round('前文'), round('结论（补充一句）')]
    const out = reconcileFinalRounds(rounds, '前文结论')
    expect(out).toEqual(rounds)
  })

  it('★ 只有思考 / 工具、没有正文轮 → 填进最后一轮，不新建', () => {
    const out = reconcileFinalRounds([round('', '想了很久', [0, 1])], '终于说出来的答案')
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('终于说出来的答案')
    expect(out[0].reasoning).toBe('想了很久')
    expect(out[0].tools).toEqual([0, 1])
  })

  it('★ 一轮都没有 → 才允许建一轮', () => {
    const out = reconcileFinalRounds([], '只有收尾才到的一段话')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('只有收尾才到的一段话')
  })

  it('★ 前面几轮正好是全文前缀 → 不许把说过的话再念一遍', () => {
    const out = reconcileFinalRounds([round('甲乙'), round('丙')], '甲乙丙')
    expect(out.length).toBe(2)
    expect(out[0].content).toBe('甲乙')
    expect(out[1].content).toBe('丙')
    expect(joined(out)).toBe('甲乙丙')
  })
})

describe('接线：那一行 push 真的没了（层与层之间单元测试照不到）', () => {
  const block = streamSrc.slice(
    streamSrc.indexOf("case 'done':"),
    streamSrc.indexOf("case 'aborted':"),
  )

  it('★ `case done` 里不再无条件 push 全文', () => {
    expect(block).not.toContain("state.rounds.push({ reasoning: '', content: finalContent")
  })

  it('★ 改走 finalRounds（规则与单测都在那儿）', () => {
    expect(block).toContain('reconcileFinalRounds(state.rounds, finalContent)')
  })

  it('★ 收尾仍排在写字段之前（2026-10-04 事故的底线）', () => {
    expect(block.indexOf('done.finish')).toBeLessThan(block.indexOf('done.patch'))
  })
})

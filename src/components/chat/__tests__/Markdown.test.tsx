import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/chat/Markdown'

/* ══════════════════════════════════════════════════════════════
   Markdown 渲染（真渲染，不是解析）

   markdown.test.ts 验的是「解析出的结构对不对」，
   这里验的是「结构变成的 HTML 对不对」—— 两层都可能出错，
   比如解析对了但渲染层忘了处理 table 类型。

   用 renderToStaticMarkup 而不是浏览器渲染：够用且不用起环境。
   ══════════════════════════════════════════════════════════════ */

const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown 渲染', () => {
  it('粗体变成 strong，且不残留星号', () => {
    const out = html('这是**重点**')
    expect(out).toContain('<strong')
    expect(out).not.toContain('**')
  })

  it('行内代码变成 code', () => {
    expect(html('用 `npm test` 跑')).toContain('<code')
  })

  it('链接带 target=_blank（由主进程转交系统浏览器）', () => {
    const out = html('[文档](https://example.com)')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('target="_blank"')
  })

  it('表格渲染成 table/th/td，并对齐', () => {
    const out = html('| 名 | 值 |\n|:---|---:|\n| a | 1 |')
    expect(out).toContain('<table')
    expect(out).toContain('<th')
    expect(out).toContain('<td')
    expect(out).toContain('text-align:right')
    expect(out).not.toContain('|:---')
  })

  it('任务列表有勾选态，且不显示 [x] 原文', () => {
    const out = html('- [x] 做了\n- [ ] 没做')
    expect(out).toContain('做了')
    expect(out).not.toContain('[x]')
    expect(out).not.toContain('[ ]')
  })

  it('嵌套列表真的嵌在父项里面', () => {
    const out = html('- 外层\n  - 内层')
    /* 内层的 <ul> 应该出现在外层 <li> 之后、</li> 之前 */
    const outerLi = out.indexOf('<li')
    const innerUl = out.indexOf('<ul', outerLi + 1)
    const close = out.indexOf('</li>', outerLi)
    expect(innerUl).toBeGreaterThan(outerLi)
    expect(innerUl).toBeLessThan(close)
  })

  it('引用变成 blockquote，里面还能有列表', () => {
    const out = html('> 提示\n>\n> - 甲')
    expect(out).toContain('<blockquote')
    expect(out).toContain('<li')
  })

  it('代码块用 CodeBlock 渲染，显示语言名和文件名', () => {
    const out = html('```ts title="a.ts"\nconst a = 1\n```')
    expect(out).toContain('TypeScript')
    expect(out).toContain('a.ts')
    expect(out).toContain('<pre')
    /* 关键字被染上了色 */
    expect(out).toContain('--accent-purple')
  })

  it('代码块里的 Markdown 记号不被解析', () => {
    const out = html('```\n**不是粗体**\n```')
    expect(out).not.toContain('<strong')
  })

  it('长代码块折叠时给出展开入口', () => {
    const code = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = html('```ts\n' + code + '\n```')
    expect(out).toContain('展开其余')
    expect(out).not.toContain('line 60')
  })

  it('标题渲染成加粗文字', () => {
    expect(html('## 二级标题')).toContain('font-semibold')
  })

  it('分隔线渲染成 hr', () => {
    expect(html('---')).toContain('<hr')
  })

  it('纯文本走短路分支，原样保留换行', () => {
    const out = html('第一行\n第二行')
    expect(out).toContain('whitespace-pre-wrap')
    expect(out).toContain('第一行\n第二行')
  })

  it('危险链接不会被渲染成可点链接', () => {
    expect(html('[点我](javascript:alert(1))')).not.toContain('href="javascript:')
  })

  it('流式中的半截内容不抛异常', () => {
    for (const text of ['**没闭合', '```ts\nconst a = 1', '| a | b |\n|---', '- [x] 未完成']) {
      expect(() => html(text)).not.toThrow()
    }
  })
})

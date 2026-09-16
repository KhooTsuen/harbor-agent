import { describe, expect, it } from 'vitest'
import type { BlockNode, InlineNode } from '@/lib/markdown'
import { hasMarkdown, parseBlocks, parseInline, plainText } from '@/lib/markdown'

/* ══════════════════════════════════════════════════════════════
   Markdown 解析

   重点不是「语法多全」，而是三件事：
     · 符号能认出来（别把 ** 直接摆给用户看）
     · 顺序不出错（** 不能被 * 抢走、图片不能被链接规则吃掉开头）
     · 流式输出的「半个 Markdown」不能崩
   ══════════════════════════════════════════════════════════════ */

/**
 * 把行内节点压成一行简写，方便断言。
 *
 * 必须**递归**展开 children —— 早先这里用 plainText 拍平过，
 * 结果 `**粗*斜*粗**` 看起来像没解析出嵌套，其实是断言写错了。
 */
function shape(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text
        case 'code':
          return `\`${node.text}\``
        case 'br':
          return '↵'
        case 'image':
          return `img(${node.alt})`
        case 'link':
          return `a(${node.href},${shape(node.children)})`
        default:
          return `${node.type}(${shape(node.children)})`
      }
    })
    .join('')
}

function blockTypes(blocks: BlockNode[]): string[] {
  return blocks.map((block) => block.type)
}

describe('parseInline', () => {
  it('粗体', () => {
    expect(shape(parseInline('这是**重点**词'))).toBe('这是bold(重点)词')
  })

  it('两个星号不会被一个星号抢走', () => {
    expect(shape(parseInline('**粗**'))).toBe('bold(粗)')
  })

  it('斜体 / 下划线粗体 / 删除线', () => {
    expect(shape(parseInline('*斜*'))).toBe('italic(斜)')
    expect(shape(parseInline('__粗__'))).toBe('bold(粗)')
    expect(shape(parseInline('~~删~~'))).toBe('strike(删)')
  })

  it('粗体里可以嵌斜体', () => {
    expect(shape(parseInline('**粗*斜*粗**'))).toBe('bold(粗italic(斜)粗)')
  })

  it('行内代码里的星号不解析', () => {
    expect(shape(parseInline('用 `a**b**c` 试试'))).toBe('用 `a**b**c` 试试')
  })

  it('链接', () => {
    expect(shape(parseInline('[文档](https://example.com)'))).toBe('a(https://example.com,文档)')
  })

  it('裸 URL 自动变链接', () => {
    expect(shape(parseInline('见 https://example.com/x 一节'))).toBe(
      '见 a(https://example.com/x,https://example.com/x) 一节',
    )
  })

  it('危险协议当普通文字', () => {
    expect(shape(parseInline('[点我](javascript:alert(1))'))).toBe('[点我](javascript:alert(1))')
  })

  it('图片不会被链接规则吃掉开头的叹号', () => {
    expect(shape(parseInline('![图](https://a.com/b.png)'))).toBe('img(图)')
  })

  it('★ file:// 本地图片也能渲染（生图结果要靠它显示在对话里）', () => {
    expect(shape(parseInline('![图](file:///E:/work/generated/image-1.png)'))).toBe('img(图)')
  })

  it('反斜杠转义', () => {
    expect(shape(parseInline('\\*不是斜体\\*'))).toBe('*不是斜体*')
  })

  it('行尾两个空格是硬换行', () => {
    expect(shape(parseInline('上  \n下'))).toBe('上↵下')
  })

  it('只有标记没有内容时不吞字符', () => {
    expect(shape(parseInline('*'))).toBe('*')
  })

  it('空串返回空数组', () => {
    expect(parseInline('')).toEqual([])
  })
})

describe('parseBlocks', () => {
  it('代码块 + 语言', () => {
    const blocks = parseBlocks('```ts\nconst a = 1\n```')
    expect(blocks[0]).toMatchObject({ type: 'code', language: 'ts', code: 'const a = 1' })
  })

  it('代码块元信息：文件名 + 强调行', () => {
    const blocks = parseBlocks('```ts title="a.ts" {1,3-4}\nx\ny\nz\nw\n```')
    expect(blocks[0]).toMatchObject({
      type: 'code',
      language: 'ts',
      filename: 'a.ts',
      highlightLines: [1, 3, 4],
    })
  })

  it('流式中没闭合的代码块照样渲染', () => {
    const blocks = parseBlocks('说明：\n```ts\nconst a = 1')
    expect(blockTypes(blocks)).toEqual(['paragraph', 'code'])
  })

  it('标题', () => {
    const blocks = parseBlocks('## 二级')
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 })
  })

  it('无序列表', () => {
    const blocks = parseBlocks('- 一\n- 二\n- 三')
    expect(blocks[0].type).toBe('list')
    if (blocks[0].type === 'list') {
      expect(blocks[0].ordered).toBe(false)
      expect(blocks[0].items).toHaveLength(3)
      expect(plainText(blocks[0].items[1].children)).toBe('二')
    }
  })

  it('有序列表带起始号', () => {
    const blocks = parseBlocks('3. 三\n4. 四')
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true, start: 3 })
  })

  it('嵌套列表进 blocks 而不是被拍平', () => {
    const blocks = parseBlocks('- 外层\n  - 内层一\n  - 内层二\n- 第二个')
    expect(blocks[0].type).toBe('list')
    if (blocks[0].type === 'list') {
      expect(blocks[0].items).toHaveLength(2)
      const inner = blocks[0].items[0].blocks
      expect(inner[0]?.type).toBe('list')
      if (inner[0]?.type === 'list') expect(inner[0].items).toHaveLength(2)
    }
  })

  it('任务列表勾选态', () => {
    const blocks = parseBlocks('- [x] 做了\n- [ ] 没做')
    if (blocks[0].type !== 'list') throw new Error('不是列表')
    expect(blocks[0].items[0].checked).toBe(true)
    expect(blocks[0].items[1].checked).toBe(false)
    expect(plainText(blocks[0].items[0].children)).toBe('做了')
  })

  it('引用里能放列表和代码块', () => {
    const blocks = parseBlocks('> 提示\n>\n> - 甲\n> - 乙')
    expect(blocks[0].type).toBe('quote')
    if (blocks[0].type === 'quote') {
      expect(blockTypes(blocks[0].blocks)).toContain('list')
    }
  })

  it('表格：表头 / 对齐 / 数据行', () => {
    const blocks = parseBlocks('| 名 | 值 |\n|:---|---:|\n| a | 1 |\n| b | 2 |')
    expect(blocks[0].type).toBe('table')
    if (blocks[0].type === 'table') {
      expect(blocks[0].align).toEqual(['left', 'right'])
      expect(blocks[0].header).toHaveLength(2)
      expect(blocks[0].rows).toHaveLength(2)
      expect(plainText(blocks[0].rows[0][0])).toBe('a')
    }
  })

  it('表格单元格里的转义竖线不切分', () => {
    const blocks = parseBlocks('| a\\|b | c |\n|---|---|\n| 1 | 2 |')
    if (blocks[0].type !== 'table') throw new Error('不是表格')
    expect(plainText(blocks[0].header[0])).toBe('a|b')
  })

  it('分隔线不会被当成列表项', () => {
    expect(blockTypes(parseBlocks('---'))).toEqual(['hr'])
  })

  it('多段之间有空行', () => {
    expect(blockTypes(parseBlocks('第一段\n\n第二段'))).toEqual(['paragraph', 'paragraph'])
  })

  it('空输入不产出块', () => {
    expect(parseBlocks('')).toEqual([])
    expect(parseBlocks('   \n\n  ')).toEqual([])
  })

  it('喂一堆奇怪的输入不崩', () => {
    const weird = ['```', '>', '-', '***', '#', '|a|b|', '****', '|', '- [', '> > >', '~~~']
    for (const input of weird) expect(() => parseBlocks(input)).not.toThrow()
  })

  it('深层嵌套引用不无限递归', () => {
    expect(() => parseBlocks('> '.repeat(60) + '底')).not.toThrow()
  })
})

describe('hasMarkdown', () => {
  it('认得出各种记号', () => {
    for (const input of [
      '这是**粗**',
      '```\nx\n```',
      '- 一',
      '| a | b |',
      '![图](a.png)',
      '# 标题',
    ]) {
      expect(hasMarkdown(input)).toBe(true)
    }
  })

  it('普通文本返回 false（省一次解析）', () => {
    expect(hasMarkdown('就是一句话，没有任何记号')).toBe(false)
  })
})

describe('plainText', () => {
  it('把嵌套结构摊平成文字', () => {
    expect(plainText(parseInline('**粗**和*斜*和`码`'))).toBe('粗和斜和码')
  })
})

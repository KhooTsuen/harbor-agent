/* ══════════════════════════════════════════════════════════════
   Markdown：类型

   支持范围（对齐 GFM 常用部分，刻意不做脚注/定义列表/数学公式）：
     块：段落 / 标题 / 代码块 / 列表（嵌套+任务）/ 引用（可嵌套）/ 表格 / 分隔线
     行内：粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 图片 / 硬换行 / 反斜杠转义

   嵌套关系直接体现在类型里（children 是 InlineNode[]、blocks 是 BlockNode[]），
   渲染时递归即可，不需要在渲染层再判断一次。
   ══════════════════════════════════════════════════════════════ */

export type Align = 'left' | 'center' | 'right' | null

export interface ListItem {
  /** 该项第一段的行内内容 */
  children: InlineNode[]
  /** 缩进进来的子块（嵌套列表、代码块、续段） */
  blocks: BlockNode[]
  /** 任务列表的勾选态；不是任务列表就是 undefined */
  checked?: boolean
}

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'strike'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'br' }

export type BlockNode =
  | {
      type: 'code'
      language: string
      code: string
      /** ```ts title="a.ts" 里的文件名 */
      filename?: string
      /** ```ts {1,3-5} 里要强调的行号（1 起） */
      highlightLines: number[]
    }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  /** 引用里能放任何块，包括列表和代码块 */
  | { type: 'quote'; blocks: BlockNode[] }
  | { type: 'table'; align: Align[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'hr' }

import { memo, useMemo, useRef, type ReactNode } from 'react'
import { parseBlocks } from '@/lib/markdown'
import { EMPTY_CACHE, parseIncremental, type StableCache } from '@/lib/markdown/incremental'
import { Block, BlockList, CachedBlocks, TailBlock } from './markdown/Blocks'

/* ══════════════════════════════════════════════════════════════
   Markdown 渲染

   块怎么变成元素在 `markdown/Blocks`，这里只管**流式下的解析策略**。

   ── AG-021：流式时只解析尾巴 ──

   以前每次拿到新文本就把**全文**重解析（实测 20000 字的回复在一次流式里
   要在主线程累计花掉 2.7 秒）。现在只重解析「还在长的尾块」，
   前面写完的块直接复用：20000 字 2607ms → 32ms。

   ── AG-022：稳定块缓存成 React 元素 ──

   光「不重复解析」还不够 —— 每次渲染仍然要**为每个块创建元素对象**，
   实测那才是大头（5000 字流式 4.06ms/次，其中尾巴本身只要 0.16ms）。

   所以这里缓存的是**元素本身**（`elements`），而且用 `push` 追加，
   引用永不变。React 碰到 `oldElement === newElement` 会直接 bailout，
   连子节点都不过。

   走过的弯路（都实测过、都没用，记在这免得下次再试）：
     · 把稳定块放进 memo 子组件 → props 是数组，新增块就要造新数组，
       引用一变整棵子树全重渲染（实测 48% 的更新会碰到）；
     · 再按「批次」分组 → 批次数（198）比块数（131）还多，更慢；
     · 把 map 挪进 memo 组件内部 → 引用一变照样要遍历。
   根本问题是：**只要每次都要创建元素对象，这笔钱就省不掉**。

   实测：4.06 → 1.66 ms/次（2.4×）。
   ══════════════════════════════════════════════════════════════ */

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string
  /**
   * 这条消息是不是**还在写**。
   *
   * 只有还在写的时候才把尾巴里那半行当纯文本（见 `TailBlock`）。写完了
   * 必须按完整文档解析 —— 否则 `这是**重点**` 这种没换行收尾的内容会丢掉
   * 所有格式（真实踩过，被已有的 Markdown 渲染测试当场拦住）。
   */
  streaming?: boolean
}) {
  /*
   * 用 ref 缓存增量状态 + 元素，而不是 useMemo：这些是**跨渲染**的东西
   * （已扫描到哪、已渲染过哪些元素），必须真的存住，不能靠 useMemo 的
   * 缓存策略（它允许丢弃重算）。
   *
   * 写在 render 里是安全的：只在 `text` 变了才动，而且同一个 `text`
   * 重复调用完全幂等（StrictMode 的双调用也走这个路径）。
   */
  const cache = useRef<{
    text: string
    /** 增量状态（含扫描位置、围栏状态）—— 下次解析要用 */
    stable: StableCache
    /** 已经渲染过的 React 元素，只增不改 */
    elements: ReactNode[]
    tailText: string
  } | null>(null)

  if (!cache.current) {
    cache.current = { text: '\u0000', stable: EMPTY_CACHE, elements: [], tailText: '' }
  }

  /*
   * ★ 写完了的消息走**另一条路**：整篇一次解析。
   *
   * 不能把「拆出最后一行」那套用在写完的消息上 —— 那个拆分对表格是错的：
   * 表格的行不需要空行分隔，`| a | 1 |` 离开表头就不是表格了（真实被
   * 已有的 Markdown 渲染测试拦住）。流式时拆是因为那半行马上会变；
   * 写完了就该按完整文档解析。用 useMemo 缓存，消息不再变所以只算一次。
   */
  const finalBlocks = useMemo(() => (streaming ? null : parseBlocks(text)), [streaming, text])

  if (streaming && cache.current.text !== text) {
    const result = parseIncremental(text, cache.current.stable)

    if (result.reset) {
      /* 文本被改写（不是往后追加）—— 元素缓存整个作废重建 */
      cache.current.elements = []
    }
    for (const node of result.added) {
      cache.current.elements.push(<Block key={cache.current.elements.length} node={node} />)
    }

    cache.current.text = text
    cache.current.stable = result.cache
    cache.current.tailText = result.tailText
  }

  if (!streaming) {
    return (
      <div className="break-words text-base leading-relaxed text-fg-primary">
        <BlockList blocks={finalBlocks ?? []} />
      </div>
    )
  }

  const { elements, tailText } = cache.current

  return (
    <div className="break-words text-base leading-relaxed text-fg-primary">
      <CachedBlocks elements={elements} />
      <TailBlock text={tailText} streaming />
    </div>
  )
})

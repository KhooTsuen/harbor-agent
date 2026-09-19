import type { BlockNode } from './types'
import { parseBlocks } from './blocks'

/* ══════════════════════════════════════════════════════════════
   AG-021：流式下的增量解析

   问题：流式输出时每收到一批 token 就把**全文**重解析一遍。
   实测（tmp 里的 baseline）：20000 字的回复，一次流式要在主线程上
   累计花掉约 2.7 秒 —— 而且解析之外还要重建几百个块的 React 元素树。
   文本越长越亏，是实打实的 O(n²)。

   做法：Markdown 里「空行 + 下一行顶格」是块的分界 —— 那之前的块
   **不会再变**（流式只会往后追加）。所以：

       text = "AAA\n\nBBB\n\nCCC（还在长）"
              └──稳定──┘ └──稳定──┘ └─尾块─┘
                缓存复用            每次重解析（但它短）

   ── 为什么不能简单地「见空行就切」──

   有几个例外会让「切片解析」和「整体解析」结果不一致：

     · `- a\n\n    - b`   —— 缩进更深的续行仍属于**同一个**列表项。
       切在空行后，`- a` 会变成一个列表、`    - b` 变成另一个。
     · 代码块里的空行    —— 围栏没关之前，空行不算分界。
     · 引用懒续行        —— `> a\n\nb`，空行处引用确实断了（这个是安全的），
       但为了稳妥仍然排除 `>` 开头。

   所以切点的条件是**空行 + 下一行顶格且不是 `>`**，而且**不在围栏内**。

   ── 兜底（这条最重要）──

   上面这套道理再对，也不能靠它自己保证正确。所以：
   1. 只在 `text` 是**上一次 text 的前缀延申**时才复用（`startsWith` 校验）；
   2. **测试里做对拍** —— 增量结果必须与 `parseBlocks(全文)` 完全一致
      （用一堆刁钻样本：列表套列表、代码块里放空行、引用、表格……）。

   宁可退回全量解析（慢一点但一定对），也不给出错误的块。
   ══════════════════════════════════════════════════════════════ */

const RE_FENCE = /^(\s*)(`{3,}|~{3,})/
const RE_QUOTE = /^\s*>/

/** 被缓存下来的、已经解析完的稳定前缀 */
export interface StableCache {
  /** 缓存对应的原文前缀 */
  text: string
  /**
   * 已经稳定下来的块。
   *
   * ★ **这个数组是「只增不改」的** —— 新块用 `push` 追加，引用永远不变。
   * 这一点很关键：渲染那边会把解析出的块**转成 React 元素并缓存**，
   * 而元素缓存的命中靠的就是「同一个元素对象」（React 碰到
   * `oldElement === newElement` 会直接 bailout，连子节点都不过）。
   */
  blocks: BlockNode[]
  /** 扫描位置（行首字符偏移），下次从这里继续扫围栏 */
  scanFrom: number
  /** 扫描到 `scanFrom` 那一刻是否在围栏（代码块）内 */
  inFence: boolean
}

/**
 * 空缓存。
 *
 * ★ 这是个模块级**共享**常量，而 `parseIncremental` 会**就地 push** 到
 * `cache.blocks`。所以入口处第一个动作就是：碰到它先拿一份副本
 * （见 `parseIncremental` 开头）。
 *
 * 不加 `Object.freeze` 是因为它会把类型变成 `readonly`，而下游期望可变数组。
 * 代价是「忘了复制」会变成静默污染 —— 所以有单元测试盯着这点
 * （`incremental.test.ts` 里有一条专门验证 EMPTY_CACHE 不被改）。
 */
export const EMPTY_CACHE: StableCache = {
  text: '',
  blocks: [],
  scanFrom: 0,
  inFence: false,
}

/**
 * 从 `from` 开始往后扫，找出**最后一个安全切点**。
 *
 * 返回的 `point` 是「下一个块的开头」的字符偏移（0 表示没找到安全切点）。
 *
 * 这个函数刻意用最笨的逐行扫描 —— 它只做字符串比较和两个正则，
 * 比 `parseBlocks` 那种要构造 AST 的活儿便宜得多，而且**扫描位置可以缓存**：
 * 下一次只从上次扫到的地方继续（这就是「增量」真正省下来的部分）。
 */
export function findStablePoint(
  text: string,
  from: number,
  inFence: boolean,
): { point: number; scanFrom: number; inFence: boolean } {
  /*
   * 末尾那一行如果没换行收尾，说明它**还在长** → 本次扫到它的行首就停。
   *
   * 这一步是必须的：`i` 正好落在换行符上时，`slice(i, i)` 会得到空串，
   * 看起来像「一个空行」，于是把切点放到 `- 甲\n` 与 `- ` 之间，
   * 把同一个列表劈成两个。（对拍测试抓到的第一个真 bug。）
   *
   * 停在它的行首还有个好处：`fence` 与 `scanFrom` 天然对齐 ——
   * 两者都指向「已完整扫描的部分」的结尾，不用额外记录历史状态。
   */
  const lastNl = text.lastIndexOf('\n')
  const limit = lastNl === text.length - 1 ? text.length : Math.max(0, lastNl + 1)

  let i = Math.max(0, from)
  let point = 0
  let fence = inFence

  while (i < limit) {
    const nl = text.indexOf('\n', i)
    const lineEnd = nl === -1 || nl > limit ? limit : nl
    const line = text.slice(i, lineEnd)

    if (RE_FENCE.test(line)) {
      fence = !fence
    } else if (!fence && line.trim() === '') {
      /* 空行：下一行顶格、不是引用 —— 才算块的分界 */
      const nextStart = lineEnd + 1
      if (nextStart < text.length) {
        const nextNl = text.indexOf('\n', nextStart)
        const nextLine = text.slice(nextStart, nextNl === -1 ? text.length : nextNl)
        if (nextLine.trim() && !/^\s/.test(nextLine) && !RE_QUOTE.test(nextLine)) {
          point = nextStart
        }
      }
    }

    if (nl === -1 || nl >= limit) break
    i = nl + 1
  }

  return { point, scanFrom: limit, inFence: fence }
}

/**
 * 增量解析。
 *
 * @param text  当前完整文本（流式时是不断变长的）
 * @param cache 上一次的结果；传 `EMPTY_CACHE` 就是第一次
 * @param fail  失配时的回调（诊断用 —— 真实运行里不该出现）
 */
export interface IncrementalResult {
  /** 所有稳定块 + 尾块，拼好的完整列表 */
  blocks: BlockNode[]
  /**
   * **新**稳定下来的块（本次新增的那些）。渲染层把它们转成 React 元素
   * 缓存起来 —— 用增量而不是整个列表，是为了避免重做已有元素的元素对象。
   */
  added: BlockNode[]
  /**
   * 上一次的缓存被丢弃了（文本不是往后追加，而是被改写）。
   * 渲染层看到这个必须把元素缓存**整个重建**，否则会拿着过期的元素。
   */
  reset: boolean
  /**
   * 还没稳定的尾巴原文。单独给出来是为了把「稳定部分」和「尾巴」
   * 分给不同的组件：前者只增不改，后者每次都变。
   */
  tailText: string
  cache: StableCache
  reused: number
  parsedChars: number
}

/**
 * 判断「最后这一行」是不是还没写完整的块标记。
 *
 * 为什么要这么精细（而不是「凡最后一行都不解析」）：
 *
 * 完整的行现在解析就能得到**正确且稳定**的块类型 ——
 *   · `- 甲`      → 列表项，下一行再写 `- 乙` 还是列表项，不横跳
 *   · `## 标题`   → 标题，不会变
 *   · `一段文字`  → 段落，不会变
 *
 * 只有「光杆/半截」的标记，现在解析会得到**错误**的块类型（等它写完又变回来）：
 *   · `- `（光杆列表）  → 现在像段落，写全了变列表
 *   · ```t（半截围栏） → 现在像段落，闭合了变代码块
 *   · `| A | B |`（表格头）→ 现在像段落，分隔线来了变表格
 *
 * 所以只把**残缺的标记**降级成纯文本，完整的一行照常解析。
 */
function isIncompleteLine(line: string): boolean {
  /* 光杆列表标记：`-` `*` `+`（后面没内容，或只有空任务框） */
  if (/^\s*[-*+]\s*$/.test(line)) return true
  if (/^\s*[-*+]\s+\[[ xX]?\]\s*$/.test(line)) return true
  if (/^\s*\d{1,9}[.)]\s*$/.test(line)) return true
  /* 围栏开头（还没内容、还没闭合）：``` 或 ```ts 或 ~~~ */
  if (/^\s*(`{3,}|~{3,})\s*[^\s`~]*$/.test(line)) return true
  /* 光杆标题：##（井号后没文字） */
  if (/^\s*#{1,6}\s*$/.test(line)) return true
  /* 表格行：以 | 开头（这行将来大概率是表格，等分隔线/下一行确定再说）
     —— 注意不能用「必须含两个 |」：那样 `|` → `| A` → `| A |` 会在
     残缺/完整之间反复横跳 */
  if (/^\s*\|/.test(line)) return true
  /* 光杆引用 > */
  if (/^\s*>\s*$/.test(line)) return true
  return false
}

/**
 * 把尾巴拆成「已经能解析的部分」和「还在写的残缺行」。
 *
 * 和旧版（**凡**最后一行都拆出去）的区别：现在只有**残缺的标记行**
 * 才拆出去当纯文本，完整的一行直接归入 settled、照常解析。
 *
 * 这样 `## 标题`、`- 甲`、普通段落就不会「先显示成纯文本、换行后
 * 突然变格式」—— 那正是用户说的「写完一段被覆盖重写」的真身。
 */
export function splitPendingLine(text: string): { settled: string; pending: string } {
  const nl = text.lastIndexOf('\n')
  if (nl === -1) {
    /* 只有一行：残缺才拆，完整就直接解析 */
    return isIncompleteLine(text) ? { settled: '', pending: text } : { settled: text, pending: '' }
  }
  const last = text.slice(nl + 1)
  if (isIncompleteLine(last)) {
    return { settled: text.slice(0, nl + 1), pending: last }
  }
  return { settled: text, pending: '' }
}

/**
 * 增量解析。
 *
 * @param text  当前完整文本（流式时是不断变长的）
 * @param cache 上一次的结果；传 `EMPTY_CACHE` 就是第一次
 * @param fail  失配时的回调（诊断用 —— 真实运行里不该出现）
 */
export function parseIncremental(
  text: string,
  cache: StableCache,
  fail?: (reason: string) => void,
): IncrementalResult {
  /*
   * `EMPTY_CACHE` 是共享常量，而下面要**就地 push** 到 `cache.blocks` ——
   * 所以碰到它先拿一份属于本次调用的副本（它的数组是冻结的，直接 push 会抛）。
   */
  if (cache === EMPTY_CACHE) cache = { ...EMPTY_CACHE, blocks: [] }

  /* ① 校验：必须是「在上次的基础上往后长」才能复用。否则（比如用户编辑过）
        整份重来 —— 慢但一定对。 */
  if (!text.startsWith(cache.text)) {
    fail?.('文本被改写，不是追加')
    return freshParse(text)
  }

  /* ② 从上次扫到的地方继续找切点 */
  const scan = findStablePoint(text, cache.scanFrom, cache.inFence)
  const point = scan.point

  /* ③ 没有新切点（尾块还在长）→ 只需重解析尾巴 */
  if (point === 0 || point <= cache.text.length) {
    const tailText = text.slice(cache.text.length)
    const tail = tailText ? parseBlocks(tailText) : []
    return {
      blocks: [...cache.blocks, ...tail],
      added: [],
      reset: false,
      tailText,
      cache: {
        text: cache.text,
        blocks: cache.blocks,
        scanFrom: scan.scanFrom,
        inFence: scan.inFence,
      },
      reused: cache.blocks.length,
      parsedChars: tailText.length,
    }
  }

  /* ④ 有新切点 → 把「上次缓存的前缀 ~ 新切点」这新增的一段解析掉 */
  const addedText = text.slice(cache.text.length, point)
  const added = addedText ? parseBlocks(addedText) : []

  /*
   * ★ 关键：`blocks` 用 **push 就地追加**，不造新数组。
   * 新数组会让渲染层的「元素缓存」全部失效（它靠的是对象引用）。
   */
  for (const node of added) cache.blocks.push(node)

  const newCache: StableCache = {
    text: text.slice(0, point),
    blocks: cache.blocks, // 同一个数组
    scanFrom: scan.scanFrom,
    inFence: scan.inFence,
  }

  /* ⑤ 切点之后的部分（尾块）照常解析，但不进缓存 */
  const tailText = text.slice(point)
  const tail = tailText ? parseBlocks(tailText) : []

  return {
    blocks: [...newCache.blocks, ...tail],
    added,
    reset: false,
    tailText,
    cache: newCache,
    reused: cache.blocks.length - added.length,
    parsedChars: addedText.length + tailText.length,
  }
}

function freshParse(text: string): IncrementalResult {
  const blocks = text ? parseBlocks(text) : []
  return {
    blocks,
    added: blocks,
    reset: true,
    tailText: text,
    cache: { ...EMPTY_CACHE, blocks, scanFrom: 0, inFence: false },
    reused: 0,
    parsedChars: text.length,
  }
}

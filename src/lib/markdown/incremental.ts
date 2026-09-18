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
  /** 这段前缀解析出的块 */
  blocks: BlockNode[]
  /** 扫描位置（行首字符偏移），下次从这里继续扫围栏 */
  scanFrom: number
  /** 扫描到 `scanFrom` 那一刻是否在围栏（代码块）内 */
  inFence: boolean
}

export const EMPTY_CACHE: StableCache = { text: '', blocks: [], scanFrom: 0, inFence: false }

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
  /** 稳定块 + 尾块，拼好的完整列表 */
  blocks: BlockNode[]
  /**
   * 还没稳定的尾巴原文。
   *
   * 单独给出来是为了渲染能分家：稳定块那棵子树交给一个 memo 组件
   * （props 是同一个数组引用 → 整个子树的 diff 都跳过），
   * 尾巴单独渲染。实测光靠「每个块 memo」不够 —— 父组件仍然要
   * 一遍遍跑完所有子元素做 props 比较（bench 里 5000 字渲染 1101ms，
   * 其中绝大部分就是在跑这些没变化的子元素）。
   */
  tailText: string
  cache: StableCache
  reused: number
  parsedChars: number
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

  /* ④ 有新切点 → 把「上次缓存的前缀 ~ 新切点」这新增的一段解析掉，接在后面 */
  const addedText = text.slice(cache.text.length, point)
  const added = addedText ? parseBlocks(addedText) : []
  const blocks = [...cache.blocks, ...added]
  const newCache: StableCache = {
    text: text.slice(0, point),
    blocks,
    scanFrom: scan.scanFrom,
    inFence: scan.inFence,
  }

  /* ⑤ 切点之后的部分（尾块）照常解析，但不进缓存 */
  const tailText = text.slice(point)
  const tail = tailText ? parseBlocks(tailText) : []

  return {
    blocks: [...blocks, ...tail],
    tailText,
    cache: newCache,
    reused: cache.blocks.length,
    parsedChars: addedText.length + tailText.length,
  }
}

function freshParse(text: string): IncrementalResult {
  return {
    blocks: text ? parseBlocks(text) : [],
    tailText: text,
    cache: EMPTY_CACHE,
    reused: 0,
    parsedChars: text.length,
  }
}

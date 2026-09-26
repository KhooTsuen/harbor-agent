import type { BlockNode } from './types'
import { parseBlocks } from './blocks'

/* ══════════════════════════════════════════════════════════════
   流式下的增量解析

   问题：流式时每收到一批 token 就把**全文**重解析一遍，文本越长越亏
   （20000 字一次流式，主线程累计约 2.7 秒），实打实的 O(n²)。

   做法：Markdown 里「空行 + 下一行顶格」是块的分界 —— 那之前的块
   **不会再变**（流式只往后追加）。所以只重解析尾巴。

   ★ 不能「见空行就切」：`- a\n\n    - b` 的缩进续行仍属同一个列表项；
     代码块里的空行不算分界；引用后接空行。切点条件因此是
     「空行 + 下一行顶格、不是 `>`、且不在围栏内」。

   ★ 兜底：只在 text 是上次 text 的**前缀延申**时才复用；对拍测试
     （`__tests__/incremental.test.ts`）逐步模拟流式，断言
     「增量结果 === parseBlocks(全文)」。宁可退回全量，也不给错块。
   ══════════════════════════════════════════════════════════════ */

const RE_FENCE = /^(\s*)(`{3,}|~{3,})/
const RE_QUOTE = /^\s*>/

/** 缓存下来的、已经解析完的稳定前缀 */
export interface StableCache {
  /** 缓存对应的原文前缀 */
  text: string
  /**
   * 已经稳定下来的块。
   *
   * ★ **只增不改**：新块用 `push` 追加，引用永远不变 —— 渲染层的
   * memo 命中靠的就是「同一个数组 / 同一个节点对象」。
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
 * ★ 模块级**共享**常量，而 `parseIncremental` 会就地 push 到 `cache.blocks`
 * —— 所以入口第一件事就是碰到它先复制一份（见 `parseIncremental` 开头）。
 */
export const EMPTY_CACHE: StableCache = {
  text: '',
  blocks: [],
  scanFrom: 0,
  inFence: false,
}

/**
 * 从 `from` 往后扫，找出**最后一个安全切点**（下一个块的开头偏移；0 = 没有）。
 *
 * 逐行扫描刻意用最笨的写法：只做字符串比较和两个正则，比 `parseBlocks`
 * 便宜得多，而且扫描位置可缓存 —— 下次只从上次扫到的地方继续。
 */
export function findStablePoint(
  text: string,
  from: number,
  inFence: boolean,
): { point: number; scanFrom: number; inFence: boolean } {
  /*
   * 末尾那行没换行收尾 = 还在长 → 本次扫到它的行首就停。
   * 必须这么做：`i` 落在换行符上时 `slice(i, i)` 是空串，看起来像空行，
   * 会把同一个列表劈成两个（对拍测试抓到的真 bug）。
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

export interface IncrementalResult {
  /** 稳定块 + 尾巴块，拼好的完整列表（对拍用；渲染走 `cache.blocks` + `tailText`） */
  blocks: BlockNode[]
  /** **新**稳定下来的块（本次新增） */
  added: BlockNode[]
  /** 缓存被丢弃（文本被改写而不是追加）—— 渲染层要整个重建 */
  reset: boolean
  /** 还没稳定的尾巴原文 */
  tailText: string
  cache: StableCache
  reused: number
  parsedChars: number
}

/**
 * 增量解析。
 *
 * @param text  当前完整文本（流式时不断变长）
 * @param cache 上一次的结果；首次传 `EMPTY_CACHE`
 * @param fail  失配回调（诊断用 —— 真实运行里不该出现）
 */
export function parseIncremental(
  text: string,
  cache: StableCache,
  fail?: (reason: string) => void,
): IncrementalResult {
  /* EMPTY_CACHE 是共享常量，而下面要就地 push —— 先拿一份自己的副本 */
  if (cache === EMPTY_CACHE) cache = { ...EMPTY_CACHE, blocks: [] }

  /* ① 必须是「在上次基础上往后长」才能复用；否则整份重来（慢但一定对） */
  if (!text.startsWith(cache.text)) {
    fail?.('文本被改写，不是追加')
    return freshParse(text)
  }

  /* ② 从上次扫到的地方继续找切点 */
  const scan = findStablePoint(text, cache.scanFrom, cache.inFence)
  const point = scan.point

  /* ③ 没有新切点（尾块还在长）→ 只重解析尾巴 */
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

  /* ④ 有新切点 → 只解析「上次缓存的前缀 ~ 新切点」这一段 */
  const addedText = text.slice(cache.text.length, point)
  const added = addedText ? parseBlocks(addedText) : []

  /* ★ 就地 push，不造新数组：新数组会让渲染层的 memo 全部失效 */
  for (const node of added) cache.blocks.push(node)

  const newCache: StableCache = {
    text: text.slice(0, point),
    blocks: cache.blocks, // 同一个数组
    scanFrom: scan.scanFrom,
    inFence: scan.inFence,
  }

  /* ⑤ 切点之后（尾巴）照常解析，但不进缓存 */
  const tailText = text.slice(point)
  const tail = tailText ? parseBlocks(tailText) : []

  return {
    blocks: [...newCache.blocks, ...tail],
    added,
    reset: false,
    tailText,
    cache: newCache,
    reused: newCache.blocks.length - added.length,
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

/* 半行策略单独一个文件（`pending.ts`）—— 这里原样转出，调用方只认一个入口 */
export { isIncompleteLine, splitPendingLine } from './pending'

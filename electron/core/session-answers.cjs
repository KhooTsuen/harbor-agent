/**
 * 会话存储：把「同一次提问的多个回答」收成一组
 *
 * 从 session-read.cjs 拆出来的（那边加完注释就贴 300 行了）。
 *
 * ── 为什么需要它（用户报的 bug）───────────────────────────────
 * 提问是**有多版本**的（`versions` / `versionIndex`，编辑一次多一版），
 * 但回答以前没有任何「我在回答哪一版」的标记 —— 于是：
 *
 *   ① 切提问版本时只能**重新生成**（不然答非所问），生成品又追加在文件末尾；
 *   ② 旧回答**没人删**（会话文件是追加式的，前端删的只是内存）；
 *   ③ 读的一侧（collapseByKey）只按 `key` 合并同一次流式的快照，
 *      认不出「这两条是同一次提问的两次生成」。
 *
 * 结果（用户真实会话里的样子）：改一次、切一次，界面上就多一个回答 ——
 *   ```
 *   0 用户 [2版] 搜索一下胡斯战争的信息
 *   1 助手 搜索引擎那边连不上…
 *   2 助手 两步都跑通了…
 *   3 助手 （空）
 *   ```
 * 而这个现象**只有重新打开会话才看得见**（在同一个会话里编辑时前端删了内存，
 * 看起来是对的）—— 所以用户把它描述成「切换会话之后才出现」。
 *
 * ── 现在怎么认 ──────────────────────────────────────────────
 *   · 写的一侧给每条回答记上 `answersKey`（答的是哪条提问）+ `answersVersion`（第几版）
 *   · 这里按 (提问, 版本) 分组：**界面只显示那一版最新的那条**，
 *     其余作为「回答的历史版本」挂在同一条上（界面用 ‹ n / N › 切，切不重跑）
 *   · 老记录没有这两个字段 → 用「它前面最近的那条提问」认领，版本按**当时显示的那一版**算
 *     （老会话因此也能自动收好：那几个回答会变成同一条的可切换版本，而不是并排躺着）
 *   · 用户选的是第几条回答，记在**提问记录**的 `answerIndexByVersion` 上
 *     （按提问版本分开记）—— 否则重开会话会跳回最新那条（见 pickedIndex）
 */

/** 老记录里 content 空、也没有工具记录的回答 —— 留着只是噪音（用户那份里就有一条） */
function isNoiseAnswer(message) {
  if (String(message.content ?? '').trim()) return false
  return (message.toolRuns ?? []).length === 0
}

const keyOf = (message) => (typeof message.key === 'string' && message.key ? message.key : '')
const versionOf = (message) => {
  const n = Number(message.versionIndex ?? 0)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * 「后续几轮跟着它**当时那一版**走」。
 *
 * 编辑**中间**那条消息时，后面的对话是按旧内容写的 —— 留着会答非所问。
 * 以前前端直接把它们从列表里删掉（`removeMessagesAfter`），代价是：
 * 重开会话它们又回来了，而且接在**新**回答后面（看起来像"旧对话接错了地方"）。
 *
 * 现在写的一侧给用户记录标上「我接在哪条提问的哪一版后面」（`parentKey` /
 * `parentVersion`），这里按**当前选中的那一版**筛：
 * 选 v2 就只留挂在 v2 上的后续，切回 v1 它们全都回来 —— 不用分支 id。
 * 没有这两个字段的老记录一律保留（老会话行为不变）。
 *
 * ★ 以**轮**为单位筛：提问和它的回答（以及工具记录）一起留或一起丢。
 *   只按单条记录筛会漏 —— 助手记录没有 parentKey，前一条提问被筛掉之后
 *   它的回答会孤零零留在列表里（写完第一版就是这个毛病）。
 */
function keepOnActivePath(messages) {
  /* 每条提问「现在是第几版」= 该 key 最后一条版本记录里的 versionIndex */
  const activeVersion = new Map()
  for (const message of messages) {
    const key = keyOf(message)
    if (!key || !Array.isArray(message.versions)) continue
    if (typeof message.versionIndex === 'number') activeVersion.set(key, message.versionIndex)
  }

  const out = []
  let dropTurn = false
  for (const message of messages) {
    if (message.role === 'user') {
      const parent = keyOf({ key: message.parentKey })
      const active = parent ? activeVersion.get(parent) : undefined
      dropTurn =
        Boolean(parent) && active !== undefined && Number(message.parentVersion ?? 0) !== active
      if (!dropTurn) out.push(message)
      continue
    }
    if (dropTurn) continue
    out.push(message)
  }
  return out
}

/**
 * @param {Array} messages collapseByKey 的产物（已按 key 收敛过）
 * @returns {Array} 提问后面紧跟**一条**回答；那条回答上带：
 *   · `answersKey` / `answersVersion`  它答的是谁、第几版
 *   · `answerRecords`                  这条提问的**全部**回答（含别的版本，界面切换用）
 *   · `answerIndex`                    当前显示的是那一版里的第几条
 *     （取提问记录上的 `answerIndexByVersion`，没记过就是最新那条）
 */
function groupAnswers(input) {
  const messages = keepOnActivePath(input)
  const bySlot = new Map() // `${owner}#${version}` → 该版的回答（文件顺序）
  const byOwner = new Map() // owner → 该提问的全部回答（跨版本）
  const ownerOf = new Map() // 那条提问消息 → owner（两趟都用它，别拿下标算）
  const rest = []
  let lastOwner = ''

  for (const message of messages) {
    if (message.role === 'user') {
      /*
       * 提问的身份：有 key 就用 key（同一条消息改几版都算同一个提问）；
       * **老记录没有 key**，退回「这是第几条提问」—— 不然它认领不到自己的回答，
       * 几个回答就并排留在原处（老会话里就是这么看见的）。
       */
      const key = keyOf(message)
      ownerOf.set(message, key ? `k:${key}` : `u:${ownerOf.size}`)
      lastOwner = ownerOf.get(message)
      rest.push(message)
      continue
    }
    if (message.role !== 'assistant' || isNoiseAnswer(message)) {
      /* 空回答直接丢掉 —— 但别的角色（system / tool）原样留着 */
      if (message.role !== 'assistant') rest.push(message)
      continue
    }

    const answersKey = keyOf({ key: message.answersKey })
    /* 写侧带 answersKey 的直接归位；老记录用它前面最近的那条提问 */
    const owner = answersKey ? `k:${answersKey}` : lastOwner
    /* 答不上任何提问的（会话第一条就是助手）→ 原位留着，不做认领 */
    if (!owner) {
      rest.push(message)
      continue
    }

    const ownerVersion = Number.isInteger(message.answersVersion)
      ? message.answersVersion
      : (versionOf(messages.find((m) => ownerOf.get(m) === owner)) ?? 0)
    const tagged = { ...message, answersKey, answersVersion: ownerVersion }
    const slot = `${owner}#${ownerVersion}`
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), tagged])
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), tagged])
  }

  /*
   * 出列表。★ 回答**挪到它的提问正后方** —— 不能留在文件里的位置：
   * 编辑产生的那条回答是追加在文件末尾的（追加式存储没得选），
   * 留着原位就会和旧回答并排躺着，正是用户看到的乱象。
   */
  const out = []
  for (const message of rest) {
    out.push(message)
    if (message.role !== 'user') continue
    const owner = ownerOf.get(message)
    if (!owner || !byOwner.has(owner)) continue
    const version = versionOf(message)
    const list = bySlot.get(`${owner}#${version}`)
    if (!list?.length) continue
    const at = pickedIndex(message, version, list.length)
    out.push({
      ...list[at],
      /* 同一次提问的其它回答一起带上 —— 切版本 / 重新生成都不用重跑 */
      answerRecords: byOwner.get(owner) ?? list,
      answerIndex: at,
    })
  }
  return out
}

/**
 * 用户上次在这一版提问里选的是第几条回答。
 *
 * ★ 为什么要存：切回答（‹ n / N ›）本来就不重跑，但**选择本身**以前没落盘 ——
 *   重开会话又跳回最新那条，用户选的那版白选了。记在**提问记录**上、
 *   按提问版本分开存（`answerIndexByVersion`），所以切回哪一版就还是那一版的选择。
 *
 * 越界 / 没记过 / 老记录 → 一律退回「最新那条」，和以前的行为一致。
 * （用户选过的那条被重新生成挤掉时也会越界，同样退回最新。）
 */
function pickedIndex(question, version, count) {
  const picks = question?.answerIndexByVersion
  if (!picks || typeof picks !== 'object') return count - 1
  const want = Number(picks[String(version)])
  return Number.isInteger(want) && want >= 0 && want < count ? want : count - 1
}

module.exports = { groupAnswers, keepOnActivePath, isNoiseAnswer }

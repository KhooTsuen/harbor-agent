import type { Message } from '@/types'
import { allAnswers, answersOfVersion } from './answers'

/* ══════════════════════════════════════════════════════════════
   分支路径：算「当前激活路径上有哪些分叉点」

   数据模型先说清（Harbor 不用 parentId 树，别按树去找）：
     · 提问的多版本 = **同一条用户消息**的 versions[] / versionIndex（编辑一次多一版）
     · 回答的多版本 = 回答记录里的 answerRecords + answersVersion + answerIndex
       （同一次提问的多个回答挂在一起，切着看不重跑）
     · 后续几轮跟着「当时那一版」走：内核按 parentKey / parentVersion 筛
       （见 electron/core/session-answers.cjs）—— 切提问版本时后面几轮自己回来

   所以「分叉点」就是路径上这两类节点的多版本位置：
     · kind: 'question' → 用户消息改过好几版（切换 = activateUserVersion）
     · kind: 'answer'   → 这一版提问有好几条回答（切换 = activateAnswer）
   level 是沿路径数出来的层号（界面显示 L1、L2）—— 用来回答
   「我现在在第几层分叉」这个问题。
   ══════════════════════════════════════════════════════════════ */

export interface ForkOption {
  index: number
  /** 序号说法：「第 1 版」/「第 1 条」 */
  label: string
  /** 菜单里显示的文字（取第一行、截断） */
  preview: string
  current: boolean
}

export interface ForkPoint {
  /** 切换时要用：分叉所在消息的 id */
  id: string
  threadId: string
  kind: 'question' | 'answer'
  /** 第几层分叉（1 起；界面显示 L1、L2） */
  level: number
  /** 沿路径的说法：「提问 2」/「答复 2」 */
  name: string
  /** 当前是第几条（0 起，已夹进范围） */
  current: number
  total: number
  options: ForkOption[]
}

/** 取第一行、截断——菜单里只放一行预览，全文在消息本身上 */
export function previewOf(text: string, max = 28): string {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return '（空）'
  return line.length > max ? `${line.slice(0, max)}…` : line
}

const clamp = (value: number, length: number): number =>
  Math.min(Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0), length - 1)

/**
 * 沿消息列表（= 当前激活路径，内核已经按选中版本筛好）找出所有分叉点。
 *
 * 只算**真分叉**（≥2 个选项）—— 没改过、没重新生成过的消息不是分叉点，
 * 不进面包屑也不挂 L 标（不然每条消息都是「分叉」）。
 */
export function getForkPoints(messages: readonly Message[]): ForkPoint[] {
  const forks: ForkPoint[] = []
  let userCount = 0
  let answerCount = 0
  for (const m of messages) {
    if (m.role === 'user') {
      userCount += 1
      const versions = m.versions ?? []
      if (versions.length < 2) continue
      const current = clamp(m.versionIndex ?? 0, versions.length)
      forks.push({
        id: m.id,
        threadId: m.threadId,
        kind: 'question',
        level: forks.length + 1,
        name: `提问 ${userCount}`,
        current,
        total: versions.length,
        options: versions.map((v, i) => ({
          index: i,
          label: `第 ${i + 1} 版`,
          preview: previewOf(v),
          current: i === current,
        })),
      })
      continue
    }
    if (m.role !== 'assistant') continue
    answerCount += 1
    /* 只数**这一版提问**的回答 —— 别的版本的回答不算这一层的兄弟 */
    const records = answersOfVersion(allAnswers(m), m.answersVersion ?? 0)
    if (records.length < 2) continue
    const current = clamp(m.answerIndex ?? records.length - 1, records.length)
    forks.push({
      id: m.id,
      threadId: m.threadId,
      kind: 'answer',
      level: forks.length + 1,
      name: `答复 ${answerCount}`,
      current,
      total: records.length,
      options: records.map((r, i) => ({
        index: i,
        label: `第 ${i + 1} 条`,
        preview: previewOf(r.content ?? ''),
        current: i === current,
      })),
    })
  }
  return forks
}

import type { ClarifyReply } from '@/types'

export function clarifyReplyDetails(reply: ClarifyReply): string[] {
  if (reply.cancelled) return ['已选择：先不做了']
  if (reply.rephrase) return ['已选择：换个说法']
  if (reply.skipped) return ['已选择：跳过，由 Agent 判断']
  const details = reply.answers.flatMap((answer) => {
    const value = [answer.choice, answer.text.trim()].filter(Boolean).join('；补充：')
    return value ? [`${answer.question}：${value}`] : []
  })
  return details.length ? details : ['已选择：按当前答复继续']
}

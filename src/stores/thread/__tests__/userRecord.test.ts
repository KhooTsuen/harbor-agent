import { describe, expect, it } from 'vitest'
import { userRecord } from '../userRecord'
import { buildHistory } from '../history'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   带图提问：写进会话 + 发给模型

   2026-09-28 真机事故（用户报「DeepSeek 支持多模态了，它还说看不见图」）
   在这条链路上有**两个**断点，一次钉住：

     · 落盘（`userRecord`）以前不带 `images` → 重开会话只剩「（图片）」这行字，
       缩略图没了，「恢复任务」时模型也收不到画面
     · 发给模型的 history（`buildHistory`）以前是好的，但**没有测试** ——
       而内核那边恰恰把数组压成字符串切掉了（见 `context-builder.cjs` 与
       `scripts/selftest/groups/86-vision.mjs`）

   所以这一组测的是「前端这一侧有没有把图带上」，内核那一侧在同名自检组里。
   ══════════════════════════════════════════════════════════════ */

const PNG = 'data:image/png;base64,AAAA'
const img = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  threadId: 't1',
  role: 'user',
  content: '',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

describe('带图提问 · 落盘', () => {
  it('★ images 必须写进去（不然重开会话图片就"消失"了）', () => {
    const record = userRecord(img({ content: '看看这个', images: [PNG] }))
    expect(record.images).toEqual([PNG])
    expect(record.content).toBe('看看这个')
  })

  it('一个字都没打 → content 给个占位，但图片照留', () => {
    const record = userRecord(img({ images: [PNG] }))
    expect(record.content).toBe('（图片）')
    expect(record.images).toEqual([PNG])
  })

  it('没图就不写 images 字段（老会话形状不变）', () => {
    expect('images' in userRecord(img({ content: '你好' }))).toBe(false)
  })

  it('key / parentKey 照旧带上（编辑收敛、分支路径都靠它）', () => {
    const record = userRecord(img({ content: 'x' }), { key: 'q0', version: 1 })
    expect(record.key).toBe('m1')
    expect(record.parentKey).toBe('q0')
    expect(record.parentVersion).toBe(1)
  })
})

describe('带图提问 · 发给模型', () => {
  it('★ 带图消息要变成多模态数组（只发文字的话模型只会回"没收到图片"）', () => {
    const history = buildHistory([img({ content: '这是什么', images: [PNG] })], 'other')
    expect(history[0]?.content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: PNG } },
    ])
  })

  it('只有图、没有文字 → 数组里就是一个图片块（别塞个空 text）', () => {
    const history = buildHistory([img({ images: [PNG] })], 'other')
    expect((history[0]?.content as unknown[]).length).toBe(1)
  })

  it('自己那条被排除（exceptMessageId）—— 当前的提问由主进程单独带上', () => {
    const history = buildHistory([img({ id: 'x1', images: [PNG] })], 'x1')
    expect(history).toHaveLength(0)
  })
})

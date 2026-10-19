import { describe, expect, it } from 'vitest'
import { isCenteredConfirm } from '../PermissionDialog'

/* ══════════════════════════════════════════════════════════════
   P2 #12：确认卡的位置判据

   文档要求：**危险确认居中**（删除对话这类「明确做一次决定」），
   而**模型要写文件 / 跑命令**的确认仍贴输入区（它属于当前这一轮，
   位置绑定是对的，而且不遮罩）。

   判据从 `PermissionDialog.isCenteredConfirm` 直接引用（不抄一份）——
   改错了的表现是「删除确认跑到输入框上面去了」，截图里看着很正常。
   ══════════════════════════════════════════════════════════════ */

describe('P2 #12 确认卡位置', () => {
  it('危险操作（删除对话 / 清空数据）→ 居中', () => {
    expect(isCenteredConfirm(true)).toBe(true)
  })

  it('写文件 / 跑命令的确认 → 仍贴输入区', () => {
    expect(isCenteredConfirm(undefined)).toBe(false)
    expect(isCenteredConfirm(false)).toBe(false)
  })

  it('只有严格 true 才居中 —— 脏值不该移动危险确认', () => {
    expect(isCenteredConfirm('true' as unknown as boolean)).toBe(false)
    expect(isCenteredConfirm(1 as unknown as boolean)).toBe(false)
  })
})

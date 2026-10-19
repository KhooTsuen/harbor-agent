/* ══════════════════════════════════════════════════════════════
   「为什么发不出去」（P1 #14）

   ── 为什么要有这个文件 ────────────────────────────────────────
   以前这段判断是**一条字符串**，而 `SendAvailability` 靠
   `reason.includes('附件')` 猜它属于哪一类 —— 文案一改，那个「打开模型设置」
   按钮就会跑到「附件正在读取」这种情况下面。文案是我们随时会改的东西，
   不该同时承担类型判据。

   所以这里把原因收成一个**带 kind 的对象**：谁算出来的、谁显示、显示时要不要
   给「去设置」的入口，各自按 kind 判断，不再读文本。

   ── 口径（与文档验收一一对应）────────────────────────────────
     · `pending`          附件还在读（读完了自然解除，不是配置问题）
     · `attachment-failed` 只剩读失败的附件，等于没有可发内容
     · `empty`            真的什么都没写
     · `connection`       模型/供应商不可用 —— 这一类才给「打开模型设置」
   多个原因同时存在时按上面的顺序取**当前最主要**的那个：正在读的附件会
   最先解除，连接问题在它之后才成为阻塞项。
   ══════════════════════════════════════════════════════════════ */

export type SendBlockKind = 'pending' | 'attachment-failed' | 'empty' | 'connection'

export interface SendBlock {
  kind: SendBlockKind
  /** 直接给用户看的一句话（不要在这里塞技术细节） */
  text: string
}

export function sendBlockOf(input: {
  pendingReads: number
  /** 有可发送的文字 / 图片 / 可读附件 */
  hasContent: boolean
  /** 附件全部读取失败时的原因（是失败，不是「忘了写东西」） */
  attachmentFailure: string | null
  /** 模型与供应商侧的阻塞原因（来自 connectionIssue） */
  providerReason: string | null
}): SendBlock | null {
  if (input.pendingReads > 0) {
    return {
      kind: 'pending',
      text: `${input.pendingReads} 个附件正在读取，完成后可发送`,
    }
  }
  if (!input.hasContent) {
    if (input.attachmentFailure) {
      return {
        kind: 'attachment-failed',
        text: `附件读取失败：${input.attachmentFailure}。请重新添加附件`,
      }
    }
    return { kind: 'empty', text: '输入消息或添加附件后可发送' }
  }
  if (input.providerReason) {
    return { kind: 'connection', text: input.providerReason }
  }
  return null
}

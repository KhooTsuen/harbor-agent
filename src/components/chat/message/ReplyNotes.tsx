/**
 * 消息底部那一行「这条没写完」的说明（2026-11-08）
 *
 * 从 `MessageItem.tsx` 拆出来的：那边加完两种提示就到 310 行（硬约束 #2 是 300）。
 *
 * ── 为什么是两种，不是一种 ──────────────────────────────────────
 *
 *   · `interrupted` —— 磁盘上只剩流式快照：**事后推断**的（上次进程被打断）
 *   · `truncated`   —— 上游亲口说的：`length`（撞输出上限）/ `stream_cut`（断流）
 *
 * 两者处置完全不同：前者要去右栏「任务」接着做；后者说一声「接着写」就能续上。
 * 合成一句话会误导用户（他按「任务」找，却什么也没有）。
 */

interface Props {
  interrupted?: boolean
  truncated?: 'length' | 'stream_cut' | ''
}

/** 这条回复的「不完整」说明；完整时返回 null（调用方不必再判断） */
export function ReplyNotes({ interrupted, truncated }: Props): React.ReactElement | null {
  if (interrupted) {
    return (
      <p className="mt-1 text-2xs text-fg-tertiary">
        这条回复没写完 —— 上次运行被打断了，可以在右栏「任务」里接着做
      </p>
    )
  }
  if (!truncated) return null
  return (
    <p className="mt-1 text-2xs text-fg-tertiary">
      {truncated === 'length'
        ? '这条回复撞到了模型的输出上限，上面的内容不完整 —— 说一声「接着写」就能续上'
        : '这条回复在网络中断在半路，上面的内容不完整 —— 说一声「接着写」就能续上'}
    </p>
  )
}

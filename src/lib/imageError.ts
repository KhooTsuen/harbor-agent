/* ══════════════════════════════════════════════════════════════
   把「模型读不了图」的报错翻译成人话

   从 turns.ts 拆出来的：那段主流程已经很长，而这个函数
   跟「发消息」这件事没关系，只是文案映射。
   ══════════════════════════════════════════════════════════════ */

/**
 * 把「模型读不了图」的报错翻译成人话。
 * 各家措辞不一，但共同点：提到 image / multimodal，且是 400 那类参数错误。
 */
export function explainError(message: string): string {
  const looksVisionRelated =
    /image|multimodal|vision|content type|modality/i.test(message) &&
    /(invalid|unsupported|not support|400)/i.test(message)

  if (!looksVisionRelated) return message
  return `${message}

（这通常说明当前模型不支持图片输入，去「设置 → 模型与提示词」换一个能读图的模型）`
}

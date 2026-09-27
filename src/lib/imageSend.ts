import { normalizeDataUrl, type ImageCodecs, browserCodecs } from './imageNormalize'

/* ══════════════════════════════════════════════════════════════
   发送前的**最后一米**：把要发出去的历史里的图全部洗一遍

   为什么不能只在「贴进来那一刻」洗（用户 2026-09-28 真机 400 的根因）：
   历史里的图会跟着**每一条新消息**一起发出去。用户那条会话里有一张
   14200×7104 的旧 JPEG（那时还没这层归整），于是一发新消息就被上游拒：

     messages[10].image[0]: You have uploaded an unsupported image.

   注意上游对「尺寸离谱」和「格式不对」给的是**同一句**报错 —— 所以那次的症状
   看着像「BMP 没修好」，其实 BMP 早修好了，只是没管历史。

   失败**直接抛**（不静默丢图）：调用点提示用户并中止这次发送，
   否则模型又会回一句「我没收到图片」，白绕一圈。
   ══════════════════════════════════════════════════════════════ */

/** 一批图逐个洗（同一张走缓存，不会重复解码） */
export async function normalizeImagesForSend(
  images: string[],
  codecs: ImageCodecs = browserCodecs,
): Promise<string[]> {
  const out: string[] = []
  for (const image of images) {
    if (!image.startsWith('data:image/')) continue
    out.push((await normalizeDataUrl(image, codecs)).dataUrl)
  }
  return out
}

/**
 * 把要发给主进程的历史整体洗一遍：内容是多模态数组的，里面的 `image_url.url` 换掉。
 * 不是数组的（纯文本 / 助手消息）原样返回，不动别的字段。
 */
export async function withSendableImages<T extends { content: unknown }>(
  messages: T[],
  codecs: ImageCodecs = browserCodecs,
): Promise<T[]> {
  const out: T[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const parts: unknown[] = []
    for (const part of message.content as { type?: string; image_url?: { url?: string } }[]) {
      const url = part?.type === 'image_url' ? part.image_url?.url : undefined
      if (typeof url !== 'string' || !url.startsWith('data:image/')) {
        parts.push(part)
        continue
      }
      const [normalized] = await normalizeImagesForSend([url], codecs)
      parts.push({ ...part, image_url: { ...part.image_url, url: normalized } })
    }
    out.push({ ...message, content: parts })
  }
  return out
}

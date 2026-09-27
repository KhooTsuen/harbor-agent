import { beforeEach, describe, expect, it } from 'vitest'
import { clearImageCache, type ImageCodecs } from '@/lib/imageNormalize'
import { normalizeImagesForSend, withSendableImages } from '@/lib/imageSend'

/* ══════════════════════════════════════════════════════════════
   发送前的**最后一米**（历史里的图也算）

   这是用户 2026-09-28 第二次真机 400 的根因：图**格式合法**（image/jpeg），
   毛病是尺寸 —— **14200×7104**。而它**不在当前这条消息里**，是历史里的旧图：
   只在「贴进来那一刻」洗的那版实现管不到它，于是一发新消息就必然被上游拒：

     messages[10].image[0]: You have uploaded an unsupported image.

   ══════════════════════════════════════════════════════════════ */

function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(16)
  bytes.set([0xff, 0xd8], 0)
  bytes.set([0xff, 0xc0], 2)
  bytes.set([0x00, 0x11, 0x08], 4)
  const view = new DataView(bytes.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return bytes
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const dataUrlOf = (bytes: Uint8Array, type: string): string =>
  `data:${type};base64,${Buffer.from(bytes).toString('base64')}`

function fakeCodecs(): {
  codecs: ImageCodecs
  encodeCalls: () => [number, number, string][]
} {
  const encodeCalls: [number, number, string][] = []
  return {
    codecs: {
      decode: async (_blob, resize) => ({
        width: resize?.width ?? 800,
        height: resize?.height ?? 600,
        source: {} as CanvasImageSource,
      }),
      encode: async (_image, w, h, type) => {
        encodeCalls.push([w, h, type])
        return new Blob([new Uint8Array(8)], { type })
      },
      toDataUrl: async (blob) => {
        const buf = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (const byte of buf) binary += String.fromCharCode(byte)
        return `data:${blob.type};base64,${btoa(binary)}`
      },
    },
    encodeCalls: () => encodeCalls,
  }
}

beforeEach(() => clearImageCache())

describe('发送前洗历史里的图', () => {
  it('★ 历史里那张 14200×7104 的旧 JPEG 会被缩到 2048', async () => {
    const fake = fakeCodecs()
    const [out] = await normalizeImagesForSend(
      [dataUrlOf(jpegBytes(14200, 7104), 'image/jpeg')],
      fake.codecs,
    )
    expect(out.startsWith('data:image/jpeg')).toBe(true)
    expect(fake.encodeCalls()).toEqual([[2048, 1025, 'image/jpeg']])
    /* 换了内容就一定是新串（否则等于没洗） */
    expect(out).not.toBe(dataUrlOf(jpegBytes(14200, 7104), 'image/jpeg'))
  })

  it('同一张图第二次不再洗（连着发几条不会重复解码）', async () => {
    const fake = fakeCodecs()
    const url = dataUrlOf(jpegBytes(9000, 4000), 'image/jpeg')
    await normalizeImagesForSend([url], fake.codecs)
    await normalizeImagesForSend([url], fake.codecs)
    expect(fake.encodeCalls()).toHaveLength(1)
  })

  it('合规的图不洗也不重复编码', async () => {
    const fake = fakeCodecs()
    const url = dataUrlOf(pngBytes(800, 600), 'image/png')
    const [out] = await normalizeImagesForSend([url], fake.codecs)
    expect(out).toBe(url)
    expect(fake.encodeCalls()).toHaveLength(0)
  })

  it('洗不动的（TIFF）**报错**，不静默丢图', async () => {
    const codecs: ImageCodecs = {
      decode: async () => {
        throw new Error('The source image could not be decoded.')
      },
      encode: async () => new Blob(),
      toDataUrl: async () => 'data:image/png;base64,AA',
    }
    await expect(
      normalizeImagesForSend(
        [dataUrlOf(new Uint8Array([0x49, 0x49, 0x2a, 0]), 'image/tiff')],
        codecs,
      ),
    ).rejects.toThrow(/TIFF 这个格式解不开/)
  })

  it('非图片的串直接跳过（不是 data:image 的东西不该拦发送）', async () => {
    const fake = fakeCodecs()
    expect(await normalizeImagesForSend(['https://example.com/a.png'], fake.codecs)).toEqual([])
  })
})

describe('withSendableImages：整段历史', () => {
  it('只换 image_url，文本块与别的字段原样', async () => {
    const fake = fakeCodecs()
    const messages = [
      { role: 'user', content: '纯文本不动' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: dataUrlOf(jpegBytes(4096, 4096), 'image/jpeg') } },
        ],
      },
    ]
    const out = await withSendableImages(messages, fake.codecs)
    expect(out[0]).toBe(messages[0])
    const parts = out[1].content as { type: string; text?: string; image_url?: { url: string } }[]
    expect(parts[0]).toEqual({ type: 'text', text: '看图' })
    expect(parts[1].image_url?.url).not.toBe(dataUrlOf(jpegBytes(4096, 4096), 'image/jpeg'))
  })

  it('助手消息（内容里带工具记录的长文本）不被改', async () => {
    const fake = fakeCodecs()
    const messages = [{ role: 'assistant', content: '带工具记录的长文本'.repeat(50) }]
    const out = await withSendableImages(messages, fake.codecs)
    expect(out[0]).toBe(messages[0])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_INPUT_BYTES, dataUrlToBlob } from '@/lib/imageFormat'
import {
  clearImageCache,
  normalizeImage,
  normalizeImageBytes,
  type DecodedImage,
  type ImageCodecs,
} from '@/lib/imageNormalize'

/* ══════════════════════════════════════════════════════════════
   归整的**执行层**（解码 / 编码）

   jsdom 没有 canvas，所以编解码器**注入**：这里测的是**决策与调用顺序**
   —— 什么时候不解码、解码时有没有把目标尺寸带上、缩过之后有没有重新编码。
   真机那条路（剪贴板里的真 BMP → 发出去、一亿像素旧图 → 发新消息）由
   `tmp/perf/probe-image-format.cjs` 与 `probe-huge-history.cjs` 各走一遍。
   ══════════════════════════════════════════════════════════════ */

const blobOf = (type: string, bytes = 16): Blob => new Blob([new Uint8Array(bytes)], { type })

/** 造一个真 JPEG 头：SOI 紧跟 SOF0 */
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

/** 造一个真 PNG 头 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 假编解码器：按调用方给的目标尺寸返回（模拟真机「解码时缩放」），并记账 */
function fakeCodecs(options: { fail?: boolean } = {}): {
  codecs: ImageCodecs
  released: () => boolean
  encodeCalls: () => [number, number, string][]
  decodeCalls: () => ({ width: number; height: number } | undefined)[]
} {
  let released = false
  const encodeCalls: [number, number, string][] = []
  const decodeCalls: ({ width: number; height: number } | undefined)[] = []
  return {
    codecs: {
      decode: async (_blob, resize) => {
        decodeCalls.push(resize)
        if (options.fail) throw new Error('The source image could not be decoded.')
        const decoded: DecodedImage = {
          width: resize?.width ?? 800,
          height: resize?.height ?? 600,
          source: {} as CanvasImageSource,
          release: () => {
            released = true
          },
        }
        return decoded
      },
      encode: async (_image, w, h, type) => {
        encodeCalls.push([w, h, type])
        return blobOf(type, 8)
      },
      toDataUrl: async (blob) => {
        /* 真的把字节编回去 —— 「透传」那条断言才看得出来原样不动 */
        const buf = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (const byte of buf) binary += String.fromCharCode(byte)
        return `data:${blob.type};base64,${btoa(binary)}`
      },
    },
    released: () => released,
    encodeCalls: () => encodeCalls,
    decodeCalls: () => decodeCalls,
  }
}

afterEach(() => clearImageCache())

describe('透传与转换', () => {
  it('★ 白名单 + 尺寸合规：**完全不碰解码器**', async () => {
    const fake = fakeCodecs()
    const spy = vi.fn(fake.codecs.decode)
    const result = await normalizeImageBytes(pngBytes(800, 600), 'image/png', {
      ...fake.codecs,
      decode: spy,
    })
    expect(result.changed).toBe(false)
    expect(result.reason).toBe('原样')
    expect(spy).not.toHaveBeenCalled()
  })

  it('★ BMP 会被真的重新编码成 PNG（第一次真机 400）', async () => {
    const fake = fakeCodecs()
    const result = await normalizeImageBytes(
      new Uint8Array([0x42, 0x4d, 0, 0]),
      'image/bmp',
      fake.codecs,
    )
    expect(result.changed).toBe(true)
    expect(result.dataUrl.startsWith('data:image/png')).toBe(true)
    expect(fake.encodeCalls()).toEqual([[800, 600, 'image/png']])
  })

  it('★ 超尺寸：解码时就把目标尺寸带上（别先整张解出来）', async () => {
    const fake = fakeCodecs()
    await normalizeImageBytes(jpegBytes(14200, 7104), 'image/jpeg', fake.codecs)
    expect(fake.decodeCalls()).toEqual([{ width: 2048, height: 1025 }])
  })

  it('★ 让解码器缩过就必须重编码（拿原字节透传 = 根本没缩）', async () => {
    const fake = fakeCodecs()
    const result = await normalizeImageBytes(jpegBytes(5000, 2200), 'image/jpeg', fake.codecs)
    expect(result.changed).toBe(true)
    expect(fake.encodeCalls()).toEqual([[2048, 901, 'image/jpeg']])
  })

  it('解不开的格式（TIFF / HEIC）给人话', async () => {
    const fake = fakeCodecs({ fail: true })
    await expect(
      normalizeImageBytes(new Uint8Array([0x49, 0x49, 0x2a, 0x00]), 'image/tiff', fake.codecs),
    ).rejects.toThrow(/TIFF 这个格式解不开.*先转成 PNG 或 JPG/)
  })

  it('体积超限先说清楚，别去解码一个几十 MB 的 BMP', async () => {
    const fake = fakeCodecs()
    const spy = vi.fn(fake.codecs.decode)
    await expect(
      normalizeImageBytes(new Uint8Array(MAX_INPUT_BYTES + 1), 'image/bmp', {
        ...fake.codecs,
        decode: spy,
      }),
    ).rejects.toThrow(/图片太大/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('空文件直接拦（剪贴板偶尔给个空 blob）', async () => {
    const fake = fakeCodecs()
    await expect(normalizeImageBytes(new Uint8Array(0), 'image/png', fake.codecs)).rejects.toThrow(
      /是空的/,
    )
  })

  it('转完把解码出来的资源还回去（大图不还就是漏内存）', async () => {
    const fake = fakeCodecs()
    await normalizeImageBytes(jpegBytes(14200, 7104), 'image/jpeg', fake.codecs)
    expect(fake.released()).toBe(true)
  })

  it('normalizeImage（Blob 入口）与字节入口同一条路', async () => {
    const fake = fakeCodecs()
    const result = await normalizeImage(blobOf('image/png'), fake.codecs)
    expect(result.dataUrl.startsWith('data:image/png')).toBe(true)
  })
})

describe('data URL 互转', () => {
  it('base64 与百分号编码都认（选图那条路给的是 data URL）', () => {
    const base64 = dataUrlToBlob('data:image/png;base64,QUJD')
    expect(base64.type).toBe('image/png')
    expect(base64.size).toBe(3)
    const plain = dataUrlToBlob('data:text/plain,hello')
    expect(plain.type).toBe('text/plain')
    expect(plain.size).toBe(5)
  })
})

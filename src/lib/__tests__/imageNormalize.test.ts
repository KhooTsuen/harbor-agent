import { describe, expect, it, vi } from 'vitest'
import {
  MAX_EDGE,
  MAX_INPUT_BYTES,
  dataUrlToBlob,
  fitInside,
  looksLikeImage,
  normalizeImage,
  planFor,
  type DecodedImage,
  type ImageCodecs,
} from '@/lib/imageNormalize'

/* ══════════════════════════════════════════════════════════════
   图片格式归整（2026-09-28 真机 400 的回归）

   现场：用户贴图，上游直接回
     `You have uploaded an unsupported image. Please make sure your image is valid
      and has one of the following formats: webp, png, jpeg, and gif.`
   —— Windows 剪贴板里的截图常常是 **BMP**，而「选图片」那条路也允许 .bmp，
   我们两条路都原样发出去。

   判定逻辑（`planFor` / `fitInside`）是纯函数，这里直接钉；
   真机那条路（剪贴板 → canvas 转码 → 发出去）由
   `tmp/perf/probe-vision-e2e.cjs` 用真 BMP 走一遍 —— jsdom 里没有 canvas，
   所以解码/编码这两件事**注入**进来测。
   ══════════════════════════════════════════════════════════════ */

const blobOf = (type: string, bytes = 16): Blob => new Blob([new Uint8Array(bytes)], { type })

/** 假解码器：说这张图是 W×H，并记下有没有被 release */
function fakeCodecs(
  width: number,
  height: number,
  options: { decodedType?: string; fail?: boolean } = {},
): { codecs: ImageCodecs; released: () => boolean; encodeCalls: () => [number, number, string][] } {
  let released = false
  const encodeCalls: [number, number, string][] = []
  const decoded: DecodedImage = {
    width,
    height,
    source: {} as CanvasImageSource,
    release: () => {
      released = true
    },
  }
  return {
    codecs: {
      decode: async () => {
        if (options.fail) throw new Error('The source image could not be decoded.')
        return decoded
      },
      encode: async (_image, w, h, type) => {
        encodeCalls.push([w, h, type])
        return blobOf(type, 8)
      },
      toDataUrl: async (blob) => `data:${blob.type};base64,FAKE`,
    },
    released: () => released,
    encodeCalls: () => encodeCalls,
  }
}

describe('该透传还是该转（planFor）', () => {
  it('★ 白名单格式 + 尺寸合规 → 原样透传（不重新编码）', () => {
    const plan = planFor({ type: 'image/png', width: 800, height: 600, bytes: 1000 })
    expect(plan.mode).toBe('passthrough')
    expect(plan.type).toBe('image/png')
    expect(plan.reason).toBe('原样')
  })

  it('★ BMP → 转成 PNG（用户报的那个 400）', () => {
    const plan = planFor({ type: 'image/bmp', width: 800, height: 600, bytes: 1000 })
    expect(plan.mode).toBe('convert')
    expect(plan.type).toBe('image/png')
    expect(plan.reason).toContain('bmp → png')
  })

  it('JPEG 系继续用 JPEG（照片转 PNG 会变大）', () => {
    expect(planFor({ type: 'image/jpeg', width: 4000, height: 3000, bytes: 1 }).type).toBe(
      'image/jpeg',
    )
    /* 白名单里的 jpg 只是名字不同，别把它当"不支持" */
    const jpg = planFor({ type: 'image/jpg', width: 800, height: 600, bytes: 1 })
    expect(jpg.mode).toBe('convert')
    expect(jpg.type).toBe('image/jpeg')
  })

  it('mime 大小写 / 带参数都认（clipboard 给的串不规整）', () => {
    expect(planFor({ type: 'IMAGE/PNG', width: 10, height: 10, bytes: 1 }).mode).toBe('passthrough')
    expect(
      planFor({ type: 'image/png;charset=binary', width: 10, height: 10, bytes: 1 }).mode,
    ).toBe('passthrough')
  })

  it('★ 超长边 → 等比缩到 2048（原图直发一次就是几十万 token）', () => {
    const plan = planFor({ type: 'image/png', width: 4096, height: 2304, bytes: 1 })
    expect(plan.mode).toBe('convert')
    expect([plan.width, plan.height]).toEqual([MAX_EDGE, 1152])
    expect(plan.reason).toBe('4096×2304 → 2048×1152')
  })

  it('不支持 + 又超大 → 一次说清两件事', () => {
    const plan = planFor({ type: 'image/tiff', width: 8000, height: 4000, bytes: 1 })
    expect(plan.type).toBe('image/png')
    expect(plan.reason).toContain('tiff → png')
    expect(plan.reason).toContain('2048×1024')
  })

  it('fitInside：够小就不动，长边在宽/高上都算', () => {
    expect(fitInside(100, 50)).toEqual({ width: 100, height: 50 })
    expect(fitInside(1000, 4000)).toEqual({ width: 512, height: 2048 })
    expect(fitInside(2, 4000)).toEqual({ width: 1, height: 2048 })
  })
})

describe('归整一张图（normalizeImage）', () => {
  it('★ BMP 会被真的重新编码，并把结果当 data URL 交出来', async () => {
    const fake = fakeCodecs(1200, 800)
    const result = await normalizeImage(blobOf('image/bmp'), fake.codecs)
    expect(result.changed).toBe(true)
    expect(result.dataUrl.startsWith('data:image/png')).toBe(true)
    expect(fake.encodeCalls()).toEqual([[1200, 800, 'image/png']])
  })

  it('透传时不碰编码器（省一次重编码）', async () => {
    const fake = fakeCodecs(800, 600)
    const result = await normalizeImage(blobOf('image/png'), fake.codecs)
    expect(result.changed).toBe(false)
    expect(fake.encodeCalls()).toEqual([])
    expect(result.dataUrl.startsWith('data:image/png')).toBe(true)
  })

  it('缩放后的尺寸只有长边被压到 2048', async () => {
    const fake = fakeCodecs(6000, 3000)
    const result = await normalizeImage(blobOf('image/png'), fake.codecs)
    expect(fake.encodeCalls()).toEqual([[2048, 1024, 'image/png']])
    expect(result.reason).toBe('6000×3000 → 2048×1024')
  })

  it('解不开的格式（TIFF / HEIC）给人话，不发出去挨拒', async () => {
    const fake = fakeCodecs(100, 100, { fail: true })
    await expect(normalizeImage(blobOf('image/tiff'), fake.codecs)).rejects.toThrow(
      /TIFF 这个格式解不开.*先转成 PNG 或 JPG/,
    )
  })

  it('体积超限先说清楚，别去解码一个几十 MB 的 BMP', async () => {
    const fake = fakeCodecs(10, 10)
    const huge = blobOf('image/bmp', MAX_INPUT_BYTES + 1)
    await expect(normalizeImage(huge, fake.codecs)).rejects.toThrow(/图片太大/)
    /* 超限时连解码都不该发生 */
    const spy = vi.fn(fake.codecs.decode)
    await expect(normalizeImage(huge, { ...fake.codecs, decode: spy })).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('空文件直接拦（剪贴板偶尔给个空 blob）', async () => {
    const fake = fakeCodecs(10, 10)
    await expect(normalizeImage(blobOf('image/png', 0), fake.codecs)).rejects.toThrow(/是空的/)
  })

  it('转完把解码出来的资源还回去（大图不还就是漏内存）', async () => {
    const fake = fakeCodecs(8000, 6000)
    await normalizeImage(blobOf('image/bmp'), fake.codecs)
    expect(fake.released()).toBe(true)
  })
})

describe('两个小工具', () => {
  it('dataUrlToBlob：base64 与百分号编码都认（选图那条路给的是 data URL）', () => {
    const base64 = dataUrlToBlob('data:image/png;base64,QUJD')
    expect(base64.type).toBe('image/png')
    expect(base64.size).toBe(3)
    const plain = dataUrlToBlob('data:text/plain,hello')
    expect(plain.type).toBe('text/plain')
    expect(plain.size).toBe(5)
  })

  it('looksLikeImage：认 mime，也认扩展名（有的来源不给 type）', () => {
    expect(looksLikeImage({ type: 'image/bmp' })).toBe(true)
    expect(looksLikeImage({ name: '截图.BMP' })).toBe(true)
    expect(looksLikeImage({ name: 'note.txt', type: 'text/plain' })).toBe(false)
    expect(looksLikeImage({})).toBe(false)
  })
})

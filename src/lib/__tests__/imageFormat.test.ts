import { describe, expect, it } from 'vitest'
import { MAX_EDGE, fitInside, looksLikeImage, mimeOf, planFor, probeSize } from '@/lib/imageFormat'

/* ══════════════════════════════════════════════════════════════
   图片判定层（纯函数）：该不该转、缩到多少、这是啥格式

   这一层是两次真机 400 攒出来的：
     · 第一次「贴图被拒」—— Windows 剪贴板截图常是 **BMP**，而白名单只有
       webp/png/jpeg/gif；
     · 第二次「还是被拒」—— 上游对「尺寸离谱」和「格式不对」给的是**同一句**
       unsupported image，真凶是历史里一张 **14200×7104** 的旧图。
   ══════════════════════════════════════════════════════════════ */

/** 造一个真 PNG 头（够 `probeSize` 读出尺寸） */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) /* IHDR */
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 造一个真 JPEG 头：SOI 紧跟 SOF0（尺寸就在 SOF 里） */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(16)
  bytes.set([0xff, 0xd8], 0) /* SOI */
  bytes.set([0xff, 0xc0], 2) /* SOF0 */
  bytes.set([0x00, 0x11, 0x08], 4) /* 段长 17、精度 8 */
  const view = new DataView(bytes.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return bytes
}

describe('该透传还是该转（planFor）', () => {
  it('★ 白名单格式 + 尺寸合规 → 原样透传（不重新编码）', () => {
    const plan = planFor({ type: 'image/png', width: 800, height: 600, bytes: 1000 })
    expect(plan.mode).toBe('passthrough')
    expect(plan.type).toBe('image/png')
    expect(plan.reason).toBe('原样')
  })

  it('★ BMP → 转成 PNG（第一次真机 400）', () => {
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

  it('★ 超长边 → 等比缩到 2048（第二次真机 400 的那张 14200×7104）', () => {
    const plan = planFor({ type: 'image/jpeg', width: 14200, height: 7104, bytes: 1 })
    expect(plan.mode).toBe('convert')
    expect([plan.width, plan.height]).toEqual([MAX_EDGE, 1025])
    expect(plan.reason).toBe('14200×7104 → 2048×1025')
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

describe('从字节头认尺寸与格式', () => {
  it('PNG / JPEG 的尺寸读得出来（14200×7104 就是这么认出来的）', () => {
    expect(probeSize(pngBytes(1024, 768))).toEqual({ width: 1024, height: 768 })
    expect(probeSize(jpegBytes(14200, 7104))).toEqual({ width: 14200, height: 7104 })
  })

  it('认不出来的给 null（调用方再去真解码）', () => {
    expect(probeSize(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })

  it('来源不给 mime 时按魔数认（剪贴板有时候就这样）', () => {
    expect(mimeOf('', pngBytes(10, 10))).toBe('image/png')
    expect(mimeOf('', jpegBytes(10, 10))).toBe('image/jpeg')
    /* 声明了就用声明的，不篡改 */
    expect(mimeOf('image/webp', pngBytes(10, 10))).toBe('image/webp')
  })

  it('looksLikeImage：认 mime，也认扩展名', () => {
    expect(looksLikeImage({ type: 'image/bmp' })).toBe(true)
    expect(looksLikeImage({ name: '截图.BMP' })).toBe(true)
    expect(looksLikeImage({ name: 'note.txt', type: 'text/plain' })).toBe(false)
    expect(looksLikeImage({})).toBe(false)
  })
})

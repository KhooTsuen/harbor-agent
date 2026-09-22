import { deflateSync } from 'node:zlib'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { describe, expect, it } from 'vitest'
import sceneData from '@/assets/boot-scene/scene.b64?raw'
import { loadBootScene, parseBootScene, sceneStride } from '../bootScene'

/*
 * jsdom 既没有 DecompressionStream、Blob 也没有 stream()，而真 Electron 里两个都有。
 * 这里用 Node 的实现补上 —— 这样「base64 → zlib 解压 → 解析」整条链路在测试里
 * 都是真跑的，不是绕过解压只测解析。
 */
;(globalThis as { DecompressionStream?: unknown }).DecompressionStream ??= NodeDecompressionStream

/* ══════════════════════════════════════════════════════════════
   启动场景的解码

   这里最值钱的是一条**形状守卫**：数据头的字段顺序必须和生成脚本
   （`scripts/generate-boot-scene.py` 的 HEAD_FMT）一致。我第一版两边
   各写了一遍格式串，一边 5 个 B、一边 7 个 —— 差两个字节，解出来全是错的，
   而且不报错、只是画面全花。所以测试里自己按字节摆一份数据出来，
   跑通整条「base64 → zlib → 解析」链路。
   ══════════════════════════════════════════════════════════════ */

const CHARSET = ' .A'
const PALETTE = [0, 0, 0, 255, 255, 255]
const COVERAGE = [0, 40, 120]
const LAYERS = [1, 2, 2, 3] /* 天空 海面 海面 岛 */

/** 手摆一份合法数据（和生成脚本的头布局逐字段对应） */
function packScene(overrides: { magic?: string; version?: number; cells?: number[] } = {}) {
  const head = new Uint8Array(21)
  const view = new DataView(head.buffer)
  const magic = overrides.magic ?? 'HBS1'
  for (let i = 0; i < 4; i += 1) view.setUint8(i, magic.charCodeAt(i))
  let at = 4
  view.setUint8(at++, overrides.version ?? 3)
  view.setUint16(at, 2, true)
  at += 2 /* cols */
  view.setUint16(at, 2, true)
  at += 2 /* rows */
  view.setUint8(at++, 10) /* cellW */
  view.setUint8(at++, 18) /* cellH */
  view.setUint8(at++, 18) /* fontPx */
  view.setUint8(at++, 2) /* 调色板色数 */
  view.setUint8(at++, CHARSET.length)
  view.setUint16(at, 1, true)
  at += 2 /* 灯室列 */
  view.setUint16(at, 0, true)
  at += 2 /* 灯室行 */
  view.setUint8(at++, 8)
  view.setUint8(at++, 16)
  view.setUint8(at++, 30) /* 底色 */
  const cells = new Uint8Array(overrides.cells ?? [0, 0, 1, 1, 2, 1, 1, 0])
  return Buffer.concat([
    Buffer.from(head),
    Buffer.from(CHARSET, 'ascii'),
    Buffer.from(COVERAGE),
    Buffer.from(LAYERS),
    Buffer.from(PALETTE),
    Buffer.from(cells),
  ])
}

describe('boot scene decoding', () => {
  it('★ 整条链路：base64 → zlib → 网格都能读回来', async () => {
    const scene = await loadBootScene(deflateSync(packScene()).toString('base64'))
    expect(scene.cols).toBe(2)
    expect(scene.rows).toBe(2)
    expect(scene.cellW).toBe(10)
    expect(scene.cellH).toBe(18)
    expect(scene.fontPx).toBe(18)
    expect(scene.charset).toBe(CHARSET)
    expect(Array.from(scene.coverage)).toEqual(COVERAGE)
    expect(Array.from(scene.layer)).toEqual(LAYERS)
    expect(Array.from(scene.palette)).toEqual(PALETTE)
    /* 每格两个字节，按行优先：字符索引、颜色索引 */
    expect(Array.from(scene.glyph)).toEqual([0, 1, 2, 1])
    expect(Array.from(scene.color)).toEqual([0, 1, 1, 0])
    expect(scene.lampCol).toBe(1)
    expect(scene.lampRow).toBe(0)
    expect(scene.bg).toBe('rgb(8, 16, 30)')
  })

  it('数据头不对就报错（不能默默画出一片花）', () => {
    expect(() => parseBootScene(packScene({ magic: 'XXXX' }))).toThrow(/数据头/)
    expect(() => parseBootScene(packScene({ version: 2 }))).toThrow(/版本/)
    expect(() => parseBootScene(new Uint8Array(4))).toThrow(/太短/)
  })

  it('格子数据少一截也要报错', () => {
    /* 头 + 字符集 + 调色板齐了，但格子只给一半 */
    const full = packScene()
    const cut = full.subarray(0, full.length - 5)
    expect(() => parseBootScene(new Uint8Array(cut))).toThrow(/不完整/)
  })

  it('★ 按屏幕宽度决定是否隔点取（1080p 只画 1/4 的格子）', () => {
    expect(sceneStride(3840, 3840)).toBe(1)
    expect(sceneStride(3840, 1920)).toBe(2)
    /* 2K 屏：隔点取升到 2560，画 1920 的底子够用，不为了 384 列多花四倍力气 */
    expect(sceneStride(3840, 2560)).toBe(2)
  })
})

/*
 * 入库的那份数据本身。
 *
 * 这一组的价值在于：生成脚本改坏了、或者产物被别的分支覆盖成半成品，
 * 这里会直接红 —— 而不是等到启动页上出现一片花。
 */
describe('入库的场景数据（src/assets/boot-scene/scene.b64）', () => {
  it('能解开，而且规格和生成脚本一致', async () => {
    const scene = await loadBootScene(sceneData)
    expect([scene.cols, scene.rows]).toEqual([384, 120])
    expect([scene.cellW, scene.cellH]).toEqual([10, 18])
    expect(scene.fontPx).toBeGreaterThanOrEqual(scene.cellH - 2)
    expect(scene.charset).toHaveLength(95) /* 全部可打印 ASCII */
    expect(scene.coverage).toHaveLength(95) /* 每个字形的墨量 */
    expect(scene.layer).toHaveLength(scene.cols * scene.rows) /* 每格一层 */
    expect(Math.max(...scene.layer)).toBeLessThanOrEqual(7)
    expect(scene.palette.byteLength).toBeGreaterThan(0)
    expect(scene.palette.byteLength % 3).toBe(0)
  })

  it('★ 灯室坐标落在画面内（场景元数据：灯在哪里）', async () => {
    const scene = await loadBootScene(sceneData)
    expect(scene.lampCol).toBeGreaterThan(scene.cols * 0.2)
    expect(scene.lampCol).toBeLessThan(scene.cols * 0.8)
    expect(scene.lampRow).toBeGreaterThan(0)
    expect(scene.lampRow).toBeLessThan(scene.rows * 0.6)
  })

  it('★ 层掩码真的有海面（海面动画靠它）', async () => {
    const scene = await loadBootScene(sceneData)
    const { cols, rows } = scene
    let oceanCells = 0
    let islandCells = 0
    let firstOceanRow = rows
    for (let i = 0; i < cols * rows; i += 1) {
      if (scene.layer[i] === 2) {
        oceanCells += 1
        firstOceanRow = Math.min(firstOceanRow, (i / cols) | 0)
      } else if (scene.layer[i] === 3) {
        islandCells += 1
      }
    }
    expect(oceanCells).toBeGreaterThan(cols * rows * 0.15) /* 海面占了足够多 */
    expect(islandCells).toBeGreaterThan(0) /* 岛存在 */
    expect(firstOceanRow).toBeLessThan(rows * 0.6) /* 地平线在上半屏 */
  })

  it('★ 是真的字符画：字形与颜色都够丰富，索引不越界', async () => {
    const scene = await loadBootScene(sceneData)
    const total = scene.cols * scene.rows
    const paletteN = scene.palette.byteLength / 3
    let maxGlyph = 0
    let maxColor = 0
    const glyphs = new Set<number>()
    const colors = new Set<number>()
    for (let i = 0; i < total; i += 1) {
      maxGlyph = Math.max(maxGlyph, scene.glyph[i])
      maxColor = Math.max(maxColor, scene.color[i])
      glyphs.add(scene.glyph[i])
      colors.add(scene.color[i])
    }
    expect(maxGlyph).toBeLessThan(95)
    expect(maxColor).toBeLessThan(paletteN)
    /* 只有一两个字符就说明"丰富度"那一步白做了 */
    expect(glyphs.size).toBeGreaterThan(60)
    expect(colors.size).toBeGreaterThan(60)
  })
})

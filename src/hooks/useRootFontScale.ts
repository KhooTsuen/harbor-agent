import { useEffect, useState } from 'react'

/* ══════════════════════════════════════════════════════════════
   根字号倍率（Phase 4 · P4-3）

   「字号缩放」（设置里的 fontScale，80~150%）是把 `<html>` 的 font-size
   从 16px 改成 `16 * fontScale/100`（见 hooks/useApplyAppearance.ts）。
   界面上所有 rem 尺寸跟着它走 —— **但写死的 px 不跟**。

   右侧栏宽度就是这样一个写死的 px（默认 360）。于是 150% 时：标签
   （rem 尺寸）长大了，栏宽却没长 → 8 个标签有 1 个被挤出栏外、进而
   顶出文档横向滚动条（`p4-probe.mjs` 场景 E 实测：7/8 + hOverflow）。

   这里给出「当前根字号 ÷ 16」的倍率，让布局能按它等比缩放。
   默认缩放（100%）时它恰好等于 1，所以显示的宽度与改动前**逐像素一致**。

   ★ 为什么从**实际根字号**（getComputedStyle）推，而不是读 settings.fontScale：
     真相源是「`<html>` 上真正生效的 font-size」。无论它是被 useApplyAppearance
     设的、还是别处（真机验收脚本、开发者工具）直接写的，这里都跟得上。
   ══════════════════════════════════════════════════════════════ */

/** 基准根字号（100% 缩放时 `<html>` 的 font-size） */
const BASE_PX = 16

/**
 * 根字号像素值 → 倍率（纯函数，便于单测）。
 *
 * 拿不到 / 非法 / 离奇的值一律退回 1（不缩放）——
 * 布局宁可「按原样」也不能被一个坏值放大到撑爆窗口。
 */
export function scaleFromRootPx(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 1
  const scale = px / BASE_PX
  /* 0.5x ~ 3x 之外当作噪声（真机 fontScale 只到 80~150%） */
  if (scale < 0.5 || scale > 3) return 1
  return scale
}

/** 读当前 `<html>` 的根字号倍率（非浏览器环境返回 1） */
export function readRootScale(): number {
  if (typeof document === 'undefined') return 1
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return scaleFromRootPx(px)
}

/**
 * 订阅根字号倍率。
 *
 * 根字号是**内联 style**（`root.style.fontSize = ...`），所以监听
 * `<html>` 的 `style` 属性变化就够；`resize` 是兜底（系统 DPI / 缩放变动）。
 * 值没变时不 setState（避免无谓重渲）。
 */
export function useRootFontScale(): number {
  const [scale, setScale] = useState<number>(() => readRootScale())

  useEffect(() => {
    const update = (): void =>
      setScale((prev) => {
        const next = readRootScale()
        return next === prev ? prev : next
      })
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  return scale
}

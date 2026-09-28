/**
 * 第 8 项检查：**仓库卫生**（根目录别堆、临时目录别膨胀）
 *
 * 为什么是警告不是错误：这是**趋势**指标，不是「代码坏了」。
 * 但它必须有人看着 —— 2026-09-29 这次整理之前，`tmp/` 攒到了
 * 700+ 项 / 759 MB（光三份没人引用的隔离副本就有 363.7 MB），
 * 而**没有任何测试会报出来**：临时目录不参与 tsc、不参与单测。
 *
 * 阈值写在下面一处，改就改这里（别在文档里再抄一份数字）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 阈值：现在多少 → 到多少该动手（留了余量，不是刚好卡住） */
export const LIMITS = {
  rootEntries: 60, // 仓库根目录项数（2026-09-29 整理后：44）
  tmpEntries: 500, // tmp/ 根下项数（整理后：380）
  tmpMb: 1500, // tmp/ 总体积 MB（整理后：397，其中隔离副本 391）
}

const entries = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

const sizeMb = (dir) => {
  let bytes = 0
  const walk = (d) => {
    for (const entry of entries(d) ?? []) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          bytes += fs.statSync(full).size
        } catch {
          /* 删了就跳过 */
        }
      }
    }
  }
  walk(dir)
  return bytes / 1048576
}

export function checkHygiene(root, limits = LIMITS) {
  const warnings = []

  const rootItems = entries(root)
  if (rootItems === null) return { errors: [], warnings: ['读不了仓库根目录'], summary: '跳过' }
  /* 隐藏目录（.git 等）也算：它们同样是「根目录里的一项」，同样会让人找不着东西 */
  const rootCount = rootItems.length
  if (rootCount > limits.rootEntries) {
    warnings.push(
      `仓库根目录 ${rootCount} 项（上限 ${limits.rootEntries}）—— 新增文件尽量进 src/ electron/ scripts/ docs/，别堆在根上`,
    )
  }

  const tmp = path.join(root, 'tmp')
  const tmpItems = entries(tmp)
  if (tmpItems === null) {
    return { errors: [], warnings, summary: `根 ${rootCount} 项（没有 tmp/，跳过临时目录部分）` }
  }

  const tmpCount = tmpItems.length
  if (tmpCount > limits.tmpEntries) {
    warnings.push(
      `tmp/ 根下 ${tmpCount} 项（上限 ${limits.tmpEntries}）—— 跑 node tmp/organize2.cjs 看该收哪些，--apply 真收`,
    )
  }

  const mb = sizeMb(tmp)
  if (mb > limits.tmpMb) {
    warnings.push(
      `tmp/ 体积 ${mb.toFixed(0)} MB（上限 ${limits.tmpMb} MB）—— 大件（隔离副本、发布包、旧 log）是不是又攒了？`,
    )
  }

  return {
    errors: [],
    warnings,
    summary: `根 ${rootCount} 项 · tmp/ ${tmpCount} 项 / ${mb.toFixed(0)} MB`,
  }
}

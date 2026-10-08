/**
 * 页面操作脚本（snapshot / 落点 / 聚焦）—— `electron/core/browse-ops.cjs`
 *
 * B3（2026-10-09）把这三个脚本从渲染层搬到主进程（经 CDP 执行）。
 * 脚本的**行为**（jsdom 里 eval 真跑：密码不外泄、遮挡拒绝、跨页校验）留在
 * vitest（`src/components/layout/browser/__tests__/scripts.test.ts`，现在 import 本模块）。
 * 这里只钉子「纯 Node 能验的部分」：导出齐全、共用同一份遍历、toIndex 边界。
 */
import { createRequire } from 'node:module'
import { ROOT, join } from '../env.mjs'
import { check, group } from '../harness.mjs'

const require = createRequire(import.meta.url)

export async function run() {
  group('页面操作脚本 / browse-ops（主进程经 CDP）')

  const ops = require(join(ROOT, 'electron/core/browse-ops.cjs'))

  check(
    '导出脚本与构造器',
    typeof ops.SNAPSHOT_SCRIPT === 'string' &&
      typeof ops.clickPointScript === 'function' &&
      typeof ops.focusScript === 'function' &&
      typeof ops.toIndex === 'function',
  )
  check(
    '★ 三种脚本共用同一份遍历（否则「第 N 个元素」两边对不上）',
    ops.SNAPSHOT_SCRIPT.includes('__walkInteractive') &&
      ops.clickPointScript(0).includes('__walkInteractive') &&
      ops.focusScript(0).includes('__walkInteractive'),
  )
  check(
    '选择器里含按钮 / 链接 / 输入 / contenteditable',
    ['button', 'input', 'a', 'contenteditable'].every((t) => ops.INTERACTIVE_SEL.includes(t)),
  )

  /* toIndex：0 不能掉进 `|| -1` 的坑（真机踩过 browse_click(0) 全挂） */
  check('★ toIndex(0) === 0（0 是 falsy，别被 || 吃掉）', ops.toIndex(0) === 0 && ops.toIndex('0') === 0)
  check('toIndex 正常/非法', ops.toIndex(5) === 5 && ops.toIndex('12') === 12 && ops.toIndex(-1) === -1 && ops.toIndex('x') === -1 && ops.toIndex(1.5) === -1)

  /* 脚本只算落点 / 聚焦，不自己点、不自己写字（真事件在主进程） */
  check(
    '★ 脚本不合成点击/输入（真事件由主进程派发）',
    !ops.clickPointScript(0).includes('target.click()') &&
      !ops.focusScript(0).includes('dispatchEvent'),
  )
  check(
    '★ 密码框默认不放行（没授权就 needsConfirm）',
    ops.focusScript(0, false).includes('needsConfirm: true') &&
      ops.focusScript(0, true).includes('var authorized = true'),
  )
  check(
    '★ 跨页/换元素校验挂在 window 快照键上',
    ops.SNAPSHOT_SCRIPT.includes('window.__harborSnapEls') &&
      ops.clickPointScript(0).includes('window.__harborSnapEls'),
  )
}

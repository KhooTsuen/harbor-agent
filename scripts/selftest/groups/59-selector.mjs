import { join, readFileSync, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   selector 的稳定性（防"循环取数据"）

   真机日志流水里冒出来的第一个"没预料到的事"：`fs:tree` 同一秒成对出现、
   每次 60~700ms。根因是 `RightPanel` 里那个 selector **每次读都新建对象** ——
   zustand 默认用 `Object.is` 比结果，于是每次 store 有任何变动都算"变了"，
   组件重渲染、`useEffect([effectiveProject])` 跟着又跑一遍取目录树。

   修完实测：空闲 15 秒里 `fs:tree` 只被调 4 次（都在启动那一下），
   之前是同一秒里几十对。

   这一组钉住修法（这种 bug 单测很难照到 —— 它是"渲染次数"层面的）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('selector 稳定性 / 不许每次读都新建对象')
  const src = readFileSync(join(ROOT, 'src/components/layout/RightPanel.tsx'), 'utf8')
  check(
    '★ 合成对象的 selector 包了 useShallow',
    src.includes('useShallow((s) => {') && src.includes("from 'zustand/react/shallow'"),
  )
  check(
    '★ 取目录树那个 effect 依赖的是原始值（path），不是整个对象',
    src.includes('effectiveProject?.path]'),
  )
  check('不拿整个对象当依赖（改回去会红）', !src.includes('}, [effectiveProject])'))
}

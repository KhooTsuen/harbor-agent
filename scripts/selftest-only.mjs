/**
 * 只跑指定的几组自检（**调试用**，不进 verify 链）
 *
 *   set HARBOR_UNIT_TEST=1&& node scripts/selftest-only.mjs 193 194
 *
 * ⚠️ 必须带 `HARBOR_UNIT_TEST=1`。原因（这一条踩过，写清楚免得再踩）：
 *   `paths.cjs` 判定「是不是自检」靠的是**入口脚本路径** `scripts/selftest.mjs`，
 *   这个文件的路径不是它 → `DIRS.data` 会解析成**用户的真数据根** `data/`。
 *   第一版没带这个环境变量，`prepareSelftest()` 差点把真 `data/` 删掉
 *   （被文件占用挡成 EPERM，纯属运气）。所以现在：
 *     ① 没有 `HARBOR_UNIT_TEST=1` 就直接拒跑；
 *     ② **不调** `prepareSelftest()` / `cleanupSelftest()` —— 那是全量自检的事，
 *        这里只跑指定组，不删任何目录。
 *
 * 为什么要有它：`npm test` 是完整链（几千项、几分钟），改一组时反复跑全量太慢。
 * 它不写第二套判据：同一个 harness、同一个隔离数据根（`data/unit-test-data`）。
 */
import { report } from './selftest/harness.mjs'
import { GROUPS } from './selftest/groups.mjs'

if (process.env.HARBOR_UNIT_TEST !== '1') {
  console.error('拒跑：必须设 HARBOR_UNIT_TEST=1（否则会落到用户的真 data 目录）。')
  console.error('  cmd:  set HARBOR_UNIT_TEST=1&& node scripts/selftest-only.mjs 193')
  process.exit(2)
}

const want = process.argv.slice(2)
if (want.length === 0) {
  console.log('用法：node scripts/selftest-only.mjs <编号前缀...>   例：node scripts/selftest-only.mjs 193 194')
  process.exit(2)
}

/* GROUPS 里只有函数、没有名字 —— 按 groups.mjs 的 import 顺序建「编号 → 名字」再对下表 */
const fs = await import('node:fs')
const file = new URL('./selftest/groups.mjs', import.meta.url)
const src = fs.readFileSync(file, 'utf8')
const imported = [...src.matchAll(/import \{ run as (\w+) \} from '\.\/groups\/([\w-]+)\.mjs'/g)].map((m) => ({
  name: m[1],
  file: m[2],
}))
const names = (src.match(/export const GROUPS = \[([\s\S]*?)\n\]/)?.[1] ?? '')
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean)

const picked = names
  .map((name, index) => ({ name, index }))
  .filter(({ name }) => {
    const entry = imported.find((item) => item.name === name)
    return entry && want.some((prefix) => entry.file.startsWith(prefix))
  })

if (picked.length === 0) {
  console.log(`没有匹配到任何组：${want.join(', ')}`)
  process.exit(2)
}

for (const { name, index } of picked) {
  console.log(`\n===== ${name}（GROUPS[${index}]）=====`)
  await GROUPS[index]()
}
process.exit(report())

import { join, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   版本号 / 会飘的数字

   用户反馈：「每次更新之后，README 这一块的版本号总是没跟上」。
   这类问题的根子不是"忘了改一次"，而是**同一个数字被抄在好几个地方**，
   改一处必然漏几处。

   所以这里钉两件事：

   ① `package.json` 与 `CHANGELOG` 的第一条标题必须一致
      —— 这两处是发布流程真正会读的（打包脚本读 package.json，人看 CHANGELOG），
        对不上就说明有一处忘了改。

   ② README 里**要么不写版本号，写了就必须跟 package.json 一致**；
      并且不写"测试有多少项"这种每版都会变的数字
      （以前写着「内核自检 1580+ 项 / 前端 470+ 项」，实际早就 1691 / 568 了）。
      要写数量就指向 CI，别抄数字 —— 抄了就会飘。
   ══════════════════════════════════════════════════════════════ */

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('版本号与 README：抄来的数字会飘')

  const version = JSON.parse(read('package.json')).version
  check('package.json 有版本号', typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version))

  const changelogTop = read('CHANGELOG.md').match(/^## \[([^\]]+)\]/m)
  check('★ CHANGELOG 第一条标题的版本与 package.json 一致', changelogTop?.[1] === version)
  if (changelogTop && changelogTop[1] !== version) {
    check(`（package.json=${version}，CHANGELOG=${changelogTop[1]}）`, false)
  }

  const readme = read('README.md')
  /* README 里出现的所有 x.y.z（要的话就在下面报错）—— 一个都不写也算通过 */
  const mentioned = [...readme.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)].map((m) => m[1])
  check(
    `★ README 里如果写了版本号，必须等于 package.json（当前写了 ${mentioned.length} 处）`,
    mentioned.every((v) => v === version),
  )
  if (mentioned.some((v) => v !== version)) {
    check(`（README 里写着：${[...new Set(mentioned)].join(' / ')}，实际 ${version}）`, false)
  }

  /*
   * 不许在 README 里抄「测试有多少项」。
   * 允许写"几千条以上""3 个"这类不会因为加测试就变的说法 —— 只抓 "N 项" 这种。
   */
  const counts = [...readme.matchAll(/(\d+\+?\s*项)/g)].map((m) => m[1])
  check(
    `★ README 里不抄测试项数（抓到：${counts.join(' / ') || '无'}）`,
    counts.length === 0,
  )

  check(
    '★ README 里不写 npm audit 的条数（那种结论一发版就过期）',
    !/audit[^\n]{0,20}报\s*\d+\s*条/.test(readme),
  )
}

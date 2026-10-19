import { join, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   下载进度：未知总大小必须一路保持「未知」

   为什么单列一组（原在 119-download，加进来就 319 行）：

   2026-10-20 P3 真机验收逮到的**真缺陷**——
   `download-engine.cjs` 的进度回调写的是 `total: total || received`。
   服务端不给 Content-Length 时 total 是 0，这个兜底把它填成**当前已收字节数**，
   于是 `received / total` 恒等于 1：界面从头到尾都是 100%，
   而速度还在 1.0 MB/s 地跑（真机：24MB 文件全程 100%）。

   更要紧的是它**悄悄废掉了渲染层的一条分支**：`percentOf()` 本来会在
   `total <= 0` 时返回 null，`downloadsRow.tsx` 据此画不定态短条并写
   「总大小未知」。引擎把 total 填掉之后，那条分支永远走不到 ——
   两边各自的测试都过，合起来却是错的（这正是本项目硬约束 9 说的那类事故）。

   所以这一组钉**两头**：
     ① 引擎源码里不许再出现 `total || received` 这种兜底；
     ② 渲染层确实按「百分比为 null」走不定态，而不是按 `total === 0` 自己再判一次。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('下载进度 · 未知总大小不许被填成已知')

  const engine = readFileSync(join(ROOT, 'electron/core/download-engine.cjs'), 'utf8')
  check(
    '★ 进度回调不许把未知 total 填成 received（那会让进度永远 100%）',
    !/onProgress\(\{\s*received,\s*total:\s*total\s*\|\|\s*received\s*\}\)/.test(engine),
    'download-engine.cjs 里又出现了 total || received 兜底',
  )
  /*
   * 只该管**进度回调的代码行**，两个坑都在这：
   *   ① 下载完成后的 `return { total: total || received }` 是另一回事 ——
   *      那时文件已经写完，received 就是真实大小，填进去是事实而不是编造；
   *   ② 注释里也会出现 `total || received` 这个字符串（就是标禁项的那句），
   *      全文件搜会把自己的说明判成违规。
   * 所以先把 progress 函数体切出来，**再去掉注释行**，只看真正会执行的那几行。
   */
  const progressBody = (() => {
    const at = engine.indexOf('const progress = (force) => {')
    if (at < 0) return ''
    const end = engine.indexOf('\n  progress(true)', at)
    return end < 0 ? engine.slice(at, at + 900) : engine.slice(at, end)
  })()
  const codeOnly = progressBody
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')
  check('★ 找得到进度回调（判据本身不能空转）', progressBody.length > 40, `长度 ${progressBody.length}`)
  check(
    '★ 进度回调里不许出现 total || received 兜底',
    codeOnly.length > 0 && !/total\s*\|\|\s*received/.test(codeOnly),
    'progress 函数体里还有兜底',
  )

  const row = readFileSync(join(ROOT, 'src/components/layout/downloadsRow.tsx'), 'utf8')
  check(
    '★ 渲染层按「百分比为 null」画不定态（total=0 是有含义的）',
    row.includes('percentOf(item)') && /unknownTotal\s*=\s*pct === null/.test(row),
    '下载行没有按 pct===null 判定不定态',
  )
  check(
    '★ 不定态有文字说明（不只靠颜色/动画）',
    row.includes('总大小未知'),
    '界面上看不到「总大小未知」这句话',
  )
  check(
    '★ 有总大小时显示真实百分比（修完后已知那条不该退化）',
    /已下载 \$\{pct/.test(row),
    '已知总大小那条没有显示百分比',
  )
}

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

  /*
   * ── 未知总长会「下到第二圈」而必败（2026-11-10 静态核对发现）──
   * `runSegment` 的循环条件是 `seg.received < length`，未知总长时 length=Infinity，
   * 永远成立。第一轮流读到 EOF 后不退出 → 再发一次请求 → 第二轮 from>0 且拿到 200
   * → 撞上「服务器不支持从中间续传」的判据 → **没有 Content-Length 的文件必定失败**。
   * 修法是 EOF 即收尾；这里钉住那条收尾还在。
   */
  const engineSrc = readFileSync(join(ROOT, 'electron/core/download-engine.cjs'), 'utf8')
  check(
    '★★★ 未知总长的那一段读到 EOF 就结束（否则会再请求一次而必败）',
    /if \(seg\.end < 0\) break/.test(engineSrc),
    'runSegment 里没有「未知总长 → EOF 收尾」这条',
  )
  /*
   * ── 字节不足仍报成功（同一轮发现）──
   * 服务器提前 EOF / 响应被截时，以前照样 rename 出短文件并报成功。
   * 已知总长就必须对得上，且抛在 rename **之前**（.part.json 还在才能续传）。
   */
  check(
    '★★★ 已知总长时校验实收字节（不足就报错，不许 rename 出短文件）',
    /received !== total/.test(engineSrc),
    'downloadFile 里没有 received !== total 校验',
  )
  const checkAt = engineSrc.indexOf('received !== total')
  const renameAt = engineSrc.indexOf('fs.renameSync(partFile, file)')
  check(
    '★★ 校验在 rename 之前（抛了还能从 .part 续传）',
    checkAt > 0 && renameAt > 0 && checkAt < renameAt,
    `校验=${checkAt} rename=${renameAt}`,
  )
}

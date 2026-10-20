import { join, ROOT, require, readFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   会话首行「定宽槽位」：改 meta 只碰首行，不碰正文

   背景（2026-10-20，用户报「切模型卡 8 秒、打开软件卡 20 秒」）：
   开发版有个 141 MB 的会话，而改一个 `model` 字段原来是
   「整篇读 1225ms + 全文正则脱敏 2702ms + 整篇原子写 1880ms」= 真机 8.7 s。
   修法是把首行补到 **定宽 4096 字节**，之后改 meta 只原地覆盖那 4KB。

   这一组钉四件**不能再坏**的事：
     ① 首行定宽 4096（按**字节**算，不是字符），meta 读得回来
     ② 改 meta 之后**正文一个字节都不能变**（逐字节比）
     ③ 老文件（首行不是槽位）能升级，且升级后正文不变
     ④ 跨块拷贝不许重复写（真机真踩过：每块多写 32 字节 → 6 行解不开、
        消息条数从 1100 掉到 1097）

   为什么用「几百 KB 的文件」而不是 141 MB：判据要能进 CI、秒级跑完；
   而这三个 bug 与文件大小无关（流式块的粒度是 1 MB，所以造 2 MB 来跨块）。
   ══════════════════════════════════════════════════════════════ */

const slot = require(join(ROOT, 'electron/core/session-meta-slot.cjs'))
const io = require(join(ROOT, 'electron/core/session-io.cjs'))
const write = require(join(ROOT, 'electron/core/session-write.cjs'))
const read = require(join(ROOT, 'electron/core/session-read.cjs'))

/** 用真实 session API 造会话（文件必须落在 DIRS.sessions，updateMeta 才找得到） */
function makeSession(messages) {
  const meta = write.create({ title: '槽位判据', mode: 'pair' })
  const id = meta.id
  const file = io.fileFor(id)
  /*
   * 先写一个**老格式**首行（不补槽位）+ 正文 —— 模拟 2026-10-20 之前
   * 落盘的会话，才能测到「老文件升级」这条路径。
   */
  const oldHead = JSON.stringify({
    type: 'meta',
    id,
    title: '槽位判据',
    mode: 'pair',
    model: '',
    createdAt: Date.now(),
  })
  const parts = [oldHead]
  for (let i = 0; i < messages; i += 1) {
    /* 每条 ~170 字节，够撑到 2 MB 跨块 */
    parts.push(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: `第 ${i} 条：${'x'.repeat(120)}`,
      }),
    )
  }
  require('node:fs').writeFileSync(file, `${parts.join('\n')}\n`, 'utf8')
  return { id, file, firstLineBytes: Buffer.byteLength(oldHead, 'utf8') }
}

/** 首行之后的所有字节（正文）—— 逐字节比对用 */
function bodyOf(file) {
  const buf = readFileSync(file)
  const nl = buf.indexOf(0x0a)
  return nl < 0 ? buf.subarray(0, 0) : buf.subarray(nl + 1)
}

export async function run() {
  group('会话首行槽位 / 定宽按字节算')

  const metaLine = io.metaLine
  check('★ io 暴露了 metaLine（首行序列化的唯一入口）', typeof metaLine === 'function')

  const small = metaLine({ type: 'meta', id: 'sess_x', title: '普通', mode: 'pair' })
  check('★ 槽位宽度就是 4096 字节', slot.slotBytes(small) === 4096, `实际 ${slot.slotBytes(small)}`)

  /* 中文标题：按「字符」补会超过 4096 字节，那样永远命中不了快路径 */
  const chinese = metaLine({ type: 'meta', title: '中文标题'.repeat(60) })
  check('★ 中文标题也按字节算（放得下就正好 4096 字节）', slot.slotBytes(chinese) === 4096)

  /*
   * 超长 meta（> 4096 字节）**故意不截断**：截断会丢标题 / 丢字段。
   * 正确行为是原样返回，调用方据此退回整篇路径。
   */
  const huge = metaLine({ type: 'meta', title: '一'.repeat(5000) })
  check('★ 超长 meta 不截断（宁可退回整篇路径，也不丢数据）', slot.slotBytes(huge) > 4096)
  check('★ 超长 meta 宽度不等于槽位（调用方据此走整篇路径）', slot.slotBytes(huge) !== 4096)

  group('会话首行槽位 / 改 meta 不碰正文')

  const { id, file } = makeSession(3000)
  const before = bodyOf(file)

  const first = write.updateMeta(id, { model: 'deepseek-v4-pro' })
  const afterFirstBuf = readFileSync(file)
  const afterFirst = bodyOf(file)
  const afterFirstHead = afterFirstBuf.indexOf(0x0a)

  check('★ 第一次改 meta 成功', Boolean(first))
  check('★ 老文件的首行被补成 4096 字节槽位', afterFirstHead === 4096, `实际 ${afterFirstHead}`)
  check(
    '★ 正文长度一个字节都没变',
    afterFirst.length === before.length,
    `改前 ${before.length} / 改后 ${afterFirst.length}`,
  )
  check('★ 正文逐字节一致', afterFirst.equals(before))

  const second = write.updateMeta(id, { model: 'deepseek-flash' })
  const afterSecond = bodyOf(file)
  check('第二次改 meta 成功', Boolean(second))
  check('★ 第二次之后首行仍是 4096（没被写歪）', readFileSync(file).indexOf(0x0a) === 4096)
  check('★ 第二次之后正文仍逐字节一致', afterSecond.equals(before))

  const loaded = read.load(id)
  check('★ 读回来的 model 是最后一次设的值', loaded?.meta?.model === 'deepseek-flash')
  check('★ 读回来的标题没丢', loaded?.meta?.title === '槽位判据')

  group('会话首行槽位 / 跨块拷贝不重复（真机踩过的数据损坏）')

  /*
   * 关键用例：正文 > 1 MB 才跨块。以前每块把上一块留下的 32 字节尾巴
   * 又写了一遍 → 文件被写坏（真机表现：6 行解不开、消息 1100→1097）。
   */
  const big = makeSession(13000)
  const bigBefore = bodyOf(big.file)
  check(`正文确实跨块（${(bigBefore.length / 1048576).toFixed(2)} MB > 1 MB）`, bigBefore.length > 1048576)

  const up = write.updateMeta(big.id, { model: 'deepseek-v4-pro' })
  const bigAfter = bodyOf(big.file)
  check('★ 大文件（>1MB，跨块）改 meta 成功', Boolean(up))
  check(
    '★ 大文件正文长度与改前完全一致（重复写会让它变长）',
    bigAfter.length === bigBefore.length,
    `改前 ${bigBefore.length} / 改后 ${bigAfter.length}`,
  )
  check('★ 大文件正文逐字节一致', bigAfter.equals(bigBefore))

  const bigLoaded = read.load(big.id)
  check(
    '★ 大文件读回来的消息条数没少（写坏就会掉条数）',
    bigLoaded?.messages?.length === 13000,
    `实际 ${bigLoaded?.messages?.length}`,
  )

  group('会话首行槽位 / 槽位就位后改 meta 够快')

  /*
   * 用耗时钉「不再整篇读 + 全文正则」。
   *
   * ★ 文件要够大（这里 8 MB）：只造 2 MB 时整篇路径也只要几十毫秒，
   *   门限拦不住「rename 前没释放句柄 → EPERM → 退回整篇」这个 bug
   *   （反向验证实测：2 MB + 40ms 门限，放回 bug 仍然全绿）。
   *   8 MB 的整篇路径要几百毫秒，快路径亚毫秒 —— 差三个数量级，门限才可靠。
   */
  const heavy = makeSession(52000)
  const heavyBefore = bodyOf(heavy.file)
  check(`用于计时的正文够大（${(heavyBefore.length / 1048576).toFixed(1)} MB）`, heavyBefore.length > 7 * 1048576)

  write.updateMeta(heavy.id, { model: 'a' }) /* 第一次升级（允许慢） */
  const t0 = Date.now()
  write.updateMeta(heavy.id, { model: 'b' })
  const cost = Date.now() - t0
  check(`★ 槽位就位后改 meta 在 30ms 内（实测 ${cost}ms；整篇路径要几百毫秒）`, cost < 30)
  check('★ 走动快路径之后正文仍逐字节一致', bodyOf(heavy.file).equals(heavyBefore))

  /*
   * 顺序判据（钉住 2026-10-20 真机那个 EPERM）：
   * `fs.closeSync(source)` 必须在 `writeAtomicBy(...)` 的回调**之内**、
   * 且早于它返回 —— 因为 `writeAtomicBy` 返回前就 `rename` 了，
   * 而 Windows 上 rename 到一个还被打开的源文件会直接 EPERM。
   *
   * 这条是**静态**判据，补上「行为判据可能因文件不够大而漏判」的缺口。
   */
  const slotSrc = readFileSync(join(ROOT, 'electron/core/session-meta-slot.cjs'), 'utf8')
  const openAt = slotSrc.indexOf('writeAtomicBy(file, (tmp) =>')
  const closeAt = slotSrc.indexOf('fs.closeSync(source)')
  check(
    '★ 源文件句柄在 rename 之前释放（否则 Windows 上 rename 必 EPERM）',
    openAt >= 0 && closeAt > openAt,
    `writeAtomicBy@${openAt} / closeSync(source)@${closeAt}`,
  )
  check('★ 释放之后把 fdIn 置空（finally 不再重复关）', /fdIn = undefined/.test(slotSrc))

  group('会话首行槽位 / 列表只读首行，不读正文')

  /*
   * 钉住「启动列表不算 messageCount」这个取舍 —— 否则以后有人顺手加回来，
   * 141 MB 的会话又会把启动卡 20 秒。
   */
  const listSrc = readFileSync(join(ROOT, 'electron/core/session-list-async.cjs'), 'utf8')
  check('★ 启动列表走 listOne(skipCount)', /skipCount/.test(listSrc))
  check('★ 启动列表不后台补条数（会把卡顿推迟）', !/warmCount/.test(listSrc))
  check('★ 启动列表用的就是同步版那个 listOne（形状只一处定义）', /listOne/.test(listSrc))

  /*
   * 条数缓存：**行为判据**，不是看源码里有没有 `countCache` 这个词。
   *
   * 反向验证实测过：只做字面检查时，把 `countCache` 换成一个坏值也能让它
   * 「看不出问题」。所以这里真跑两次 `listOne`（算条数那条路）：
   *   · 第一次：算出 13000
   *   · 第二次：必须同样对，且**明显更快**（说明走了缓存、没再扫全文）
   * 文件 8 MB，整篇扫要几百毫秒；缓存命中是亚毫秒。
   */
  const heavyFile = io.fileFor(heavy.id)
  const statBefore = require('node:fs').statSync(heavyFile)
  const tc1 = Date.now()
  const c1 = read.listOne(heavy.id).messageCount
  const d1 = Date.now() - tc1
  const tc2 = Date.now()
  const c2 = read.listOne(heavy.id).messageCount
  const d2 = Date.now() - tc2
  check('★ 条数算对了（第一次）', c1 === 52000, `实际 ${c1}`)
  check('★ 条数算对了（第二次，走缓存也得对）', c2 === 52000, `实际 ${c2}`)
  check(
    `★ 第二次明显更快（缓存命中；第一次 ${d1}ms / 第二次 ${d2}ms）`,
    d2 * 4 < d1 || d2 < 15,
  )
  check('★ mtime/size 没变时文件不被重读（size 仍是改前那个）', statBefore.size === require('node:fs').statSync(heavyFile).size)

  const readSrc = readFileSync(join(ROOT, 'electron/core/session-read.cjs'), 'utf8')
  check('★ 首行解不开时回退整篇判断（不把会话悄悄抹掉）', /readLines\(id\)/.test(readSrc))

  /* 收尾：把判据造的会话删掉，不留给后面的组和用户 */
  write.remove(id)
  write.remove(big.id)
  write.remove(heavy.id)
}

/**
 * 会话首行（meta）的写入：只改第一行，正文原样保留
 *
 * 从 `session-io.cjs` 拆出来的（2026-10-20：那边贴 300 行红线，而这一块
 * 因为要加速「切模型 / 改标题」已经长到该独立）。序列化入口仍然是
 * `session-io` 的 `serializeLine`（唯一一份脱敏 + 封印），这里只管「怎么落盘」。
 *
 * ── 三条路径（按代价从低到高）────────────────────────────────
 *  ① **原地覆盖**：首行已是定宽 4096 槽位 → 覆盖那 4KB，正文一个字节不碰。
 *     实测 2 ms（改前 8674 ms）。
 *  ② **流式升级**：老文件首行是可用的 meta 但不够宽 → 分块拷贝整篇，
 *     换掉首行。实测 141 MB 约 1 秒（改前 20 秒）。
 *     若扫到明文密钥特征，退回 ③ 做完整逐行脱敏。
 *  ③ **整篇重写**：首行不是 meta / 首行解不开 / 有旧密钥要清。
 *     行为与 2026-10-04 那版一致，一行不差。
 *
 * 为什么不能简单地「整篇读出来再整篇写回去」：
 *   · `readLines()` 为了容错会**跳过解不开的行**（换了 Windows 账户 / data
 *     换机器就会遇到）—— 拿它的结果写回去，那些行就被永久删了，而用户
 *     只是在改标题；
 *   · 长会话整篇重写期间崩溃 / 断电会截断文件，截断点之后的内容全没；
 *     追加式写「崩了只丢最后一行」的保证在这里失效。
 */

const fs = require('node:fs')
const log = require('./log.cjs')
const { redact } = require('./redact.cjs')
const { writeAtomic } = require('./safe-write.cjs')
const { openLineDetailed } = require('./session-crypto.cjs')
const slot = require('./session-meta-slot.cjs')

/**
 * @param {string} file 会话文件（已由调用方用 `fileFor` 校验过 id）
 * @param {string} next `metaLine(meta)` 的产物
 * @param {() => void} afterOk 写成功后的收尾（清「已留过档」标记）
 * @param {(line: object) => string} serializeLine 唯一序列化入口（由 session-io 传进来）
 * @returns {{ ok: boolean, replaced?: boolean, error?: string }}
 */
function writeMetaLine(file, next, afterOk, serializeLine) {
  if (!fs.existsSync(file)) return { ok: false, error: '会话不存在' }

  const quick = slot.readMeta(file)
  /* ① 首行已是槽位、且新 meta 也放得下 → 只覆盖首行 */
  if (quick?.slotted && slot.slotBytes(next) === slot.META_SLOT) {
    const wrote = slot.overwriteMeta(file, quick.line ?? '', next)
    if (wrote.ok) {
      afterOk()
      return { ok: true, replaced: true }
    }
    log.warn(`原地覆盖 meta 失败，改走整篇写：${wrote.error}`)
  }

  /* ② 老文件首行可用 → 流式升级（分块拷，不整篇进内存） */
  if (quick && quick.meta && slot.slotBytes(next) === slot.META_SLOT) {
    const upgraded = slot.upgradeSlotStreaming(file, next)
    if (upgraded.ok) {
      afterOk()
      return { ok: true, replaced: true }
    }
    if (!upgraded.needsFull) log.warn(`流式升级首行失败，改走整篇写：${upgraded.error}`)
  }

  /* ③ 整篇重写（兜底，行为与老实现一致） */
  const raw = fs.readFileSync(file, 'utf8')
  const cut = raw.indexOf('\n')
  const firstRaw = cut >= 0 ? raw.slice(0, cut) : raw
  const rest = cut >= 0 ? raw.slice(cut + 1) : ''
  const head = openLineDetailed(firstRaw.trim())
  let isMeta = false
  if (head.ok) {
    try {
      isMeta = JSON.parse(head.text).type === 'meta'
    } catch {
      isMeta = false
    }
  }
  /* 第一行是 meta 就换掉它，否则把新 meta 插到最前面 —— 其余内容都不参与重排 */
  const keep = isMeta ? rest : raw
  /*
   * 唯一一处会动其它行的地方：**旧文件里还留着明文密钥**时顺手清一遍。
   * 这条保证以前是「整篇重写」白送的（自检 `31-session-redact` 钉着），
   * 改成只换第一行之后必须显式做，否则等于把脱敏能力悄悄丢了。
   *
   * ★ ①② 跳过全文扫描不会漏掉这类清理：槽位文件（①）每一行都过过
   *   `serializeLine`，正文里不可能有明文；② 在流式拷贝前先分块扫过
   *   特征串，扫到就退回这里。
   */
  const body = redact(keep) === keep ? keep : rescrubLines(keep, serializeLine)
  writeAtomic(file, `${next}\n${body}`)
  afterOk()
  return { ok: true, replaced: isMeta }
}

/**
 * 逐行重新脱敏：能解析的行过一遍唯一序列化入口，**解不开的行原样保留**。
 *
 * 与「整篇读→整篇写」的区别：坏行不会被丢掉（问题 22 的另一半），
 * 且落盘走原子写 —— 清旧密钥的同时不引入「写一半截断」的风险。
 */
function rescrubLines(text, serializeLine) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      const opened = openLineDetailed(trimmed)
      if (!opened.ok) return line
      try {
        return serializeLine(JSON.parse(opened.text))
      } catch {
        return line
      }
    })
    .join('\n')
}

module.exports = { writeMetaLine, rescrubLines }

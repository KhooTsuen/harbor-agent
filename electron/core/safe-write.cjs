/**
 * 写盘：两个「别丢用户数据」的小工具。
 *
 * ① `writeAtomic(file, text)` —— 先写同目录临时文件，再 rename 盖上去。
 *    直接 `fs.writeFileSync(整个文件)` 是「先截断、再写」：写到一半崩溃 / 断电 / 被杀，
 *    文件只剩前半截。会话与记忆都是用户一点点攒出来的，不能这么丢。
 *
 * ② `keepCorruptCopy(file)` —— 文件解不开时，先把它另存成 `<名字>.corrupt-<时间戳>`。
 *    为什么要这一步：解析失败后调用方会退化成「空数据」，**接下来任何一次写盘都会
 *    把那份坏文件盖掉** —— 用户攒了几百条的记忆就这么无声无息没了。
 *    留一份至少还能人工抢救。
 *
 * 同功能的原子写在 `session-crypto.cjs` 里也有一份（加密迁移用）。那份**没有挪过来**：
 * `session*.cjs` 是硬禁区，本批只被授权改 session-write / session-io 两个文件。
 * 「三份原子写收敛成一处」记在 `docs/审计修复进度.md` 的待办。
 */

const fs = require('node:fs')

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 把解不开的文件另存一份，返回另存后的路径（失败返回空串 —— 调用方只管记日志）。
 */
function keepCorruptCopy(file) {
  const keep = `${file}.corrupt-${Date.now()}`
  try {
    fs.copyFileSync(file, keep)
    return keep
  } catch {
    return ''
  }
}

module.exports = { writeAtomic, keepCorruptCopy }

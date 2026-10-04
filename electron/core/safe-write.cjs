/**
 * 写盘：两个「别丢用户数据」的小工具。
 *
 * ① `writeAtomic(file, text)` —— 先写同目录临时文件，再 rename 盖上去。
 *    直接 `fs.writeFileSync(整个文件)` 是「先截断、再写」：写到一半崩溃 / 断电 / 被杀，
 *    文件只剩前半截。会话与记忆都是用户一点点攒出来的，不能这么丢。
 *
 *    ★ rename 在 Windows 上会被「目标文件正被别的进程当着的」挡成 EPERM / EBUSY ——
 *    VS Code 的 watcher、杀毒软件、另一个进程还在读，都会短暂占住那个句柄。
 *    实测（2026-10-05）：内核自检连打几十次记忆写入时撞上过，
 *    `rename 'data/memory.json.tmp-968' -> 'data/memory.json'` 一抛就整个自检崩，
 *    **连着拦下三次推送**。而 `memory-store` / `session-io` 两条写用户数据的路
 *    用的是同一个函数 —— 所以这不是「自检不稳」，是一次普通的写盘会变成崩溃。
 *    修法：只对「文件被占着」这类**暂时**失败退避重试几次，真写不进去才抛。
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

/** 这几类 code 是「文件被占着」的**暂时**失败 —— 等一下通常就过去了 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_TRIES = 5
const RENAME_BASE_WAIT_MS = 40

/** 同步睡一会儿。写盘路径本来就是同步的，三四十毫秒不值得为它改成异步 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * rename 盖上去。撞上「文件被占着」就退避重试（40 / 80 / 120 / 160ms），
 * **其它错误一律立刻抛** —— 磁盘满了、路径不合法这种，重试一百次也不会变好。
 */
function renameWithRetry(tmp, file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (error) {
      if (!TRANSIENT.has(error?.code) || attempt >= RENAME_TRIES) throw error
      sleepSync(RENAME_BASE_WAIT_MS * attempt)
    }
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    renameWithRetry(tmp, file)
  } catch (error) {
    /* 重试也没成：把临时文件清掉，别在 data/ 里留一地 .tmp-* 垃圾（已经留过） */
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 清不掉就算了 —— 别把真正的错误盖掉 */
    }
    throw error
  }
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

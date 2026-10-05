/*
 * 单文件轮转：超上限就把当前文件改名成 `.1`（只留一份，下次再超会把它盖掉）。
 *
 * 为什么单独一个模块（硬约束 #9：同一段逻辑只能有一个实现）：
 * 这段做法原先**两份** —— `log-actions.rotateIfNeeded`（动作流水，6MB）
 * 和 `data-retention.rotateFile`（token 指标），各自一份、各自一句注释写着
 * 「和对方同一套做法」。这就是「改一处忘另一处」的典型来源。
 * 2026-10-06 收敛到这里（待办原本记在 docs/improvement-checklist.md）。
 *
 * 刻意保留的差异：上限由调用方给（6MB / 指标上限不同），失败一律**不影响主流程**
 * —— 轮转是收尾卫生，不是功能。
 */

const fs = require('node:fs')

/**
 * 需要的话转一次。
 *
 * @param {string} file 目标文件
 * @param {{ incoming?: number, maxBytes: number, warn?: (message: string) => void, label?: string }} input
 *   incoming：马上要追加的字节数（算进去才不会「刚好又超」）；
 *   warn：真转了叫一声（日志由调用方决定怎么记）
 * @returns {boolean} 有没有真的转
 */
function rotateIfOver(file, { incoming = 0, maxBytes, warn, label = '文件' } = {}) {
  try {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size + incoming <= maxBytes) return false
    const backup = `${file}.1`
    fs.rmSync(backup, { force: true })
    fs.renameSync(file, backup)
    warn?.(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)}MB，旧的改名成 ${backup}`)
    return true
  } catch {
    /* 轮转失败不影响主流程 */
    return false
  }
}

module.exports = { rotateIfOver }

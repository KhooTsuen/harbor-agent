import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   Phase 5 源码钉子：收尾这条路必须完整（层与层之间测试照不到 → 读源码点名）

   来由：2026-10-12 用户报「后端已成功（commit + tag 都成了），UI 却卡在运行中/中断」。
   根因是「一轮的收尾」在事件生命周期上不完整 —— `phase` 只进不退，终止事件一丢就永久假死。
   详细定位见 docs/research/phase5-turn-lifecycle-design.md。

   这一组钉四处（哪天谁把它们删了，这里立刻红）：
     A1  收尾路径写终态 phase          （否则终止事件一丢 = 永久卡「运行中」）
     A2  兜底超时真叫停主进程          （只放弃接收不叫停 = 后台继续跑，done 被静默丢弃）
     A3  「停止」要拆掉兜底时钟        （否则 300s 后把已停的那轮标成 error）
     B1  run_shell 有周期性心跳        （否则长命令静默被必然误判成卡死）
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const turnsSrc = read('src/stores/thread/turns.ts')
const phaseSrc = read('src/stores/thread/turnPhase.ts')
const controlSrc = read('src/stores/thread/turnControl.ts')
const runShellSrc = read('electron/core/tools/run_shell.cjs')

describe('Phase 5：一轮收尾的事件生命周期钉子', () => {
  it('★ A1：收尾路径必须写终态 phase', () => {
    const start = turnsSrc.indexOf('const finish = (): void => {')
    expect(start, 'turns.ts 里找不到 finish()（改名了？）').toBeGreaterThan(0)
    const block = turnsSrc.slice(start, start + 700)
    expect(block).toContain('applyTerminalPhase(')
  })

  it('A1：只补主进程没给的终态（主进程推过就不覆盖）', () => {
    expect(phaseSrc).toContain('isTerminalPhase(')
    /* 三种终态映射都在 */
    expect(phaseSrc).toContain("'completed'")
    expect(phaseSrc).toContain("'cancelled'")
    expect(phaseSrc).toContain("'failed'")
    /* timeout（兜底）与 error（发送失败）都归 failed —— 主进程不会推这两种 */
    expect(phaseSrc).toMatch(/reason === 'error'.*reason === 'failed'.*reason === 'timeout'/)
  })

  it('★ A2：兜底超时要真叫停主进程（复用 chat:abort，不新增通道）', () => {
    const start = turnsSrc.indexOf('const onTurnTimeout = (): void => {')
    expect(start, 'turns.ts 里找不到 onTurnTimeout（改名了？）').toBeGreaterThan(0)
    const block = turnsSrc.slice(start, start + 400)
    expect(block).toContain('stopActiveRequest(threadId)')
  })

  it('★ A3：「停止」要拆掉兜底时钟（消灭遗留的 300s 定时炸弹）', () => {
    expect(controlSrc).toContain('export function disposeTurnWatchdog')
    const block = controlSrc.slice(controlSrc.indexOf('export function stopActiveRequest'))
    expect(block).toContain('disposeTurnWatchdog(threadId)')
    /* 收尾那条路也要拆（幂等） */
    expect(turnsSrc).toContain('disposeTurnWatchdog(threadId)')
  })

  it('★ B1：run_shell 必须有周期性心跳（长命令静默不再被误判为卡死）', () => {
    expect(runShellSrc).toContain('heartbeatMs()')
    expect(runShellSrc).toMatch(/heartbeat = setInterval\(/)
    expect(runShellSrc).toContain('ctx.progress?.(')
    /* 心跳必须在死亡路径上停掉，否则白醒 */
    expect(runShellSrc).toContain('stopHeartbeat()')
  })
})

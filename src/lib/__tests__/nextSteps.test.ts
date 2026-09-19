import { describe, expect, it } from 'vitest'
import { nextStepsFor } from '../nextSteps'

/* ══════════════════════════════════════════════════════════════
   下一步（AG-033）

   文档：任务完成后给快捷入口，**只能作为快捷入口，不得未经许可自动执行
   高风险操作**。这一组钉住两件事：
     · 该给哪些入口（改了文件才有 diff / 测试 / 提交）
     · 「高风险」那几项**只能是「要发的话」**，不能带任何直接执行的指令
   ══════════════════════════════════════════════════════════════ */

describe('AG-033 / 下一步给哪些入口', () => {
  it('改了文件 → 文档例子里那四项', () => {
    const labels = nextStepsFor({ files: 4 }).map((step) => step.label)
    expect(labels).toEqual(['运行测试', '查看 Diff', '提交修改', '继续检查'])
  })

  it('没改文件 → 只留「继续检查」（不提 diff / 测试 / 提交）', () => {
    const labels = nextStepsFor({ files: 0 }).map((step) => step.label)
    expect(labels).toEqual(['继续检查'])
  })

  it('★ 查看 Diff 是纯导航 —— 不带要发的话', () => {
    const diff = nextStepsFor({ files: 1 }).find((step) => step.id === 'diff')
    expect(diff?.prompt).toBeUndefined()
  })

  it('★ 提交修改要先给人看 —— 不允许「直接提交」', () => {
    const commit = nextStepsFor({ files: 1 }).find((step) => step.id === 'commit')
    expect(commit?.prompt).toContain('我确认之后再提交')
    /* 这条是关键：入口本身不能是「执行提交」这种指令 */
    expect(commit?.prompt).not.toMatch(/^提交$|直接提交/)
  })

  it('★ 其余入口都只是把话写好，不含任何命令', () => {
    for (const step of nextStepsFor({ files: 2 })) {
      if (!step.prompt) continue
      /* 不该出现 shell 片段 / 路径穿透 / 提权之类的东西 */
      expect(step.prompt, step.label).not.toMatch(/[`$]|rm -|sudo|curl|&&|\|\|/)
    }
  })
})

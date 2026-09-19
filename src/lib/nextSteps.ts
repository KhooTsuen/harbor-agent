/* ══════════════════════════════════════════════════════════════
   下一步（AG-033）

   文档要求：任务完成后给几个快捷入口（例子：运行测试 / 查看 Diff /
   继续检查 / 提交修改），而且**只能作为快捷入口，不得未经许可自动执行
   高风险操作**。

   这里就是那条界线：
     · 「查看 Diff」是**纯导航**（打开右栏的审查标签），不碰文件、不跑命令；
     · 其余三项都只是**替用户把话写出来**，点下去走的是普通发送链路 ——
       模型该问权限还是会问权限（AG-013），和用户手打一模一样。
   所以这个模块只产出 {标签, 要发的话}，不发任何指令。

   为什么不用模型生成：候选是**有限且确定**的（改了文件就有 diff、就能跑测试），
   一次额外调用不值得，还会让「下一步」变得不可预期。
   ══════════════════════════════════════════════════════════════ */

export type NextStepId = 'test' | 'diff' | 'check' | 'commit'

export interface NextStep {
  id: NextStepId
  label: string
  /** 点下去要发的话；纯导航的动作没有这个字段 */
  prompt?: string
}

/**
 * 一条任务刚结束时，能提供哪些下一步。
 *
 * @param files 这次改了文件吗（0 = 纯只读的活，那就不提 diff / 测试 / 提交）
 */
export function nextStepsFor({ files }: { files: number }): NextStep[] {
  const steps: NextStep[] = []

  if (files > 0) {
    steps.push({ id: 'test', label: '运行测试', prompt: '把相关的测试跑一遍；有失败就定位原因。' })
    steps.push({ id: 'diff', label: '查看 Diff' })
    steps.push({
      id: 'commit',
      label: '提交修改',
      /* 「先给我看 diff 和提交信息」是刻意写进去的：不要让它直接 commit */
      prompt: '把这些改动整理成一次提交：先把 diff 和提交信息给我看，我确认之后再提交。',
    })
  }

  /* 没改文件也值得再扫一眼（比如这次只是分析）—— 所以这条一直都在 */
  steps.push({
    id: 'check',
    label: '继续检查',
    prompt: '再检查一遍刚才的结论：有没有漏掉的调用点、边界情况或副作用？',
  })

  return steps
}

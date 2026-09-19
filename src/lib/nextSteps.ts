import type { TaskOutcome } from '@/types/notify'

/* ══════════════════════════════════════════════════════════════
   下一步（AG-033 给入口 · AG-034 按上下文挑入口）

   文档要求：完成后给几个快捷入口，**只能作为快捷入口，不得未经许可自动执行
   高风险操作**；而且入口要**和上下文相关** ——

     · 「修改完成，测试尚未运行。」 → 给「运行测试」
     · 「任务已完成。」           → 给「查看 Diff / 查看测试结果 / 继续优化」

   这里就是那条界线：
     · 「查看 Diff」「查看测试结果」是**纯看**，不碰文件、不跑命令；
     · 其余几项都只是**替用户把话写出来**，点下去走普通发送链路 ——
       模型该问权限还是会问权限（AG-013），和用户手打一模一样。
   所以这个模块只产出 {标签, 要发的话}，不下达任何指令。

   为什么不用模型生成候选：候选是**有限且确定**的（干了什么就在台账里），
   一次额外调用不值得，还会让「下一步」变得不可预期。
   ══════════════════════════════════════════════════════════════ */

export type NextStepId =
  'test' | 'testResult' | 'diff' | 'commit' | 'check' | 'improve' | 'diagnose'

export interface NextStep {
  id: NextStepId
  label: string
  /** 点下去要发的话；纯查看的动作没有这个字段（它只是展开/切标签） */
  prompt?: string
}

export interface NextStepsPlan {
  /** 头一句：这次到底干成了什么（AG-034 的「上下文」） */
  headline: string
  steps: NextStep[]
}

const RUN_TEST: NextStep = {
  id: 'test',
  label: '运行测试',
  prompt: '把相关的测试跑一遍；有失败就定位原因。',
}
const SHOW_TEST: NextStep = { id: 'testResult', label: '查看测试结果' }
const SHOW_DIFF: NextStep = { id: 'diff', label: '查看 Diff' }
const COMMIT: NextStep = {
  id: 'commit',
  label: '提交修改',
  /* 「先给我看 diff 和提交信息」是刻意写进去的：不要让它直接 commit */
  prompt: '把这些改动整理成一次提交：先把 diff 和提交信息给我看，我确认之后再提交。',
}
const KEEP_CHECK: NextStep = {
  id: 'check',
  label: '继续检查',
  prompt: '再检查一遍刚才的结论：有没有漏掉的调用点、边界情况或副作用？',
}
const IMPROVE: NextStep = {
  id: 'improve',
  label: '继续优化',
  prompt: '在刚才的基础上继续优化：还有哪些可以改进的地方？（已经通过测试的部分别动）',
}
const DIAGNOSE: NextStep = {
  id: 'diagnose',
  label: '定位失败原因',
  prompt:
    '刚才的测试没通过。先别改代码，把失败原因定位清楚：哪几个用例、为什么失败、是代码的问题还是测试本身的问题。',
}

/** 这一轮的通知该怎么说（AG-034 的两个例子就在这里） */
function headlineOf({ files, tests }: TaskOutcome): string {
  if (tests === 'failed') return '测试没有通过。'
  if (tests === 'unknown') return '测试已经跑过了，但结果没读出来。'
  if (tests === 'passed') return files > 0 ? '修改完成，测试通过。' : '检查完成，测试通过。'
  return files > 0 ? '修改完成，测试尚未运行。' : '检查完成，没有改动文件。'
}

/**
 * 一条任务刚结束时，能提供哪些下一步。
 *
 * ★ 上下文相关的地方：
 *   · 没改文件 → 不提 diff / 测试 / 提交（没东西可看）
 *   · 测试已经跑过 → 不再劝它「运行测试」，改成「查看测试结果」
 *   · **测试没过就不给「提交修改」** —— 这是这条规则里最要紧的一处
 */
export function nextStepsFor(outcome: TaskOutcome): NextStepsPlan {
  const { files, tests } = outcome
  const steps: NextStep[] = []

  if (tests === 'failed') {
    /* 红了：先看结果、再定位原因（不给提交、也不提「继续优化」—— 先修好） */
    steps.push(SHOW_TEST, DIAGNOSE)
    if (files > 0) steps.push(SHOW_DIFF)
  } else if (files > 0) {
    steps.push(tests === 'none' ? RUN_TEST : SHOW_TEST)
    steps.push(SHOW_DIFF, COMMIT, IMPROVE)
  } else {
    if (tests !== 'none') steps.push(SHOW_TEST)
    steps.push(KEEP_CHECK)
  }

  return { headline: headlineOf(outcome), steps }
}

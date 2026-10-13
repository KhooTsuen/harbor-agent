/**
 * mark_step_done —— 让模型**显式声明**计划里的某一步做完了（打卡）
 *
 * ★ 为什么需要它：计划卡上的 `[ ]` 由模型维护，而模型（按本项目自己的规矩）只在
 *   每次发送的**第 1 个 LLM 轮次**输出正文（计划块在里面），后续工具轮没有正文 →
 *   `[x]` 永远不亮，计划卡看着像「没动」（Phase 5 定位）。这个工具给模型一个
 *   **工具轮也能打卡**的入口。
 *
 * ★ 四条边界（不可越）：
 *   ① **打卡 ≠ 验证**：它不跑命令、不读 run_shell 结果、不碰用户文件。验证照常跑命令 ——
 *      严格模式的门禁数的是 `plan` 里的 `[x]`（打卡一改门禁就看见），所以
 *      **「只打卡、不跑验证」照样被拦**，这是「不许拿打卡骗门禁」的机制保证（不是自觉）。
 *   ② **不算写操作**：**不进** `WRITE_TOOLS`（放进去会让 ask 档每打一次卡弹一次确认框，
 *      功能没法用）。它不改文件、不联网、不跑命令，只更新计划进度。
 *   ③ 越界 / 无计划**不抛异常**（抛了会炸掉模型循环），返回错误文本让模型自己纠正。
 *   ④ **「只分析」轮拦下**：它不是 `WRITE_TOOLS` 成员（② 的代价），
 *      内核那道写门罩不到它 —— 所以 `run` 开头自己判 `ctx.allowWrite === false`，
 *      直接返回错误文本、**不读盘不写盘**（进度是要写盘的，那就不算「只分析」了）。
 *
 * 落点：逻辑在 `task-plan.cjs` 的 `markStepDone`（**没碰 task.cjs**，硬禁区 8）；
 * 落盘走 `task-io.write`（= `safe-write.writeAtomic`；幂等，已打卡不重复写盘）。
 * 设计见 `docs/research/mark-step-done-design.md`。
 */

const io = require('../task-io.cjs')
const { markStepDone } = require('../task-plan.cjs')

module.exports = {
  name: 'mark_step_done',
  description: [
    '声明「计划里的第 N 步做完了」，让计划卡上那一步亮起勾选。',
    '★ 它只更新计划进度：不跑命令、不验证、不改用户文件。',
    '做完一步就调它打卡；验证请照常跑命令 —— 严格模式下只打卡不验证会被拦。',
    'step_index 是计划数组下标（0 起），必须落在合法范围内。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      step_index: {
        type: 'integer',
        description: '计划数组下标，0 起（第 1 步是 0）。必须落在 [0, 计划步数) 内。',
      },
      summary: {
        type: 'string',
        description: '可选：一句话说明这一步做了什么（会记进台账，便于回看）。',
      },
    },
    required: ['step_index'],
  },

  async run(args, ctx = {}) {
    /*
     * ★ 「只分析」轮的守卫（2026-10-13 用户拍板）—— 放在**最前面**：
     *   它不算 `WRITE_TOOLS`（放进去会让 ask 档每打一次卡弹一次确认框，功能没法用），
     *   所以内核那道 `ctx.allowWrite === false && isWrite` 的门**罩不到它**
     *   （`tools/index.cjs:183`）。这里自己补一道，否则用户说「不要修改」时，
     *   打卡仍会改计划进度 —— 而进度是**要写盘的**，那就不算「只分析」了。
     *
     *   拦下就是**纯不动**：不读盘（连 io.get 都不调）、不写盘、不改内存。
     *   返回错误文本而非抛异常（同 ③ 的规矩，别炸掉模型循环）。
     */
    if (ctx.allowWrite === false) {
      return '错误：当前处于只分析模式，不能打卡计划进度'
    }
    const taskId = String(ctx.taskId ?? '')
    if (!taskId) return '这次没有可打卡的任务（不在任务上下文里），跳过打卡即可。'
    const task = io.get(taskId)
    if (!task) return '找不到这条任务，跳过打卡即可。'

    const result = markStepDone(task, args?.step_index)
    if (!result.ok) return result.message
    if (result.changed) {
      task.updatedAt = io.monotonicNow()
      /* 落盘：整条任务原子写（含 task.plan 与 planVersions[last].plan 两处勾选） */
      io.write(task)
    }
    const note = String(args?.summary ?? '').trim()
    return note ? `${result.message}（说明：${note.slice(0, 200)}）` : result.message
  },

  summarize(args) {
    const i = args?.step_index
    return Number.isInteger(i) ? `打卡第 ${i + 1} 步` : '打卡'
  },
}

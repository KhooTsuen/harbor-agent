/**
 * 提示词的**长度上限**（唯一真相源）。
 *
 * 2026-10-04：这些数字以前各写各的 —— `project.cjs`（AGENT.md）12000、
 * `project-rules.cjs`（规则目录）8000，而 `context-builder.cjs` 的项目层下限
 * （`PROJECT_FLOOR`）又把它们**相加**算出 21120。三处数字、两个来源：
 * 改一个另两个漂，而且漂了不会有任何测试报红 —— 症状是「文件明明在上限以内，
 * 进上下文还是被切」。
 *
 * 现在三处都从这里取：
 *   · `project.cjs.MAX_CHARS`        = MAX_AGENT_MD_CHARS
 *   · `project-rules.cjs.MAX_CHARS`  = MAX_RULES_CHARS
 *   · `context-builder.cjs` 的 PROJECT_FLOOR = PROJECT_FLOOR_CHARS
 *
 * 钉住它的测试：`src/stores/thread/__tests__/promptLimits.test.ts`
 * （既比数值，也扫源码里不许再出现写死的上限）。
 *
 * 这个文件**不 require 任何东西** —— 谁都能引用，不会绕出循环依赖。
 */

/** AGENT.md（项目约定文件）注入上限 */
const MAX_AGENT_MD_CHARS = 12000

/** 规则目录（`.github/instructions` 一类）合计注入上限 */
const MAX_RULES_CHARS = 8000

/**
 * 项目层的**下限**（不受 budget.project 百分比管）。
 *
 * 为什么是「两个生产者上限相加 + 余量」：项目层由这两个生产者拼出来，各自已经带上限，
 * 所以这里给的下限必须 ≥ 两者之和，否则「文件在上限以内，进上下文还是被切」。
 * 余量留给头部标题与截断说明。
 */
const PROJECT_FLOOR_CHARS = MAX_AGENT_MD_CHARS + MAX_RULES_CHARS + 1024

module.exports = { MAX_AGENT_MD_CHARS, MAX_RULES_CHARS, PROJECT_FLOOR_CHARS }

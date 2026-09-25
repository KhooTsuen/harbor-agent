/**
 * 任务模板（token 优化 · 阶段 4）
 *
 * 只做一件事：**建议**计划，不绕过 Agent 对实际项目的检查。
 * 命中模板时给模型一段「参考步骤」提示（进任务状态层），
 * 并把 template_id / template_version 记进任务台账 —— 复盘时能按模板归组比较。
 *
 * 模板必须版本化：改步骤 = 升级 version（同一 id 不同版本的结果不能混着比）。
 */

const TEMPLATES = [
  {
    id: 'fix-bug',
    version: 1,
    match: /(修|改|解决|fix).{0,14}(bug|错误|问题|失败|坏了)|测试失败|报错了?/i,
    plan: ['读出错点附近的代码与测试', '复现并确认失败原因', '最小改动修复', '跑测试验证', '汇报改动与结果'],
  },
  {
    id: 'add-feature',
    version: 1,
    match: /(新增|添加|实现|加一个|做一个|开发).{0,14}(功能|模块|文件|页面|接口|函数|命令)?/,
    plan: ['读相关模块与项目约定', '给方案（影响文件清单）', '实现最小可用版本', '自测或补测试', '汇报'],
  },
  {
    id: 'refactor',
    version: 1,
    match: /(重构|拆分|提取|整理|清理|简化)/,
    plan: ['摸清现状与测试兜底', '小步拆分（每步行为不变）', '每步跑测试', '汇报结构变化'],
  },
  {
    id: 'read-explain',
    version: 1,
    match: /(读一下|读读|讲讲|解释|说明|看懂).{0,12}(代码|模块|文件|实现|逻辑|做什么|干嘛)/,
    plan: ['定位并读取相关文件（按需分块）', '概括结构与职责', '指出关键流程与注意点', '只读，不改文件'],
  },
  {
    id: 'run-tests',
    version: 1,
    /* 祈使否定不命中：「不要跑测试」「别跑测试」（2026-09-26 真机跑分逮到 T2 误命中） */
    match: /(?<!不要)(?<!别)(跑|运行|执行).{0,12}(测试|test)|测试.{0,8}(跑|运行|通过)/i,
    plan: ['找到测试入口命令', '运行测试', '失败则定位原因并最小修复', '给出结论与证据（命令/退出码）'],
  },
]

/**
 * 匹配一个任务模板。
 *
 * @param {string} text 用户这轮说的话
 * @returns {null | { id: string, version: number, plan: string[] }}
 */
function match(text) {
  const said = String(text ?? '')
  if (!said.trim()) return null
  for (const item of TEMPLATES) {
    if (item.match.test(said)) return { id: item.id, version: item.version, plan: [...item.plan] }
  }
  return null
}

/** 给模型的「建议计划」提示（进任务状态层；明确说是建议，别当已完成的步骤） */
function hintOf(matched) {
  if (!matched) return ''
  const steps = matched.plan.map((step, i) => `${i + 1}) ${step}`).join('；')
  return (
    `【任务模板建议 · ${matched.id}@${matched.version}】参考步骤：${steps}。\n` +
    '（这是模板建议：开始前仍要按当前项目实际情况核对；步骤按需调整，不要当成已完成。）'
  )
}

module.exports = { TEMPLATES, match, hintOf }

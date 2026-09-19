/**
 * 「这一轮到底干了什么」（AG-034 Smart Continue）
 *
 * 「下一步」给哪些入口，取决于**这次真发生了什么**：改了文件没有、测试跑过
 * 没有、跑过是过还是不过。这些都能从任务台账里读出来，所以判读放在内核 ——
 * 和 AG-029 一样，渲染层只负责按结果挑措辞，不自己猜。
 *
 * 为什么不去问模型：模型给的是「它以为」，台账记的是「实际干过的」。而且
 * 「下一步」得在一轮结束的那一瞬间就摆出来，另开一次调用既不划算也没必要。
 */

/**
 * 什么算「跑测试」。
 *
 * 只认真的会跑用例的命令 —— `npm run build`、`make` 这类**不算**，
 * 不然「测试尚未运行」就会在明明只构建过的时候消失。
 */
const TEST_HINTS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/i,
  /\b(vitest|jest|pytest|rspec|phpunit|tox|ctest)\b/i,
  /\b(go|cargo|dotnet|mvn|gradle|gradlew)\s+test\b/i,
  /\bmake\s+test\b/i,
  /\b[\w./\\-]*tests?\.(sh|py|mjs|cjs|bat|ps1)\b/i,
]

function isTestCommand(command) {
  const text = String(command ?? '')
  return TEST_HINTS.some((pattern) => pattern.test(text))
}

/**
 * 从命令输出里读退出结果。
 *
 * `run_shell` 把 `[退出码 N]` 放在输出的**最后**，而 `result` 落库时会截到
 * 300 字 —— 尾巴上的标记常常正好被截掉，所以这个判断必须在**截断之前**做
 * （见 task.cjs 的 addCommand）。
 *
 * @returns {boolean|null} true 成功、false 失败、null 读不出来（老记录 / 非命令输出）
 */
function exitOf(text) {
  const raw = String(text ?? '')
  if (/\[进程被超时杀掉/.test(raw)) return false
  const match = /\[退出码 (\d+)\]/.exec(raw)
  return match ? match[1] === '0' : null
}

/** 结果开头几行 —— 「查看测试结果」要的是一眼能看懂的结论，不是整篇日志 */
function summaryOf(result, maxLines = 4) {
  return String(result ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines)
    .join('\n')
    .slice(0, 400)
}

/**
 * 任务台账 → 这一轮的结论。渲染层据此决定给哪些「下一步」。
 *
 * 取**最后一条**测试命令：模型常常「跑一遍 → 改 → 再跑一遍」，
 * 要看的是最后那次的结果，不是中间那次红的。
 */
function outcomeOf(task) {
  const commands = Array.isArray(task?.commands) ? task.commands : []
  const tests = commands.filter((item) => isTestCommand(item.command))
  const last = tests[tests.length - 1]

  let state = 'none'
  if (last) {
    if (last.exitOk === true) state = 'passed'
    else if (last.exitOk === false) state = 'failed'
    else state = 'unknown'
  }

  return {
    /* 「查看测试结果」展开到哪一步得**按任务认**：连着两轮跑同一条命令
       （`python tests.py`）时，光看命令分不出这是新一轮 */
    taskId: String(task?.id ?? ''),
    files: Array.isArray(task?.changedFiles) ? task.changedFiles.length : 0,
    tests: state,
    testCommand: last ? String(last.command).slice(0, 200) : '',
    testSummary: last ? summaryOf(last.result) : '',
  }
}

module.exports = { outcomeOf, isTestCommand, exitOf, summaryOf, TEST_HINTS }

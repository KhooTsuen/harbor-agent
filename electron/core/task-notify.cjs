/**
 * 「一轮跑完了」通知的内容（AG-029）
 *
 * 放在内核里（不是渲染层的 TS）是有原因的：**要发系统通知的是主进程** ——
 * 窗口藏到托盘时渲染层的定时器/回调会被节流，指望它来决定「要不要弹」
 * 就正好在最需要通知的场景失效（真机实测：藏起来之后页面里的 eval 全部超时）。
 *
 * 所以：内容在这里生成一次，主进程用它弹系统通知**并且**推给渲染层
 * 显示应用内提示 —— 两边同一份措辞，不会各写一套。
 */

/** 哪两种结束方式值得通知。用户自己按的停止不属于「完成/失败」，不打扰他 */
const END_META = {
  completed: { kind: 'success', title: '后台任务完成' },
  failed: { kind: 'error', title: '后台任务失败' },
}

/** 取结果的第一行 —— 「测试通过」这种结论通常就写在最前面 */
function firstLine(text) {
  return (
    String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.slice(0, 80) ?? ''
  )
}

/**
 * 任务结束时该显示什么。
 *
 * @param {string} phase completed / failed（其他一律返回 null）
 * @param {object} [task] 任务台账里那条（没有也能出通知，名字退成「未命名任务」）
 * @returns {{ kind: string, title: string, description: string } | null}
 */
function endNotice(phase, task) {
  const meta = END_META[String(phase ?? '')]
  if (!meta) return null

  const name = task?.title || task?.goal || '未命名任务'
  const lines = [`「${name}」`]

  if (task) {
    const files = (task.changedFiles ?? []).length
    lines.push(files > 0 ? `已修改 ${files} 个文件` : '没有改动文件')
    const conclusion = firstLine(task.result)
    if (conclusion) lines.push(conclusion)
    else if (phase === 'failed') {
      const last = (task.errors ?? []).at(-1)
      lines.push(firstLine(last?.message ?? '') || '执行失败')
    }
  }

  return { kind: meta.kind, title: meta.title, description: lines.join('\n') }
}

module.exports = { endNotice, END_META }

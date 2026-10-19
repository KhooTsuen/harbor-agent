/**
 * 分析结果的**渲染**（2026-10-17 · 3B-1）
 *
 * 把 `buildAnalysis()` 的结构化结果变成活动记录 `<pre>` 能直接显示的分节文本。
 * 拆出来的理由：渲染是纯字符串拼接，和「怎么判、怎么取证」没关系；
 * 合成一个文件会贴 300 行红线。
 *
 * ★ 渲染时**必须**把两件事写在最上面（用户第二部分）：
 *   ① 诊断方式是**规则诊断**，不涉及模型推理；
 *   ② 本次分析**没有修改任何文件**、**没有重新执行测试**。
 *
 * ⚠️ 不 require electron。
 */

/**
 * @param {object} a `buildAnalysis()` 的结果
 * @returns {string}
 */
function renderText(a) {
  const L = []
  L.push(`## 测试失败分析：${a.label || a.testId || '（未命名条目）'}`)
  L.push('')
  L.push('> 诊断方式：**规则诊断**（不涉及模型推理）；本分析**未修改任何文件**，也**未重新执行测试**。')
  L.push('')

  if (!a.gate.fixable) {
    L.push(`⚠️ 状态是 **${a.status || '(空)'}**，不做代码修复分析。`)
    L.push(`说明：${a.gate.note}`)
    L.push('')
  }

  const section = (title, items) => {
    L.push(`### ${title}`)
    if (!items || items.length === 0) L.push('（无）')
    else for (const it of items) L.push(`- ${typeof it === 'string' ? it : it.line}`)
    L.push('')
  }

  section('已确认的事实（来自执行记录 / 真实读到的源码）', a.facts)
  section(
    '推测（**不是**已确认的原因）',
    a.inferences.map((x) => `${x.text}〔置信度：${x.confidence}〕—— ${x.basis}`),
  )
  section('未知 / 证据不足', a.unknowns)
  section(
    '建议检查的文件',
    a.files.map(
      (f) =>
        `${f.rel}${f.line ? `:${f.line}` : ''}${f.verified ? '（已读）' : '（未读，仅从输出推断）'}` +
        `${f.error ? `（${f.error}）` : ''}`,
    ),
  )
  section('修复建议', a.advice)
  section('风险说明', a.risks)

  if (a.diffPreview.available) {
    L.push('### 差异预览')
    L.push('⚠️ **以下差异只是预览，尚未修改任何文件**（本阶段不写盘，也不会自动应用）')
    L.push('')
    for (const f of a.diffPreview.files) {
      L.push(`**${f.path}**（+${f.additions} / -${f.deletions}）${f.note ? ` —— ${f.note}` : ''}`)
      L.push('```diff')
      L.push(`--- a/${f.path}`)
      L.push(`+++ b/${f.path}`)
      for (const h of f.hunks ?? []) {
        L.push(h.header)
        for (const l of h.lines ?? []) {
          const mark = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '
          L.push(`${mark}${l.content}`)
        }
      }
      L.push('```')
      L.push('')
    }
  } else {
    L.push('### 差异预览')
    L.push(`（未生成：${a.diffPreview.reason || '证据不足'}）`)
    L.push('')
  }

  L.push('---')
  L.push('本次分析**没有修改任何文件**，也没有重新执行测试。')
  return L.join('\n')
}

module.exports = { renderText }

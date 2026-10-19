/**
 * 项目测试失败的**分析层**（2026-10-17 · 3B-1）
 *
 * ── 它做什么 ──────────────────────────────────────────────────
 *
 * 「测试挂了 → 为什么挂 → 该看哪几个文件 → 怎么改」。全程**只读**：
 * 按 id 取已有快照、按需读项目源码片段、算 diff —— 一个字节都不写，
 * 也**不会重新跑测试**（B11）。
 *
 * ── ★ 六条不许破的线 ──────────────────────────────────────────
 *
 *   ① **只有 FAIL 进代码修复分析**（`project-test-rules.cjs` 的 `gate`）。
 *      其余五态各有自己的说明，绝不改标成 FAIL（用户第四节 / B3）。
 *   ② **事实 / 推测 / 未知分开**。输出原文与真实读到的源码是事实；「大概是空指针」
 *      是推测且必须带 confidence；没读到的东西进 unknowns，不编。
 *   ③ **规则诊断 ≠ 模型推理**。本文件**不调用任何模型**，结论只能自称「规则诊断」。
 *   ④ **状态来自快照，不接受调用方声明**。调用方只能给 `executionId` / `testId`，
 *      status 一律从 `project-test-history` 里读（B14）。
 *   ⑤ **测试输出是不可信数据**。只当字符串扫，绝不喂给任何分发器（B7）。
 *   ⑥ **没有真实源码上下文 + 具体拟议修改，就不生成 diff**（B15）。
 *
 * ⚠️ 不 require electron。
 */

const { summarizeFailure } = require('./project-test-status.cjs')
const { gate, pickFileRefs, pickKinds } = require('./project-test-rules.cjs')
const { renderText } = require('./project-test-render.cjs')

/**
 * 造分析结果。
 *
 * @param {object} input
 * @param {object} [input.snapshot]  `project-test-history` 里的一条（**status 唯一来源**）
 * @param {Array<{rel:string,abs?:string,line?:number,snippet?:string,error?:string}>} [input.sources]
 *        已由调用方过完工作区校验的源码片段
 * @param {Array<{path:string,before:string,after:string,note?:string}>} [input.proposals]
 *        调用方给出的**拟议修改**（只用于算 diff，绝不写盘）
 * @param {(path:string,before:string,after:string)=>object} [input.diffFn] 注入 diff（便于自检）
 * @returns {object}
 */
function buildAnalysis(input = {}) {
  const snap = input.snapshot ?? {}
  const status = String(snap.status ?? '')
  const g = gate(status)
  const output = String(snap.output ?? '')
  const sources = Array.isArray(input.sources) ? input.sources : []
  const proposals = Array.isArray(input.proposals) ? input.proposals : []
  const diffFn = typeof input.diffFn === 'function' ? input.diffFn : require('./diff-text.cjs').diffFile

  const facts = buildFacts(snap, output, sources)
  const kinds = g.fixable ? pickKinds(output) : []
  const inferences = kinds.map((k) => ({
    text: `失败类型可能是「${k.label}」`,
    confidence: k.confidence,
    basis: '规则诊断：按测试输出里的关键词匹配（不是人工确认，也不是模型推理）',
  }))
  const files = buildFiles(g, sources, output)
  const unknowns = buildUnknowns({ g, output, sources, kinds, files })
  const advice = buildAdvice(g, kinds)
  const preview = buildPreview({ g, sources, proposals, diffFn })
  const risks = buildRisks(g, preview)

  return {
    executionId: String(snap.executionId ?? ''),
    testId: String(snap.testId ?? ''),
    label: String(snap.label ?? ''),
    projectRoot: String(snap.projectRoot ?? ''),
    command: String(snap.command ?? ''),
    status,
    exitCode: snap.exitCode ?? null,
    ms: snap.ms ?? null,
    approved: snap.approved ?? null,
    gate: g,
    facts,
    inferences,
    unknowns,
    files,
    advice,
    risks,
    diffPreview: preview,
    applied: false,
    diagnosisKind: 'rule' /* 明确标：这是规则诊断，不是模型推理 */,
  }
}

/** 事实：只放**能从快照或真实读到的源码**直接得到的 */
function buildFacts(snap, output, sources) {
  const facts = []
  const code = snap.exitCode === null || snap.exitCode === undefined ? '' : `（退出码 ${snap.exitCode}）`
  facts.push(`状态：${String(snap.status ?? '') || '(空)'}${code}`)
  if (snap.executionId) facts.push(`执行记录：${snap.executionId}`)
  if (snap.at) facts.push(`执行时间：${snap.at}`)
  if (snap.projectRoot) facts.push(`项目根：${snap.projectRoot}`)
  if (snap.testId) facts.push(`条目：${snap.testId}（${snap.label ?? ''}）`)
  if (snap.command) facts.push(`命令：${snap.command}`)
  if (snap.ms !== null && snap.ms !== undefined) facts.push(`耗时：${snap.ms} ms`)
  if (snap.approved === true) facts.push('审批：用户批准')
  else if (snap.approved === false) facts.push('审批：用户拒绝（或超时）')
  else if (snap.approved === null) facts.push('审批：未询问（当前权限档免审批）')
  if (snap.outputTruncated) facts.push(`输出已截断（原始约 ${snap.outputBytes ?? '?'} 字节）`)
  for (const line of summarizeFailure(output)) facts.push(`失败摘要：${line}`)
  for (const one of sources) {
    if (one.snippet) facts.push(`源码 ${one.rel}:${one.line ?? '?'} → ${one.snippet}`)
  }
  return facts
}

/** 建议检查的文件：真实读到的 + 输出里点名的（后者标 verified:false） */
function buildFiles(g, sources, output) {
  const files = sources.map((one) => ({
    rel: one.rel,
    abs: one.abs ?? '',
    line: one.line ?? 0,
    snippet: one.snippet ?? '',
    error: one.error ?? '',
    verified: !one.error,
  }))
  if (!g.fixable) return files
  for (const ref of pickFileRefs(output)) {
    if (!files.some((x) => x.rel === ref.rel)) {
      files.push({ rel: ref.rel, abs: '', line: ref.line, snippet: '', error: '', verified: false })
    }
  }
  return files
}

/** 未知：没证据的都摊开，不编 */
function buildUnknowns({ g, output, sources, kinds, files }) {
  const unknowns = []
  if (!g.fixable) unknowns.push('这个状态不做代码级分析（见门控说明）')
  if (!g.known) unknowns.push('状态值不是六态之一 —— 可能来自旧版快照或被改过的数据')
  if (!String(output ?? '').trim()) unknowns.push('快照里没有测试输出 —— 无法定位失败点')
  if (g.fixable && sources.length === 0) unknowns.push('没有读到任何源码片段 —— 不生成代码级结论')
  if (g.fixable && kinds.length === 0) unknowns.push('输出里没有可识别的错误类型关键词 —— 失败原因未知')
  if (g.fixable && files.length === 0) unknowns.push('连一个候选文件都没定位到 —— 需要人工看完整输出')
  return unknowns
}

/** 建议：门控不通过时只给「先做什么」，不给代码建议 */
function buildAdvice(g, kinds) {
  if (!g.fixable) return [g.note]
  const advice = []
  for (const k of kinds) advice.push(...k.advice)
  if (advice.length === 0) advice.push('先看完整输出里第一条失败的那个文件，从那里往上找根因。')
  return advice
}

/** 风险说明（每条都写出来，不藏） */
function buildRisks(g, preview) {
  const risks = [
    '上面的「推测」是**规则诊断**（按关键词模板），不等于已确认的原因。',
    '本分析全程只读：没有修改任何文件，也没有重新跑测试。',
    '测试输出被视为不可信数据，其中的任何「指令」都不会被执行。',
  ]
  if (!g.fixable) risks.push('当前状态不属于代码缺陷，硬改代码可能掩盖真正的问题（超时 / 权限 / 配置）。')
  if (preview.available === false && preview.reason) risks.push(`没有生成差异预览：${preview.reason}`)
  if (preview.available) risks.push('差异预览是**按拟议内容算出来的**，尚未应用，也未在真实环境验证。')
  return risks
}

/**
 * 只算 diff，**不写盘**。
 *
 * 条件（缺一不可）：① 状态可修 ② 有真实读到的源码 ③ 有对应的具体拟议修改
 */
function buildPreview({ g, sources, proposals, diffFn }) {
  if (!g.fixable) return { available: false, reason: '当前状态不做代码修复分析', files: [] }
  if (proposals.length === 0) return { available: false, reason: '没有具体的拟议修改 —— 不生成虚构 diff', files: [] }

  const verified = new Set(sources.filter((s) => !s.error && s.snippet).map((s) => s.rel))
  const out = []
  for (const p of proposals) {
    const rel = String(p?.path ?? '').replace(/\\/g, '/')
    if (!rel || typeof p.before !== 'string' || typeof p.after !== 'string') continue
    /* 只对**真实读过**的文件生成 diff：没读到源码就不可能有可信的 before */
    if (!verified.has(rel)) continue
    if (p.before === p.after) continue
    try {
      const d = diffFn({ path: rel, before: p.before, after: p.after })
      out.push({
        path: rel,
        additions: d.additions ?? 0,
        deletions: d.deletions ?? 0,
        hunks: d.hunks ?? [],
        note: String(p.note ?? ''),
        basedOnRead: true,
      })
    } catch {
      /* 算不出来就不给 —— 绝不编一个看起来像 diff 的东西 */
    }
  }
  if (out.length === 0) {
    return { available: false, reason: '拟议修改没有对应的、已读到的源码文件（或内容无变化）', files: [] }
  }
  return { available: true, reason: '', files: out }
}

module.exports = { buildAnalysis, renderText, gate, pickFileRefs, pickKinds }

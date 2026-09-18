/**
 * 诊断包
 *
 * 一键把「排查问题需要的东西」打包成一份文本，用户复制给开发者看。
 *
 * 为什么要做这个：出问题时最怕「信息不够」—— 开发者要来回问
 * 「你配的什么模型」「日志说什么」「有没有报错」，几轮下来用户就烦了。
 * 一次导出全部，一眼定位。
 *
 * **脱敏是硬要求**：API Key 绝不能出现在诊断包里。只报长度和前后几位。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const config = require('./config.cjs')
const session = require('./session.cjs')
const stats = require('./stats.cjs')
const scene = require('./scene.cjs')
const log = require('./log.cjs')
const fileCache = require('./file-cache.cjs')
const searchCache = require('./search-cache.cjs')

/** 日志最多带这么多行 —— 再多用户复制也费劲 */
const LOG_LINES = 120
/** 单条消息最多显示这么多字（只要看结构，不需要全文） */
const MESSAGE_PREVIEW = 160

/**
 * 把可能是密钥的字符串打码。
 *
 * 宁可多打一点 —— 诊断包是用户要发给别人的，泄露一次就麻烦。
 */
function mask(secret) {
  const text = String(secret ?? '')
  if (!text) return '（空）'
  if (text.length <= 8) return `${'*'.repeat(text.length)}（${text.length} 位）`
  return `${text.slice(0, 4)}…${text.slice(-2)}（${text.length} 位）`
}

/** 把日志里出现的疑似密钥再兜一层 —— 日志可能打过 header */
function scrubLogLine(line) {
  return String(line)
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9_-]{8,}/g, (m, prefix) => `${prefix}***已隐藏***`)
    .replace(/(api[_-]?key"?\s*[:=]\s*"?)[A-Za-z0-9_-]{8,}/gi, '$1***已隐藏***')
}

function readTailLines(file, count) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.split('\n').filter(Boolean).slice(-count)
  } catch {
    return []
  }
}

function logFile() {
  const day = new Date().toISOString().slice(0, 10)
  return path.join(DIRS.logs, `${day}.log`)
}

/** 配置摘要：只报「配了什么」，不报密钥 */
function configSummary() {
  const cfg = config.get()
  const lines = []

  lines.push('### 供应商')
  for (const p of cfg.providers) {
    lines.push(
      `- ${p.name}（${p.id}）${p.enabled ? '' : ' [已停用]'}\n` +
        `  - baseUrl: ${p.baseUrl}\n` +
        `  - apiKey: ${config.hasKey(p) ? '***已配置（存在凭证库）***' : '（未配置）'}\n` +
        `  - 对话路径: ${p.chatPath}\n` +
        `  - 模型: ${p.models.length > 0 ? p.models.join(', ') : '（空）'}`,
    )
  }

  lines.push('', '### 助手')
  lines.push(`- 名字: ${cfg.assistant.name}`)
  lines.push(`- 模型: ${cfg.assistant.model}`)
  lines.push(
    `- 温度/topP/maxTokens: ${cfg.assistant.temperature} / ${cfg.assistant.topP} / ${cfg.assistant.maxTokens}`,
  )
  lines.push(`- 历史轮数: ${cfg.assistant.historyLimit}`)
  lines.push(`- 自定义人设: ${cfg.assistant.systemPrompt ? '有' : '（空，用内置）'}`)

  lines.push('', '### 场景模型')
  for (const item of scene.snapshot()) {
    const configured =
      item.providerId && item.model ? `${item.providerId}/${item.model}` : '（用默认）'
    lines.push(
      `- ${item.id}: ${configured}` +
        (item.fallback ? ` → 实际用 ${item.effectiveProviderName}/${item.effectiveModel}` : ''),
    )
  }

  lines.push('', '### 其他开关')
  lines.push(`- 权限档位: ${cfg.tools.permission}`)
  lines.push(`- 工作目录: ${cfg.general.workdir || '（默认 data/workspace）'}`)
  lines.push(
    `- 主题/玻璃/字号: ${cfg.general.theme} / ${cfg.general.glassmorphism} / ${cfg.general.fontScale}`,
  )
  lines.push(
    `- 联网搜索: ${cfg.search.provider}${config.searchKey() ? '（有 Key）' : '（无 Key）'}`,
  )
  lines.push(`- 文件访问范围: ${cfg.tools.fileScope}`)
  lines.push(
    `- Shell 风险策略: 中=${cfg.tools.shellPolicy.medium} 高=${cfg.tools.shellPolicy.high} 危急=${cfg.tools.shellPolicy.critical}`,
  )
  lines.push(`- 审计日志: ${cfg.audit.enabled ? '开' : '关'}（保留 ${cfg.audit.retentionDays} 天）`)
  lines.push(`- 记忆自动写入: ${cfg.memory.autoWrite}`)
  const cred = config.credentialsStatus()
  lines.push(
    `- 凭证库: ${cred.backend}${cred.encryptionAvailable ? '（系统加密可用）' : '（⚠️ 未加密）'} · ${cred.count} 条`,
  )
  lines.push(`- MCP 服务器: ${cfg.mcp.servers.length} 个`)
  lines.push(`- 关窗口最小化到托盘: ${cfg.general.minimizeToTray !== false}`)

  return lines.join('\n')
}

/** 会话概览：只列结构，不贴内容 */
function sessionSummary() {
  const list = session.list()
  const lines = [`共 ${list.length} 个对话`, '']

  for (const item of list.slice(0, 15)) {
    lines.push(
      `- ${item.title}` +
        `\n  - id: ${item.id}` +
        `\n  - ${item.messageCount} 条消息 · 模式 ${item.mode} · 模型 ${item.model || '（未记）'}` +
        `\n  - workdir: ${item.workdir || '（老会话，未记）'}`,
    )
  }
  if (list.length > 15) lines.push(`… 还有 ${list.length - 15} 个`)

  return lines.join('\n')
}

/**
 * 最近一个对话的**结构**（不含完整内容）。
 *
 * 排查「图片有没有发出去」这类问题时，看结构就够了：
 * 这条消息带没带图、工具调了哪些、有没有报错。
 */
function lastTurnStructure() {
  const list = session.list()
  const latest = list[0]
  if (!latest) return '（没有对话）'

  const detail = session.load(latest.id)
  if (!detail) return '（读不到）'

  const lines = [`对话「${latest.title}」（${latest.id}）最近几条：`, '']
  for (const m of detail.messages.slice(-8)) {
    const bits = [`[${m.role}]`]
    if (m.toolName) bits.push(`工具=${m.toolName}`)
    if (m.toolRuns?.length) bits.push(`工具记录=${m.toolRuns.length}`)
    if (m.error) bits.push(`❌错误=${String(m.error).slice(0, 120)}`)
    if (m.usage) bits.push(`token=${m.usage.total ?? '?'}`)

    const text = String(m.content ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, MESSAGE_PREVIEW)
    lines.push(`${bits.join(' ')} ${text}${text.length >= MESSAGE_PREVIEW ? '…' : ''}`)
  }

  return lines.join('\n')
}

/**
 * 缓存现状。
 *
 * 为什么要放进诊断包：AG-020 的 TTL / 上限一堆数字都是**拍的**，而
 * 「命中率多少」「现在占了多少字节」是唯一能拿来校准它们的依据。
 * 以前这些数字只活在内存里，没人看得到 —— 也就永远调不准。
 */
function cacheSummary() {
  const rows = [fileCache.stats(), searchCache.stats()]
  /* 小到 1 KB 以下时显示「0 KB」看着像坏了，所以再分一档 */
  const human = (bytes) =>
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${Math.round(bytes)} B`
  return rows
    .map((s) => {
      const total = s.hits + s.misses
      const rate = total > 0 ? `${Math.round((s.hits / total) * 100)}%` : '（还没用过）'
      const skip = s.skipped > 0 ? ` · 因单条过大跳过 ${s.skipped} 次` : ''
      return `- ${s.name}: ${s.size}/${s.max} 条 · ${human(s.bytes)}/${human(s.maxBytes)} · 命中率 ${rate}${skip}`
    })
    .join('\n')
}

/**
 * 生成完整诊断包。
 *
 * @returns {{ text: string, file: string }}
 */
function build() {
  const now = new Date()
  const cfg = config.get()
  const usage = stats.summary()

  const logLines = readTailLines(logFile(), LOG_LINES).map(scrubLogLine)
  const errors = logLines.filter((l) => l.includes('[ERROR]') || l.includes('[WARN]'))

  const sections = [
    '# Personal Agent 诊断包',
    '',
    `生成时间：${now.toLocaleString('zh-CN')}`,
    '',
    '## 环境',
    `- Electron: ${process.versions.electron}`,
    `- Node: ${process.versions.node}`,
    `- Chrome: ${process.versions.chrome}`,
    `- 平台: ${process.platform} ${process.arch}`,
    `- 数据目录: ${DIRS.data}`,
    `- 是否打包版: ${(() => {
      try {
        return require('electron').app.isPackaged ? '是' : '否（开发模式）'
      } catch {
        return '（非 Electron 环境）'
      }
    })()}`,
    '',
    '## 配置',
    configSummary(),
    '',
    '## 会话',
    sessionSummary(),
    '',
    '## 最近一个对话的结构',
    lastTurnStructure(),
    '',
    '## 用量',
    `- 累计调用 ${usage.total.calls} 次 · 共 ${usage.total.total} token`,
    '',
    '## 缓存',
    cacheSummary(),
    '',
    `## 日志（最后 ${logLines.length} 行，密钥已打码）`,
    errors.length > 0 ? `⚠️ 其中 ERROR/WARN ${errors.length} 条` : '（没有 ERROR/WARN）',
    '',
    '```',
    ...logLines,
    '```',
    '',
    '---',
    '（API Key 已打码，只显示长度。可以安全地发给别人。）',
  ]

  const text = sections.join('\n')
  const file = path.join(DIRS.data, `diagnostics-${Date.now()}.md`)
  try {
    fs.writeFileSync(file, text, 'utf8')
  } catch (error) {
    log.warn(`诊断包写文件失败：${error instanceof Error ? error.message : error}`)
  }

  log.info('已生成诊断包')
  return { text, file, errorCount: errors.length, logLines: logLines.length }
}

module.exports = { build, mask }

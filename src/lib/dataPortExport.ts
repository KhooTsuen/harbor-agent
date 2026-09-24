import type {
  AppConfig,
  MemoryItem,
  MemoryStats,
  SessionDetail,
  SessionSummary,
  SkillInfo,
  TaskRecord,
} from '@/types/backend'
import { BRAND_NAME } from '@/constants'
import { APP_VERSION, listSessions, loadConfig, loadSession, saveText } from './backend'
import { getMemory } from './extrasApi'
import { memoryList } from './memoryApi'
import { listSkills } from './skillsApi'
import { auditStats, taskList } from './safetyApi'

/* ══════════════════════════════════════════════════════════════
   统一导出：一个 JSON 带走全部数据

   为什么在渲染层聚合：主进程没有一条能一次取出这几样东西的通道，而**新增通道
   必须同步 `electron/ipc-channels.cjs`**（自检组 32 会点名），那个清单由集成方维护。
   所以这里用现成通道各取一份再拼包。

   ★ 凭什么保证包里没有密钥：
     ① 密钥根本不在这些通道的返回里。`credentials.json` 只有主进程能读，唯一
        相关的 IPC 是 `credentials:status`（只回条数/后端名，**不回值**）；
        `config:get` 回来时 apiKey 已由内核 `config.forRenderer()` 打成掩码。
     ② 落盘前再跑一遍 scrubForExport（键名口径与 `electron/core/redact.cjs` 的
        `SECRET_KEY` 逐字相同，自检组 69 盯着这行），再用 findSecretLikeValue
        复检 —— 还有疑似密钥就**拒绝落盘**。
   ══════════════════════════════════════════════════════════════ */

export const EXPORT_SCHEMA = 1

/** payload 的键集合 —— 自检组 69 按这份清单断言，改这里要同步改那边 */
export const EXPORT_KEYS: readonly string[] = [
  'app',
  'schema',
  'version',
  'exportedAt',
  'counts',
  'sessions',
  'tasks',
  'memory',
  'config',
  'skills',
  'notes',
]

/** 内核 config.cjs 给界面的掩码字面量 —— 认它才算「已经打过码」 */
export const MASKED_SECRET = '••••••••'

/**
 * 字段名像密钥吗。
 * ★ 这行的内容必须与 `electron/core/redact.cjs` 的 `SECRET_KEY` **逐字一致** ——
 *   渲染层复制了一份它的口径，两边漂了就有一边是漏的。
 */
const SECRET_KEY =
  /(api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|cookie|private[_-]?key|session[_-]?id)/i

/**
 * 值是「引用名」而不是密钥本身的键，不打码。
 *
 * 内核在日志里把这些也一律打码（宁可多打几条），导出不能照抄：
 *   · `credentialRef` 存的是 `provider:openai` 这种**名字**
 *   · `sessionId` 是会话 id，打掉它，导出的任务就找不到属于哪条对话了
 * 放行的是这两个键名，值仍然要过文本模式那层（真贴上 `sk-…` 照样会被抓）。
 */
const REFERENCE_KEYS = new Set(['credentialRef', 'sessionId'])

/** 自由文本里的疑似密钥 —— 内核 PATTERNS 的子集，替换措辞也照抄内核 */
const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, `$1 ***已隐藏***`],
  [/\bsk-[A-Za-z0-9-]{20,}\b/g, '***已隐藏***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***已隐藏***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***已隐藏***'],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, '***已隐藏***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***已隐藏***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***已隐藏***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***已隐藏***'],
  [/(\bhttps?:\/\/[^\s/@:]+):[^\s/@]+@/gi, `$1:***已隐藏***@`],
  [
    /((?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|authorization)["']?\s*[:=]\s*["']?)([^\s"',;&)\]}]{6,})/gi,
    '$1***已隐藏***',
  ],
]

/** 复检用：去掉 /g（带 lastIndex 的正则 .test 会串味） */
const CHECK_PATTERNS = TEXT_PATTERNS.map(
  ([pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', '')),
)

/** 只报「有几个字符」，不报值 —— 和内核 redact.cjs 一个措辞 */
function maskField(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : value === null || value === undefined
        ? ''
        : (JSON.stringify(value) ?? '')
  return text ? `***${text.length} 字符已隐藏***` : ''
}

interface ScrubReport {
  masked: number
}

function scrubText(text: string, report: ScrubReport): string {
  let out = text
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    const next = out.replace(pattern, replacement)
    if (next !== out) report.masked += 1
    out = next
  }
  return out
}

function scrubNode(node: unknown, report: ScrubReport): unknown {
  if (typeof node === 'string') return scrubText(node, report)
  if (Array.isArray(node)) return node.map((item) => scrubNode(item, report))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      const secret = SECRET_KEY.test(key) && !REFERENCE_KEYS.has(key)
      out[key] = secret ? maskField(item) : scrubNode(item, report)
    }
    return out
  }
  return node
}

/** 深度脱敏（渲染层版）。@returns 打过码的值 + 打了几处 */
export function scrubForExport(value: unknown): { value: unknown; masked: number } {
  const report: ScrubReport = { masked: 0 }
  return { value: scrubNode(value, report), masked: report.masked }
}

function findLeak(node: unknown, path: string): string {
  if (typeof node === 'string') {
    if (!node || node.startsWith('***') || node === MASKED_SECRET) return ''
    return CHECK_PATTERNS.some((pattern) => pattern.test(node)) ? path : ''
  }
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const hit = findLeak(node[index], `${path}[${index}]`)
      if (hit) return hit
    }
    return ''
  }
  if (node && typeof node === 'object') {
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      const here = `${path}.${key}`
      const value = typeof item === 'string' ? item : ''
      if (SECRET_KEY.test(key) && !REFERENCE_KEYS.has(key) && value && value !== MASKED_SECRET)
        return here
      const hit = findLeak(item, here)
      if (hit) return hit
    }
  }
  return ''
}

/** 落盘前的守位：返回第一处「像密钥却没打码」的路径，没有就给空串 */
export function findSecretLikeValue(value: unknown, path = '$'): string {
  return findLeak(value, path)
}

export interface DataPortCounts {
  sessions: number
  tasks: number
  memory: number
  audit: number
  skills: number
}

export interface ExportPayload {
  app: string
  schema: number
  version: string
  exportedAt: string
  counts: { sessions: number; tasks: number; memory: number; skills: number }
  sessions: SessionDetail[]
  tasks: TaskRecord[]
  memory: { items: MemoryItem[]; text: string; stats: MemoryStats }
  config: AppConfig | null
  skills: SkillInfo[]
  notes: string[]
}

/** 内核 task:list 上限 200；会话也设个上限，免得一次读几百个文件卡住界面 */
const MAX_TASKS = 200
const MAX_SESSIONS = 200

/** 轻量统计（面板显示「删掉多少」用）—— 不读会话正文 */
export async function countData(): Promise<DataPortCounts> {
  const [sessions, tasks, memory, audit, skills] = await Promise.all([
    listSessions(),
    taskList({ limit: MAX_TASKS }),
    memoryList({ includeSuperseded: true }),
    auditStats(90),
    listSkills(),
  ])
  return {
    sessions: sessions.length,
    tasks: tasks.length,
    memory: memory.length,
    audit: audit.total,
    skills: skills.length,
  }
}

/** 逐条读完整会话（含消息）—— 这是唯一的重活，所以单独一层 */
async function collectSessions(): Promise<{ items: SessionDetail[]; truncated: number }> {
  const summaries: SessionSummary[] = await listSessions()
  const kept = summaries.slice(0, MAX_SESSIONS)
  const items: SessionDetail[] = []
  for (const summary of kept) {
    const detail = await loadSession(summary.id)
    if (detail) items.push(detail)
  }
  return { items, truncated: Math.max(0, summaries.length - kept.length) }
}

export async function buildExportPayload(): Promise<ExportPayload> {
  const [sessionsResult, tasks, skills, memory, text, config] = await Promise.all([
    collectSessions(),
    taskList({ limit: MAX_TASKS }),
    listSkills(),
    memoryList({ includeSuperseded: true }),
    getMemory(),
    loadConfig(),
  ])

  const notes: string[] = [
    '密钥不在这个包里，也拿不到：credentials.json 只有主进程能读，这条链路上没有它的入口。',
  ]
  if (sessionsResult.truncated > 0) {
    notes.push(
      `会话超过 ${MAX_SESSIONS} 条，这次只装了前 ${MAX_SESSIONS} 条（差 ${sessionsResult.truncated} 条）。`,
    )
  }
  if (tasks.length >= MAX_TASKS) notes.push(`任务台账只装了最近 ${MAX_TASKS} 条。`)
  if (!config) notes.push('读不到配置（浏览器预览没有主进程），config 为空。')

  return {
    app: BRAND_NAME,
    schema: EXPORT_SCHEMA,
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      sessions: sessionsResult.items.length,
      tasks: tasks.length,
      memory: memory.length,
      skills: skills.length,
    },
    sessions: sessionsResult.items,
    tasks,
    memory: { items: memory, text: text.text, stats: text.stats },
    config,
    skills,
    notes,
  }
}

export interface ExportOutcome {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
  bytes?: number
  masked?: number
}

function stampName(): string {
  const now = new Date()
  const p = (value: number): string => String(value).padStart(2, '0')
  return `harbor-export-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

/** 导出全部：取数据 → 脱敏 → 复检 → 落盘（走现成的 export:saveText） */
export async function exportAll(): Promise<ExportOutcome> {
  const raw: unknown = await buildExportPayload()
  const scrubbed = scrubForExport(raw)
  const payload = scrubbed.value as ExportPayload
  if (scrubbed.masked > 0)
    payload.notes = [...payload.notes, `按脱敏规则改了 ${scrubbed.masked} 处疑似密钥。`]

  const leak = findSecretLikeValue(payload)
  if (leak) return { ok: false, error: `导出内容里还有未打码的疑似密钥（${leak}），已拒绝落盘` }

  const json = JSON.stringify(payload, null, 2)
  const result = await saveText(stampName(), json)
  if (!result.ok) return { ok: false, canceled: result.canceled, error: result.error }
  return { ok: true, path: result.path, bytes: json.length, masked: scrubbed.masked }
}

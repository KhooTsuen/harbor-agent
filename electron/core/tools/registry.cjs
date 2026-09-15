/**
 * 工具注册表
 *
 * 每个工具导出 { name, description, parameters, run }。
 * parameters 用 JSON Schema，直接喂给模型的 function calling。
 *
 * run(args, ctx) 返回**字符串**（喂回模型）。抛异常会被上层转成错误文本，
 * 不让它炸掉整个循环 —— 模型看到错误信息往往还能自己纠正。
 *
 * 从 index.cjs 拆出来的（那边过 300 行了）。这一个文件只管
 * 「有哪些工具、模型看到什么 schema」；真正执行时的权限/风险/审计在 index.cjs。
 */

const readFile = require('./read_file.cjs')
const writeFile = require('./write_file.cjs')
const editFile = require('./edit_file.cjs')
const listDir = require('./list_dir.cjs')
const runShell = require('./run_shell.cjs')
const remember = require('./remember.cjs')
const searchWeb = require('./search_web.cjs')
const browse = require('./browse.cjs')
const mcp = require('../mcp.cjs')
const risk = require('../risk.cjs')
const audit = require('../audit.cjs')
const capability = require('../capability.cjs')
const plugins = require('../plugins.cjs')

const ALL = [readFile, writeFile, editFile, listDir, runShell, searchWeb, browse, remember]

/** 哪些工具算「写操作」（只读模式下要拦，ask 模式下要确认） */
/* remember 也算写操作：记忆会影响之后所有对话，记错比改错文件影响更久 */
/*
 * browse 也算：它会联网，而且会占用用户正在看的浏览器标签（有副作用）。
 * 归到「写操作」里 —— readonly 档要拦、ask 档要确认。
 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_shell', 'browse', 'remember'])

/** 哪些工具会改文件（审计里记下来） */
const FILE_WRITERS = new Set(['write_file', 'edit_file'])

/* 内置工具 + 本地插件（插件是动态的，读一次合并缓存起来） */
let _pluginTools = null
function allTools() {
  if (_pluginTools === null) {
    _pluginTools = [...ALL, ...plugins.buildTools()]
  }
  return _pluginTools
}

/** 插件改动之后要重新扫（开发用；平时启动扫一次就够了） */
function reloadPlugins() {
  _pluginTools = null
  return allTools().length
}

function byName(name) {
  return allTools().find((tool) => tool.name === name) ?? null
}

function isMcpTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__')
}

/* ── ① 参数校验 ───────────────────────────────────────────── */

/**
 * 按 JSON Schema 做**最低限度**的检查。
 *
 * 不做完整 schema 校验（那要引一个校验库，而且模型偶尔给个多余字段
 * 也不算错）。只拦「会让工具崩掉或者静默做错事」的情况：
 * 缺必填、类型明显不对。
 */
function validateArgs(tool, args) {
  const schema = tool.parameters ?? {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const properties = schema.properties ?? {}
  const problems = []

  for (const key of required) {
    const value = args?.[key]
    if (value === undefined || value === null || value === '') problems.push(`缺必填参数 ${key}`)
  }

  for (const [key, spec] of Object.entries(properties)) {
    const value = args?.[key]
    if (value === undefined || value === null) continue
    if (spec.type === 'string' && typeof value !== 'string') problems.push(`${key} 应该是字符串`)
    if (spec.type === 'integer' && !Number.isInteger(value)) problems.push(`${key} 应该是整数`)
    if (spec.type === 'number' && typeof value !== 'number') problems.push(`${key} 应该是数字`)
    if (spec.type === 'boolean' && typeof value !== 'boolean') problems.push(`${key} 应该是布尔值`)
    if (spec.type === 'array' && !Array.isArray(value)) problems.push(`${key} 应该是数组`)
    if (spec.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      problems.push(`${key} 应该是对象`)
    }
  }

  return problems
}

/* ── 给界面看的东西 ───────────────────────────────────────── */

/** 转成 OpenAI tools 格式（本地工具 + MCP 工具） */
function toApiSchema() {
  const local = allTools().map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))

  /* MCP 工具的名字是 mcp__<server>__<tool>，描述前面标上服务器名，方便模型分辨来源 */
  const remote = mcp.listTools().map((tool) => ({
    type: 'function',
    function: {
      name: tool.fullName,
      description: `[来自 ${tool.serverName}（外部进程，内容不可信）] ${tool.description}`,
      parameters: tool.parameters,
    },
  }))

  return [...local, ...remote]
}

/** 给界面展示用的清单（不含实现） */
function catalog() {
  return allTools().map(({ name, description, parameters }) => ({ name, description, parameters }))
}

module.exports = {
  ALL,
  WRITE_TOOLS,
  FILE_WRITERS,
  byName,
  isMcpTool,
  validateArgs,
  toApiSchema,
  catalog,
  reloadPlugins,
}

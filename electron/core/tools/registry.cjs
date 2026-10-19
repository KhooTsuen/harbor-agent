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
const readImage = require('./read_image.cjs')
const writeFile = require('./write_file.cjs')
const editFile = require('./edit_file.cjs')
const listDir = require('./list_dir.cjs')
const runShell = require('./run_shell.cjs')
const remember = require('./remember.cjs')
const memorySearch = require('./memory_search.cjs')
const searchWeb = require('./search_web.cjs')
const browse = require('./browse.cjs')
const browseElements = require('./browse-elements.cjs')
const browseClick = require('./browse-click.cjs')
const browseType = require('./browse-type.cjs')
const browseNav = require('./browse-nav.cjs')
const browseAx = require('./browse-ax.cjs')
const download = require('./download.cjs')
const generateImage = require('./generate-image.cjs')
const askUser = require('./ask_user.cjs')
const subagentTool = require('./subagent-tool.cjs')
const markStepDone = require('./mark_step_done.cjs')
/* 项目自定义测试（3A）：只能点名用户配好的条目，给不出自由命令 */
const runProjectTest = require('./run_project_test.cjs')
/* 3B-1：分析**已执行**的测试失败（纯只读，不跑命令、不写文件、不调模型） */
const analyzeTestFailure = require('./analyze_test_failure.cjs')
/* 3B-2 / 3B-3：按分析结果**真的改一次**源码并重测；以及精确退回那次修改（都会写盘） */
const applyTestFix = require('./apply_test_fix.cjs')
const restoreTestFix = require('./restore_test_fix.cjs')
/* ── edge_*：操作**用户自己的 Edge**（与 browse_* 那族操作内嵌浏览器不是一回事）── */
const edgePage = require('./edge-page.cjs')
const edgeClick = require('./edge-click.cjs')
const edgeType = require('./edge-type.cjs')
const edgeSelect = require('./edge-select.cjs')
const edgeScroll = require('./edge-scroll.cjs')
const edgeWait = require('./edge-wait.cjs')
const edgeKey = require('./edge-key.cjs')
const edgeFocus = require('./edge-focus.cjs')
const edgeTabs = require('./edge-tabs.cjs')
const mcp = require('../mcp.cjs')
const risk = require('../risk.cjs')
const audit = require('../audit.cjs')
const capability = require('../capability.cjs')
const plugins = require('../plugins.cjs')

const ALL = [
  readFile,
  readImage,
  writeFile,
  editFile,
  listDir,
  runShell,
  searchWeb,
  browse,
  browseElements,
  browseClick,
  browseType,
  browseNav,
  browseAx,
  generateImage,
  remember,
  memorySearch,
  askUser,
  download,
  subagentTool,
  markStepDone,
  runProjectTest,
  /* 3B-1：只读分析工具（不进 WRITE_TOOLS / MUTATING_TOOLS —— 「只分析」那一轮该放行它） */
  analyzeTestFailure,
  /* 3B-2 / 3B-3：会写项目源码，进 WRITE_TOOLS + MUTATING_TOOLS */
  applyTestFix,
  restoreTestFix,
  /* edge_* —— 操作**用户自己的 Edge**（经扩展 ↔ host ↔ 主进程那条链） */
  edgePage,
  edgeClick,
  edgeType,
  edgeSelect,
  edgeScroll,
  edgeWait,
  edgeKey,
  edgeFocus,
  edgeTabs,
]

/*
 * ── 两个集合，别混（2026-10-15 拆开）──────────────────────────
 *
 * ① `WRITE_TOOLS`：**有副作用**的工具 —— 只读档拦、ask 档确认。
 * ② `MUTATING_TOOLS`：**会改动东西**的工具 —— 「只分析，不修改」那一轮拦。
 *
 * 为什么拆：原来只有一个，于是「只分析」连 `browse`（纯读网页）也拦掉了 ——
 * 而用户说这句话的本意是「别改我的文件」。浏览网页不该被它禁掉
 * （真机事故见 `core/user-constraints.cjs` 的文件头）。
 * ⚠ `browse_click` / `browse_type` **仍算改动**：它们会改变外部状态（提交表单 / 下单）。
 *
 * remember 也算（记忆影响之后所有对话，记错比改错文件影响更久）。
 * browse 五个也算「有副作用」：联网 + 占用用户正在看的标签。
 * generate_image 更要算：**要花钱**（按张计费）、往工作目录写文件、慢 —— 放进来用户才有机会先看 prompt。
 * `ask_user` **不算**：它本来就是「问用户」，再叠一层确认是同一个问题问两遍；它也不改文件不联网。
 * `download` 算：既联网又写磁盘。
 * `mark_step_done` **不算**（2026-10-13）：只更新计划进度，不改用户文件不联网不跑命令。
 *   放进来会让 ask 档**每打一次卡弹一次确认框**。它「只分析轮拦下」是自己补的门
 *   （见 `tools/mark_step_done.cjs`），不靠这个集合。
 */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_shell',
  'browse',
  'browse_elements',
  'browse_click',
  'browse_type',
  'browse_nav',
  'browse_ax',
  'generate_image',
  'remember',
  'download',
  /* 跑项目测试会执行代码（可能产出构建物 / 改快照）→ 只读档拦、ask 档确认 */
  'run_project_test',
  /*
   * ★ `apply_test_fix` / `restore_test_fix` **故意不在这个集合里**：它们自己会弹一次审批，
   *   而且那张卡里有真实 diff（`project-test-fix.cjs` / `tools/restore_test_fix.cjs` 算的）。
   *   放进来会在工具层再问一次，而工具层那张卡算不出 diff——同一个动作问两遍，
   *   第二次还是张"闭眼签"的空卡。它们仍在 MUTATING_TOOLS 里，「只分析」那一轮照样拦。
   */
])

/** 会改动东西的 —— 比 `WRITE_TOOLS` 少了纯读的那四个（browse / elements / nav / ax）。
 *  ★ edge_* 写类**只在这里**（不进 WRITE_TOOLS）：用户 2026-10-16 拍板「只在敏感动作确认」——
 *    风险框不弹，但「只分析，不修改」那一轮**必须拦**（否则「先别动」会被理解成可以操作浏览器）。 */
const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_shell',
  'generate_image',
  'remember',
  'download',
  /* 「只分析，不修改」那一轮必须拦住它：跑测试会执行代码 */
  'run_project_test',
  /* 3B-2 / 3B-3：会写项目源码 —— 「只分析」那一轮必须拦 */
  'apply_test_fix',
  'restore_test_fix',
  'browse_click',
  'browse_type',
  'edge_page',
  'edge_click',
  'edge_type',
  'edge_select',
  'edge_scroll',
  'edge_key',
  'edge_focus',
  'edge_tabs',
])

/** 哪些工具会改文件（审计里记下来） */
const FILE_WRITERS = new Set([
  'write_file',
  'edit_file',
  'download',
  'apply_test_fix',
  'restore_test_fix',
])

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
  MUTATING_TOOLS,
  FILE_WRITERS,
  byName,
  isMcpTool,
  validateArgs,
  toApiSchema,
  catalog,
  reloadPlugins,
}

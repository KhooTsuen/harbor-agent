/**
 * 工具箱地图 —— 系统提示里 `## Tools` 那一层的生产者
 *
 * 从 `loop-prompt.cjs` 拆出来的两个理由：那边贴着 300 行红线；而「有哪些工具、
 * 什么时候该掏哪个」自成一体（一张分组表 + 一张导向表 + 一段渲染）。
 *
 * ★ 为什么要它（2026-10-13 用户报「模型有时候不知道自己有哪些工具可用，行为被动」）：
 *   原来那层是 `description.split('。')[0]` 一行一个工具 —— 实测 **19 个里 14 个**的
 *   「什么时候该用它」正好写在第二句，被切掉了。例：
 *     · `list_dir` 丢了「不确定项目结构时先看这里」
 *     · `write_file` 丢了「小改动请优先用 edit_file」
 *     · `memory_search` 丢了「想确认某约定/偏好是否被记录过时用它搜」
 *   而且清单平铺无分组，`browse_*` 独占 6/19（32%）。模型看到一堆「这是什么」，
 *   看不到「什么时候用哪把」——这正是「被动」的一个可解释来源。
 *
 * ★ 三条纪律：
 *   ① **工具名手写在分组表里**（分组是人的判断，registry 里没有这个信息）→
 *      所以有自检钉住「分组表 ∪ 导向表 的工具名集合 === tools.ALL」，
 *      否则以后新增工具漏进地图**没有任何东西会报**（见自检 `93-machine-prompt`）。
 *   ② **一个工具都不删减**：地图是「导航」，不是「精选」。19 个全在。
 *   ③ 渲染只用**手写导向**，不退回描述第一句当主力 —— 第一句只说「是什么」，
 *      而这一层的全部价值在「什么时候用」。实在没导向的才回落到第一句（并会被自检逮住）。
 */

const tools = require('./tools/index.cjs')

/**
 * 工具数超过这个值就退化：只出「分组名 + 计数」，不再逐条写用途。
 *
 * 为什么要有：系统提示**不参与** `context-builder` 的裁剪（那边只裁 memory/project/
 * task/conversation 四层）—— 这一层加进去的字是**每轮固定成本**，没有任何机制会替你裁。
 *
 * ★ 24 → 32（2026-10-16）：`edge_*` 那族（9 个）接进来后本地工具到 28 个，按 24 判会
 *   让**整层退化**成「分组名 + 计数」—— 而这层的全部价值就在「什么时候该用哪一个」
 *   （文件头那段 2026-10-13 的教训）。32 留一点余量给后续模块。
 *   ⚠️ 再加工具时要**重新权衡**：超了就该考虑让新族走「分组名 + 计数」（而不是一直抬）。
 */
const MAX_DETAILED = 40

/**
 * 按**使用场景**分组，顺序照一次任务的实际流程走：
 * 先摸清现状 → 改 → 跑 → 上网查 → 记下来 → 协作收尾。
 *
 * 组名与成员都手写（见文件头 ①）。
 */
const TOOL_GROUPS = [
  { title: '摸清现状（动手前）', tools: ['list_dir', 'read_file', 'read_image'] },
  { title: '改文件', tools: ['edit_file', 'write_file', 'download'] },
  {
    title: '跑命令与测试',
    tools: [
      'run_shell',
      'run_project_test',
      'analyze_test_failure',
      'apply_test_fix',
      'restore_test_fix',
    ],
  },
  {
    title: '上网查（先 search，再 browse，要操作才 elements/click/type）',
    tools: [
      'search_web',
      'browse',
      'browse_elements',
      'browse_click',
      'browse_type',
      'browse_nav',
      'browse_ax',
    ],
  },
  {
    title: '操作用户的 Edge（要动**他自己正开着的**浏览器时才用；只读网页用 browse）',
    tools: [
      'edge_page',
      'edge_wait',
      'edge_click',
      'edge_type',
      'edge_select',
      'edge_scroll',
      'edge_key',
      'edge_focus',
      'edge_tabs',
    ],
  },
  { title: '长期记忆', tools: ['memory_search', 'remember'] },
  {
    title: '协作与治理',
    tools: ['ask_user', 'mark_step_done', 'spawn_subagent', 'generate_image'],
  },
]

/** 每个工具一句话：**重点写「什么时候该掏它」**，不是复述它是什么（键集合有自检钉） */
const TOOL_HINTS = {
  list_dir: '不确定项目结构时先看这里',
  read_file: '不确定路径先用 list_dir；大文件给 offset/limit',
  read_image: '用户提到图片或你发现图片路径时用它看真实图像，无法识别要如实说明',
  edit_file: '改少量内容优先用它，比 write_file 安全',
  write_file: '只有新建文件、或整体重写才用它',
  download: '存文件到磁盘；网页正文要用 browse，别用它',
  run_shell: '需要交互的命令别用它（会卡住）；可以给 cwd',
  run_project_test:
    '跑用户为某个项目配好的测试（只能给 id，命令由用户配置）；没配置就先用 list_dir / read_file 看清项目',
  search_web: '你的知识里没有、或可能已经变了的，先用它',
  browse: '要读整页正文 / JS 渲染的页面；只是中转读一眼，传 sameTab',
  browse_elements: '要操作页面，先看这儿有什么、能点什么',
  browse_click: '按 browse_elements 给的索引点',
  browse_type: '往输入框打字；填密码要先得到用户明确授权',
  browse_nav: '回上一步 / 下一页，别重开同一个地址',
  browse_ax: '读菜单 / 表单 / 表格的语义结构',
  /* ── edge_*：动的是**用户自己的 Edge**（与 browse_* 操作内嵌浏览器不是一回事）── */
  edge_page: '在他自己的 Edge 里打开地址并读回元素引用；不传 url 就只读当前页',
  edge_wait: '等条件满足（timeoutMs 0 = 立刻验一次）；不改成页面',
  edge_click: '按 edge_page 的引用点；提交/删除类会**先问用户**，引用失效则不点',
  edge_type: '往输入框填；密码与信用卡字段会被拒（让他自己输）',
  edge_select: '下拉框选值；找不到会把可选值都列出来',
  edge_scroll: '滚到顶/底或按像素；给了 ref 就滚到那个元素',
  edge_key: '真实按键（Enter/Tab/Escape）；有些控件只认键盘',
  edge_focus: '先聚焦再按键；输入法与「失焦才校验」的表单要它',
  edge_tabs: '列/搜/切/新建/关**他的**标签页；close 不可逆，会先确认在列表里',
  memory_search: '想确认「他以前说过吗」先搜它，别猜',
  remember: '记用户的习惯 / 项目约定 / 明确说过的偏好',
  ask_user: '要用户拍板先问（需求含糊 / 不可逆 / 范围不清）',
  mark_step_done: '做完一步打卡；它不验证，验证照常跑命令',
  /* 3B-1：只读分析工具（不跑命令、不写文件、不重跑测试） */
  analyze_test_failure: '测试挂了想先弄清原因时用它；它只分析已有结果，不重跑',
  /* 3B-2 / 3B-3：分析完之后真的动手 —— 会写源码，逐次审批 */
  apply_test_fix: '分析完、有具体改法时用它改那一处并重测；会写盘，需用户点头',
  restore_test_fix: '这次修复改坏了要退回时用它；只回退那次改过的文件',
  spawn_subagent: '要读很多份、但只要结论',
  generate_image: '提交生图任务；它立刻返回、不等出图',
}

/** 兜底：没写导向的工具回落到描述第一句（自检会报红，逼着补） */
const firstSentence = (tool) => (tool ? String(tool.description ?? '').split('。')[0] : '')

/**
 * 渲染「工具箱地图」正文（不含插件 / MCP 段，那两段由调用方拼在后面）。
 *
 * @param {Array} list 工具数组（默认全部内置工具）；可注入以便自检考退化分支
 */
function buildToolMap(list = tools.ALL) {
  const names = list.map((t) => t.name)
  const nameSet = new Set(names)
  const byName = new Map(list.map((t) => [t.name, t]))
  const header = '**先看这张图再动手**；每个工具的完整参数在 function calling 的 schema 里。'
  const hintOf = (n) => TOOL_HINTS[n] ?? firstSentence(byName.get(n))

  /* 退化分支：工具太多 → 只出分组名 + 计数，细节交给 schema（见 MAX_DETAILED 的注释） */
  if (list.length > MAX_DETAILED) {
    const rows = TOOL_GROUPS.map((g) => {
      const n = g.tools.filter((x) => nameSet.has(x)).length
      return n > 0 ? `- **${g.title}**：${n} 个` : ''
    }).filter(Boolean)
    const mapped = new Set(TOOL_GROUPS.flatMap((g) => g.tools))
    const rest = names.filter((n) => !mapped.has(n)).length
    if (rest > 0) rows.push(`- **其他**：${rest} 个`)
    return [header, ...rows, `工具较多（${list.length} 个），每个的用途与参数看 schema。`].join(
      '\n',
    )
  }

  const lines = [header]
  const covered = new Set()
  for (const g of TOOL_GROUPS) {
    const items = g.tools.filter((n) => nameSet.has(n))
    if (items.length === 0) continue
    for (const n of items) covered.add(n)
    lines.push(`- **${g.title}**：${items.map((n) => `\`${n}\`（${hintOf(n)}）`).join('、')}`)
  }
  /* 没进任何分组的（新加工具忘了分组）也要露出来 —— 自检会报，但运行时不许静默丢 */
  const rest = names.filter((n) => !covered.has(n))
  if (rest.length > 0) {
    lines.push(`- **其他**：${rest.map((n) => `\`${n}\`（${hintOf(n)}）`).join('、')}`)
  }
  return lines.join('\n')
}

/**
 * `## Tools` 那一层的完整正文：内置地图 + 本地插件清单 + MCP 服务器清单。
 *
 * 插件 / MCP 两段**由调用方传进来**（不在这里 require `plugins.cjs` / `mcp-hint.cjs`）——
 * 这一层要保持「纯渲染」，自检才能直接 require 它而不触发扫插件目录之类的副作用。
 */
function toolsSection({ pluginList = '', remote = '' } = {}) {
  const blocks = [buildToolMap()]
  if (pluginList) {
    /* 插件清单：让模型在**文字层面**知道有哪些插件、何时用；完整参数 schema 在 function calling 里 */
    blocks.push('\n【本地插件（装在 data/plugins/ 下，各自描述为准）】')
    blocks.push(pluginList)
  }
  /* MCP 服务器：连上了才写，免得新对话一开始就列一堆连不上的名字 */
  if (remote) blocks.push(remote)
  return blocks.join('\n')
}

module.exports = { TOOL_GROUPS, TOOL_HINTS, MAX_DETAILED, buildToolMap, toolsSection }

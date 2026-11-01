import type { SettingsTabId } from './parts'

/* ══════════════════════════════════════════════════════════════
   P3 #20：设置搜索的**索引**

   ── 为什么是一张手写的表，而不是去扫 DOM ──────────────────────
   扫 DOM 只能搜到当前页（其余标签页没挂载），且扫到的是渲染后文案（搜「深色」时
   界面写的可能是「配色」）。这里维护「设置项 → 所在页」：① 搜得到没打开的页里的项；
   ② 结果里显示它在哪一页；③ 点结果能定位过去。

   ── 维护规矩 ─────────────────────────────────────────────────
   加一个用户看得见的设置项，就**在这一页里加一条**。只收「用户会搜的叫法」，
   不收实现细节（内部字段名搜它没意义）。

   ★ 只索引**真实存在**的设置项：文档明确要求「不生成不存在的设置」。
     每一项都指向 `SETTINGS_TABS` 里真有的页；查不到就不算命中（不编一条出来）。

   ── 为什么单独一个文件 ──────────────────────────────────────
   40+ 条数据 Prettier 会逐条展开，和算法放一起就破 300 行红线
   （加设置项动这里，改匹配规则动 `settingsSearch.ts`）。
   ══════════════════════════════════════════════════════════════ */

export interface SettingsEntry {
  /** 属于哪一页（点结果就跳过去） */
  tab: SettingsTabId
  /** 这一项在界面上叫什么 */
  label: string
  /** 一句话解释（结果里显示，帮用户确认是不是他要的） */
  hint: string
  /** 用户可能搜的其他叫法：同义词、常见中文说法、专业词 */
  keywords: string[]
}

/** 设置项索引（按页分组写，读起来就是「这一页有什么」） */
export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  /* ── 个人资料 ── */
  { tab: 'profile', label: '昵称', hint: '助手怎么称呼你', keywords: ['名字', '称呼', 'name'] },
  { tab: 'profile', label: '头像', hint: '界面里显示的头像', keywords: ['头像', 'avatar', '图片'] },

  /* ── 通用 ── */
  {
    tab: 'general',
    label: '启动动画',
    hint: '关掉后跳过启动页直接进主界面',
    keywords: ['启动', '开屏', 'boot', '跳过'],
  },
  {
    tab: 'general',
    label: '快捷键',
    hint: '自定义键盘快捷键',
    keywords: ['快捷键', '按键', 'shortcut', '热键'],
  },
  {
    tab: 'general',
    label: '语言',
    hint: '界面语言',
    keywords: ['语言', '中文', '英文', 'language'],
  },

  /* ── 外观 ── */
  {
    tab: 'appearance',
    label: '字体',
    hint: '界面使用的字体家族',
    keywords: ['字体', 'font', '字形', '苹果字体'],
  },
  {
    tab: 'appearance',
    label: '字号缩放',
    hint: '整体放大或缩小界面文字（90–150）',
    keywords: ['字号', '大小', '缩放', 'zoom', '字大'],
  },
  {
    tab: 'appearance',
    label: '配色',
    hint: '界面主题（深色 / 浅色等）',
    keywords: ['主题', '深色', '暗色', '浅色', '亮色', 'dark', 'light', 'theme'],
  },
  {
    tab: 'appearance',
    label: '玻璃拟态',
    hint: '磨砂半透明材质',
    keywords: ['玻璃', '毛玻璃', '磨砂', 'glass', '模糊'],
  },
  {
    tab: 'appearance',
    label: '动效',
    hint: '关闭后所有过渡与动画停止',
    keywords: ['动画', '动效', 'animation', '卡顿'],
  },
  {
    tab: 'appearance',
    label: '减少 ASCII 动效',
    hint: '停掉启动页海浪计算',
    keywords: ['ascii', '启动页', '海浪', '性能'],
  },
  {
    tab: 'appearance',
    label: '侧栏宽度',
    hint: '左侧对话栏的宽度',
    keywords: ['侧栏', '宽度', 'sidebar'],
  },

  /* ── 对话 ── */
  /* 这一条压成单行（≤100 字符）—— 这份表贴着 300 行红线，prettier 一展开就破线 */
  {
    tab: 'conversation',
    label: '默认工作目录',
    hint: '全局默认：没挂目录的对话在哪开工',
    keywords: ['工作目录', 'workdir'],
  },
  {
    tab: 'conversation',
    label: '回答深度',
    hint: '默认的回答详细程度',
    keywords: ['深度', '详细', '简洁', '回答长度', 'depth'],
  },
  {
    tab: 'conversation',
    label: '发送方式',
    hint: 'Enter 发送还是 Ctrl+Enter 发送',
    keywords: ['发送', '回车', 'enter', 'ctrl'],
  },
  {
    tab: 'conversation',
    label: '打字机速度',
    hint: '文字逐字出现的速度',
    keywords: ['打字机', '速度', 'typewriter'],
  },
  {
    tab: 'conversation',
    label: '每轮结束显示结果摘要',
    hint: '一轮跑完后在输入框上方给一张结果卡（默认关）',
    keywords: ['摘要', '总结', '结果', 'summary'],
  },
  {
    tab: 'conversation',
    label: '设置视图（简洁 / 详细）',
    hint: '只改变设置页展示层次，不改配置',
    keywords: ['简洁', '详细', '视图', '简单模式', '高级设置'],
  },
  {
    tab: 'conversation',
    label: '生图保存目录',
    hint: '生成的图片存到哪',
    keywords: ['生图', '图片', '保存', '目录'],
  },
  {
    tab: 'conversation',
    label: '下载保存目录',
    hint: '下载的文件存到哪',
    keywords: ['下载', '保存', '目录', '路径'],
  },
  {
    tab: 'conversation',
    label: '项目上下文',
    hint: '当前项目的额外说明',
    keywords: ['项目', '上下文', 'context'],
  },

  /* ── 模型 ── */
  {
    tab: 'models',
    label: '供应商',
    hint: '模型服务的连接配置',
    keywords: ['供应商', '接口', 'provider', 'api', '后端'],
  },
  {
    tab: 'models',
    label: 'API Key',
    hint: '访问模型服务用的密钥',
    keywords: ['密钥', 'key', 'token', '凭据'],
  },
  {
    tab: 'models',
    label: '模型列表',
    hint: '这个连接下可选的模型',
    keywords: ['模型', 'model', '模型名'],
  },
  {
    tab: 'models',
    label: '连接测试',
    hint: '实际请求一次，看连不连得上',
    keywords: ['测试', '连接', '通不通', 'ping'],
  },
  {
    tab: 'models',
    label: '温度',
    hint: '回答的随机程度',
    keywords: ['温度', 'temperature', '随机'],
  },
  {
    tab: 'models',
    label: '系统提示词',
    hint: '追加到系统提示的自定义内容',
    keywords: ['提示词', 'prompt', '系统提示', '人设'],
  },

  /* ── 权限与安全 ── */
  {
    tab: 'access',
    label: '工具权限',
    hint: '只读 / 每次确认 / 完全访问',
    keywords: ['权限', '允许', '确认', 'permission', '只读', '完全访问'],
  },
  {
    tab: 'access',
    label: '文件访问范围',
    hint: '只能读工作目录，还是能读授权路径',
    keywords: ['文件', '范围', '路径', '授权', 'scope'],
  },
  {
    tab: 'access',
    label: '命令风险策略',
    hint: '低 / 中 / 高风险命令分别怎么办',
    keywords: ['命令', '风险', '策略', 'shell', '拦截'],
  },
  {
    tab: 'access',
    label: '网络策略',
    hint: '哪些地址允许访问',
    keywords: ['网络', '联网', '域名', 'network'],
  },
  {
    tab: 'access',
    label: '审计记录',
    hint: '查谁在什么时候做了什么',
    keywords: ['审计', '日志', '记录', 'audit'],
  },

  /* ── 数据与用量 ── */
  {
    tab: 'datausage',
    label: '用量与预算',
    hint: '花了多少 token / 钱',
    keywords: ['用量', '预算', '花费', 'token', '消耗', '钱'],
  },
  {
    tab: 'datausage',
    label: '备份',
    hint: '定期把数据存一份',
    keywords: ['备份', '恢复', 'backup', '存档'],
  },
  {
    tab: 'datausage',
    label: '导出对话',
    hint: '转成 Markdown / JSON',
    keywords: ['导出', 'export', 'markdown', 'json'],
  },
  { tab: 'datausage', label: '导入数据', hint: '从别处导回来的数据', keywords: ['导入', 'import'] },
  {
    tab: 'datausage',
    label: '诊断包',
    hint: '排查问题时给的一份现场',
    keywords: ['诊断', '排查', '报错', 'diagnostics'],
  },
  {
    tab: 'datausage',
    label: '清空数据',
    hint: '删除会话与设置（不可撤销）',
    keywords: ['清空', '删除', '重置', 'reset', '恢复默认'],
  },

  /* ── 扩展 ── */
  {
    tab: 'extension',
    label: '技能',
    hint: '给助手挂上可复用的做法',
    keywords: ['技能', 'skill', '插件'],
  },
  {
    tab: 'extension',
    label: 'MCP 服务器',
    hint: '外接工具（Model Context Protocol）',
    keywords: ['mcp', '外部工具', '扩展', '服务器'],
  },

  /* ── 记忆 ── */
  {
    tab: 'memory',
    label: '长期记忆',
    hint: '助手记住的关于你的事',
    keywords: ['记忆', '记住', 'memory', '偏好'],
  },
  {
    tab: 'memory',
    label: '记忆解释',
    hint: '这条记忆是哪来的、怎么用上的',
    keywords: ['记忆', '解释', '来源'],
  },

  /* ── 关于 ── */
  {
    tab: 'about',
    label: '版本信息',
    hint: '当前版本与更新状态',
    keywords: ['版本', 'version', '关于', '更新'],
  },
] as const

import type { SettingsEntry } from './settingsIndexTypes'

/* 设置项索引 · 第二半（能力与安全 + 数据与知识 + 系统）

   拆法见 `settingsIndexBasic.ts` 的文件头。 */

export const SETTINGS_INDEX_REST: readonly SettingsEntry[] = [
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

  /* ── 模型用量（第一阶段：用量与数据拆成两页）── */
  {
    tab: 'usage',
    label: '用量与预算',
    hint: '花了多少 token / 钱',
    keywords: ['用量', '预算', '花费', 'token', '消耗', '钱'],
  },
  {
    tab: 'usage',
    label: '账户余额',
    hint: '查服务商还剩多少额度',
    keywords: ['余额', '额度', 'balance', '充值'],
  },

  /* ── 数据与存储 ── */
  {
    tab: 'data',
    label: '数据存放位置',
    hint: '存在哪个目录、能不能搬家',
    keywords: ['数据目录', '存放', '位置', '迁移', '搬'],
  },
  {
    tab: 'data',
    label: '备份',
    hint: '定期把数据存一份',
    keywords: ['备份', '恢复', 'backup', '存档'],
  },
  {
    tab: 'data',
    label: '导出对话',
    hint: '转成 Markdown / JSON',
    keywords: ['导出', 'export', 'markdown', 'json'],
  },
  { tab: 'data', label: '导入数据', hint: '从别处导回来的数据', keywords: ['导入', 'import'] },
  {
    tab: 'data',
    label: '诊断包',
    hint: '排查问题时给的一份现场',
    keywords: ['诊断', '排查', '报错', 'diagnostics'],
  },
  {
    tab: 'data',
    label: '清空数据',
    hint: '删除会话与设置（不可撤销）',
    keywords: ['清空', '删除', '重置', 'reset', '恢复默认'],
  },

  /* ── 扩展 ── */
  /* 这一条压成单行：这份表贴着 300 行红线，prettier 一展开就破线 */
  { tab: 'extension', label: '安装浏览器插件', hint: 'Edge 侧边栏', keywords: ['edge', '插件'] },
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
  /* 下面两条压成单行（≤100 字符）：这份表贴着 300 行红线，prettier 一展开就破线 */
  { tab: 'experience', label: '经验与规则', hint: '真跑验证过的做法', keywords: ['经验'] },
  { tab: 'experience', label: '被打停的经验', hint: '已停止注入', keywords: ['反例'] },

  /* ── 关于 ── */
  {
    tab: 'about',
    label: '版本信息',
    hint: '当前版本与更新状态',
    keywords: ['版本', 'version', '关于', '更新'],
  },
] as const

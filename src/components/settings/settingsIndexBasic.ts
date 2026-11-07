import type { SettingsEntry } from './settingsIndexTypes'

/* 设置项索引 · 第一半（基础 + 智能体与模型）

   数据按导航分组拆成两个文件：这一份 314 行超红线，而 prettier 会把
   每条数据展开成多行 —— 单靠压注释腾不出空间。
   ★ 统一出口是 `settingsIndex.ts`，别的地方不要直接 import 这两个文件。 */

export const SETTINGS_INDEX_BASIC: readonly SettingsEntry[] = [
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
  /* 工作目录 / 项目上下文在第一阶段搬去了 `context` 页 —— 索引跟着走，否则搜到点进去是空页 */
  {
    tab: 'context',
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
  /* 「发送方式」就是通用页的回车发送 —— 第二阶段核实时发现它一直标错页 */
  {
    tab: 'general',
    label: '发送方式',
    hint: 'Enter 发送还是 Ctrl+Enter 发送',
    keywords: ['发送', '回车', 'enter', 'ctrl'],
  },
  /* 第二阶段从「通用」搬进「对话与任务」的两项 */
  {
    tab: 'conversation',
    label: '默认模式',
    hint: '新建对话时用哪个模式（pair / plan / execute / goal）',
    keywords: ['模式', 'mode', '默认', '计划', '执行'],
  },
  {
    tab: 'conversation',
    label: '自动起标题',
    hint: '第一轮结束后让模型起标题',
    keywords: ['标题', '起名', 'title', '名称'],
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
    tab: 'context',
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
] as const

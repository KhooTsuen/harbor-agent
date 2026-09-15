const memory = require('../memory.cjs')

/**
 * remember —— 让模型主动往记忆里记东西
 *
 * 这是写操作：ask 权限下会弹确认。理由是「记忆会影响之后所有对话」，
 * 记错了比改错一个文件影响更久。
 */
module.exports = {
  name: 'remember',
  description:
    '把一条关于用户的事实或偏好记到长期记忆里，之后的对话都会看到。适合记：用户的习惯、项目约定、明确说过的偏好。不适合记：当前任务的临时细节、能从代码里读出来的东西。',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '要记的内容，一句话，比如「打包产物不要超过 500KB」',
      },
    },
    required: ['content'],
  },

  async run(args) {
    const text = String(args.content ?? '').trim()
    if (!text) throw new Error('内容是空的')

    const result = memory.append(text)
    if (!result.ok) throw new Error(result.error ?? '写入失败')

    const stats = memory.stats()
    const tail = stats.overLimit ? `（记忆已有 ${stats.length} 字，偏长了，建议清理）` : ''
    return result.skipped ? `这条已经在记忆里了，没重复写。${tail}` : `记下了。${tail}`
  },

  summarize(args) {
    return `记到长期记忆：${String(args.content ?? '').slice(0, 80)}`
  },
}

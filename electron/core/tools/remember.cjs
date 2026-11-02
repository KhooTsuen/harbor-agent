const memory = require('../memory.cjs')

/**
 * remember —— 让模型主动往记忆里记东西
 *
 * 这是写操作：ask 权限下会弹确认。理由是「记忆会影响之后所有对话」，
 * 记错了比改错一个文件影响更久。
 *
 * `type` 是**可选**的：不填按 fact 记。让模型自己说清「这是约束还是偏好」
 * 比一律塞成 fact 有用得多 —— 类型既决定检索时该不该被优先遵守
 * （`memory-explain.cjs` 的权重表），也决定新的一条会不会取代旧的
 * （`memory-similarity.cjs` 的 CONFLICT_TYPES，fact 不在其中）。
 *
 * 候选值**直接引用内核那份词汇表**（`memory.TYPES`），不在这里再抄一遍 ——
 * 抄了就会漂（AGENT.md 硬约束 9：跨模块约定只有一处真相源）。
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
      type: {
        type: 'string',
        enum: memory.TYPES,
        description:
          '这条记忆属于哪一类（不填按 fact）。约束/要求/项目规则这类「必须遵守」的别记成 fact，否则检索时不会被优先遵守。',
      },
      scope: {
        type: 'string',
        enum: memory.SCOPES,
        description:
          '这条记忆管到哪（不填按 global = 所有对话）。只跟**这一次对话**有关的，填 session —— ' +
          '它只在当前这条对话里被想起，换一条对话就不出现（避免串台）。',
      },
    },
    required: ['content'],
  },

  async run(args, ctx = {}) {
    const text = String(args.content ?? '').trim()
    if (!text) throw new Error('内容是空的')

    /*
     * `scope` 由模型指定；填 `session` 时绑**当前会话**（ctx.sessionId）——
     * 会话私有记忆只在本会话注入（SEC-065）。没有 sessionId 就落空串 = 不注入。
     *
     * ★ `project` 作用域必须带项目 ID（`ctx.projectId`，来自 `options.projectId`）。
     *   没有 ID 却照写，条目就是**死条目**：`memory-scope.visible()` 对空串
     *   fail-closed，既注入不到也搜不到（2026-11-02 生产库那 11 条就是这么来的）。
     *   所以这里宁可**明说没记**，也不再往库里塞一条找不回来的记忆。
     *   归属只认 ctx —— 不按内容 / workdir / 会话猜（猜错了比没有更难收拾）。
     */
    const projectId = String(ctx?.projectId ?? '')
    if (args.scope === 'project' && !projectId) {
      throw new Error(
        '没记：当前上下文没有项目 ID。项目级记忆在这种情况写下去会永远找不到，' +
          '所以这次不落库。要么改用 scope=global，要么先确认这次对话已经绑定项目。',
      )
    }

    const result = memory.append({
      content: text,
      type: args.type,
      scope: args.scope,
      sessionId: ctx?.sessionId,
      /* 只有项目作用域才落项目 ID —— global / session 不该带一个用不上的归属 */
      projectId: args.scope === 'project' ? projectId : undefined,
    })
    if (!result.ok) throw new Error(result.error ?? '写入失败')

    const stats = memory.stats()
    const tail = stats.overLimit ? `（记忆已有 ${stats.count} 条，偏长了，建议清理）` : ''
    return result.skipped ? `这条已经在记忆里了，没重复写。${tail}` : `记下了。${tail}`
  },

  summarize(args) {
    return `记到长期记忆：${String(args.content ?? '').slice(0, 80)}`
  },
}

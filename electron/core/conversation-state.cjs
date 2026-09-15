/** CE-002：轻量、可恢复的 Conversation State。
 * 这是增量启发式状态，不调用模型，不阻塞主回答；未来可替换为专用 state updater。
 */
const EMPTY = () => ({
  topic: '',
  goal: '',
  currentFocus: '',
  entities: [],
  decisions: [],
  constraints: [],
  openQuestions: [],
  nextStep: '',
  lastUpdated: '',
  version: 1,
})

function clean(value, max = 300) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
function unique(list, max = 12) {
  return [...new Set(list.filter(Boolean))].slice(-max)
}

function update(previous, messages = []) {
  const state = { ...EMPTY(), ...(previous || {}) }
  const users = messages.filter((m) => m.role === 'user' && typeof m.content === 'string')
  const last = users.at(-1)?.content ?? ''
  if (last) {
    state.currentFocus = clean(last, 240)
    if (!state.topic) state.topic = clean(last, 120)
    if (!state.goal && /要|希望|目标|帮我|请|需要/.test(last)) state.goal = clean(last, 240)
    const decisions = last.match(/(?:决定|确定|采用|改为|不要|必须)[^。！？\n]{0,100}/g) ?? []
    state.decisions = unique([...state.decisions, ...decisions.map((x) => clean(x))])
    const constraints = last.match(/(?:只|禁止|不要|必须|不能|不许)[^。！？\n]{0,100}/g) ?? []
    state.constraints = unique([...state.constraints, ...constraints.map((x) => clean(x))])
    state.nextStep = clean(last, 180)
  }
  const all = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  state.entities = unique(
    [...state.entities, ...(all.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) ?? [])],
    20,
  )
  state.lastUpdated = new Date().toISOString()
  return state
}

function prompt(state) {
  if (!state) return ''
  return [
    state.topic && `主题：${state.topic}`,
    state.goal && `目标：${state.goal}`,
    state.currentFocus && `当前焦点：${state.currentFocus}`,
    state.decisions?.length && `已定决定：\n${state.decisions.map((x) => `- ${x}`).join('\n')}`,
    state.constraints?.length && `约束：\n${state.constraints.map((x) => `- ${x}`).join('\n')}`,
    state.openQuestions?.length &&
      `未解决问题：\n${state.openQuestions.map((x) => `- ${x}`).join('\n')}`,
    state.nextStep && `下一步：${state.nextStep}`,
  ]
    .filter(Boolean)
    .join('\n')
}

module.exports = { EMPTY, update, prompt }

/**
 * 无障碍树 → 人可读文本
 *
 * 学 dsh-browser 的 `aria.ts`（2026-09-23）：直接把 Chrome 的**无障碍树**
 * （CDP `Accessibility.getFullAXTree`）打成一棵缩进文本树 —— 读的是页面
 * **自己声明**的语义（role / name / 状态），而不是我们从 CSS 标签猜
 * 「哪些元素能点」。菜单、表单、表格这类复杂结构上更准。
 *
 * 纯函数（不碰 electron），好单测。
 */

/** 要展示的「状态」属性（其余属性大多是噪音） */
const STATE_KEYS = new Set([
  'disabled',
  'readonly',
  'required',
  'checked',
  'expanded',
  'selected',
  'focused',
  'pressed',
  'invalid',
  'multiselectable',
  'level',
])

/**
 * 这些 role 只是壳，不单独出行（子节点提升一级，避免缩进噪音）。
 * `generic` = 无角色的 div/span；`none` / `InlineTextBox` / `LineBreak` 同理。
 */
const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak'])

/** 从一个 AX 节点里挑出要展示的状态位 */
function statesOf(node) {
  const props = Array.isArray(node?.properties) ? node.properties : []
  const out = []
  for (const p of props) {
    if (!STATE_KEYS.has(p?.name)) continue
    const v = p?.value?.value
    if (v === true) out.push(p.name)
    else if (v !== false && v !== 'false' && v !== '' && v !== undefined) out.push(`${p.name}=${v}`)
  }
  return out
}

/**
 * 把 `getFullAXTree` 的节点数组转成缩进文本树。
 *
 * @param {Array} nodes CDP 返回的 nodes
 * @param {{ maxLines?: number }} [opts]
 */
function formatAxTree(nodes, { maxLines = 200 } = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  if (list.length === 0) return '（无障碍树是空的）'
  const byId = new Map(list.map((n) => [n.nodeId, n]))
  const root = list.find((n) => !n.parentId) ?? list[0]
  const lines = []

  const walk = (node, depth, parentName = '') => {
    if (!node || lines.length >= maxLines) return
    const role = String(node.role?.value ?? '')
    const name = String(node.name?.value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
    const states = statesOf(node)
    /* StaticText 的文本常常就等于父节点（button/link）的 name —— 重复一次没意义，跳过 */
    const skipped =
      role === '' || SKIP_ROLES.has(role) || (role === 'StaticText' && name === parentName)
    if (!skipped) {
      let line = '  '.repeat(depth) + (role || '?')
      if (name) line += ` "${name.slice(0, 80)}"`
      if (states.length) line += ` [${states.join(', ')}]`
      lines.push(line)
    }
    const kids = (Array.isArray(node.childIds) ? node.childIds : [])
      .map((id) => byId.get(id))
      .filter(Boolean)
    const nextDepth = skipped ? depth : depth + 1
    for (const kid of kids) walk(kid, nextDepth, name)
  }

  walk(root, 0)
  if (lines.length >= maxLines) lines.push(`…（还有更多节点，只列了前 ${maxLines} 行）`)
  return lines.join('\n')
}

module.exports = { formatAxTree, statesOf, SKIP_ROLES, STATE_KEYS }

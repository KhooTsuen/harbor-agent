const recall = require('./tools/recall.cjs')
const TOOL = {
  name: 'harbor_recall', description: recall.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: { ...recall.parameters, additionalProperties: false },
}
function clean(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, message: '参数必须是对象' }
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    const type = recall.parameters.properties[key]?.type
    if (!type || (type === 'integer' ? !Number.isSafeInteger(value) || value < 0 : typeof value !== 'string'))
      return { ok: false, message: '回取参数无效；会话与执行范围只能由内核确定' }
    out[key] = value
  }
  return { ok: true, args: out }
}
module.exports = { TOOL, clean }

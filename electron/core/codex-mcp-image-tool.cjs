const MAX_PATH_LEN = 400

const TOOLS = [{
  name: 'harbor_read_image',
  description: '读取当前对话有权访问的图片真实内容；使用当前支持视觉的模型或设置中明确配置的识图模型。超出对话授权范围会向用户申请。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片路径（相对当前对话目录或已授权路径）' },
      question: { type: 'string', description: '想从图片中确认什么' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}]

function cleanReadImage(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const path = a.path
  if (typeof path !== 'string' || !path.trim()) return { ok: false, message: 'path 必填' }
  if (path.length > MAX_PATH_LEN) return { ok: false, message: `path 过长（上限 ${MAX_PATH_LEN} 字符）` }
  const question = typeof a.question === 'string' ? a.question.slice(0, 1000) : ''
  return { ok: true, args: { path: path.trim(), question } }
}

module.exports = { TOOLS, cleanReadImage, MAX_PATH_LEN }

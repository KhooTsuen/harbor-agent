/**
 * 消息内容的**文本口径** —— 全内核只有这一处。
 *
 * 为什么要有这个文件（2026-09-28 真机事故）：
 * 带图提问的 `content` 是**多模态数组** ——
 *   `[{type:'text',text:'这是什么'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBOR…'}}]`
 * 而内核好几处把它当字符串用：
 *   · `context-builder.cjs` 直接 `JSON.stringify` 再按字符切 → **图片只剩文件头**，
 *     模型如实回答「我看不到画面」（用户报的就是这个）
 *   · `conversation-state.cjs` 只认字符串 → 带图提问整条被跳过
 *   · `handlers/scene.cjs` / `diagnostics.cjs` 渲染成 `[object Object]`
 * 根子在于「怎么把 content 变成文本」这件事**每个文件各写了一遍，且各写各的错**。
 * 现在统一走这里：**字符串原样；数组只取 text 部分；base64 永远不参与**。
 *
 * ⚠️ 这个口径只用于「要文字」的场合。要**发给模型**的时候是另一回事：
 *    多模态数组必须原样带出去（见 `context-builder.cjs` 的 `trimContent`）。
 */

/** 常见的图片块写法：OpenAI `image_url` / Anthropic `image` / Responses `input_image` */
const IMAGE_TYPES = new Set(['image_url', 'image', 'input_image'])

/** 这是不是图片块（图片只能整块搬运，不能按字符切、也不能当文本算） */
function isImagePart(part) {
  return IMAGE_TYPES.has(part?.type)
}

/** 文本口径：字符串原样；多模态数组只取 text 部分；其它兜底成空串 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** 这条内容里有几张图 */
function countImages(content) {
  return Array.isArray(content) ? content.filter(isImagePart).length : 0
}

module.exports = { textOf, isImagePart, countImages, IMAGE_TYPES }

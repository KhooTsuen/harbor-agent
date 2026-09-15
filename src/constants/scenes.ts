import type { SceneId } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   场景清单

   每个场景可以单独指定模型 —— 不同活儿对模型的要求差很远：
     起标题/翻译/优化提示词 → 短、要快、要便宜
     聊天/压缩            → 要理解力，用主力
     OCR                  → 必须支持视觉输入
     画图                 → 走的是另一个 API（images/generations）
   ══════════════════════════════════════════════════════════════ */

export interface SceneMeta {
  id: SceneId
  label: string
  hint: string
  /** 没配的时候用哪儿兜底 */
  fallbackHint: string
  /** 这个场景有什么硬性要求，界面上要提前说 */
  requirement?: string
}

export const SCENES: readonly SceneMeta[] = [
  {
    id: 'chat',
    label: '默认聊天',
    hint: '主对话用的模型，也是其他场景没单独配时的兜底',
    fallbackHint: '必须配（就是「模型」页里的那个）',
  },
  {
    id: 'title',
    label: '标题生成',
    hint: '第一轮回复结束后，自动起一个短标题',
    fallbackHint: '用默认聊天模型',
  },
  {
    id: 'prompt',
    label: '提示词优化',
    hint: '输入框的 /优化 用它把你的话改写成更清晰的指令',
    fallbackHint: '用默认聊天模型',
  },
  {
    id: 'translate',
    label: '翻译',
    hint: '把某条回复翻译成中文（消息上的「译」按钮）',
    fallbackHint: '用默认聊天模型',
  },
  {
    id: 'suggest',
    label: '建议回复',
    hint: '一轮结束后，生成几条可以直接点的后续问题',
    fallbackHint: '用默认聊天模型',
  },
  {
    id: 'compact',
    label: '上下文压缩',
    hint: '对话太长时，把早期内容压成摘要',
    fallbackHint: '用默认聊天模型',
  },
  {
    id: 'ocr',
    label: 'OCR（图片转文字）',
    hint: '识别截图里的文字，贴进对话',
    fallbackHint: '用默认聊天模型',
    requirement: '需要支持视觉输入的模型（能读图的）',
  },
  {
    id: 'image',
    label: '图像生成',
    hint: '按描述生成图片，结果显示在对话里',
    fallbackHint: '必须单独配',
    requirement: '走的是 /images/generations 接口，普通聊天模型不行',
  },
]

export function sceneMeta(id: SceneId): SceneMeta {
  return SCENES.find((scene) => scene.id === id) ?? SCENES[0]
}

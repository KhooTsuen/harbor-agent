import type { AttachedFile } from '@/types/backend-io'

/* ══════════════════════════════════════════════════════════════
   待发送的附件：图片 + 各类文件

   从 `useThreadStore.ts` 拆出来的 —— 那边贴着 300 行红线，而这一摊
   （图片条 + 文件卡片 + 「怎么进消息」）自成一体。

   两类东西放一个文件，是因为它们**同一条出路**：发送时一起清空、
   一起算「这算不算有效输入」。分开写就会各算一份，迟早不一致。

   ◎ 图片走 data URL（多模态）；文件走「正文拼进消息」（见 attachBlock）。
   ══════════════════════════════════════════════════════════════ */

/** 图片最多 5 张（再多上下文塞不下，而且多半是误操作） */
const MAX_IMAGES = 5
/** 文件最多 5 个 —— 与主进程 `handlers/file-attach.cjs` 的 MAX_FILES 对应 */
const MAX_FILES = 5

export interface AttachmentSlice {
  inputImages: string[]
  inputFiles: AttachedFile[]
  addInputImage: (dataUrl: string) => void
  removeInputImage: (index: number) => void
  clearInputImages: () => void
  addInputFile: (file: AttachedFile) => void
  removeInputFile: (index: number) => void
  clearInputFiles: () => void
}

/*
 * 这里**不**借用 turnControl 的 `TurnSetter`：那个把 state 收窄成
 * `{ sendingThreads }`（只让 set 改在跑状态），拿它写 inputImages / inputFiles
 * 会直接类型不匹配。自己声明一个只认这两个字段的 setter 就够。
 */
interface AttachmentState {
  inputImages: string[]
  inputFiles: AttachedFile[]
}

type Setter = (
  partial: Partial<AttachmentState> | ((state: AttachmentState) => Partial<AttachmentState>),
) => void

export function makeAttachmentActions(set: Setter): AttachmentSlice {
  return {
    inputImages: [],
    inputFiles: [],

    addInputImage: (dataUrl) =>
      set((s) =>
        s.inputImages.length >= MAX_IMAGES ? s : { inputImages: [...s.inputImages, dataUrl] },
      ),
    removeInputImage: (index) =>
      set((s) => ({ inputImages: s.inputImages.filter((_, i) => i !== index) })),
    clearInputImages: () => set({ inputImages: [] }),

    addInputFile: (file) =>
      set((s) => (s.inputFiles.length >= MAX_FILES ? s : { inputFiles: [...s.inputFiles, file] })),
    removeInputFile: (index) =>
      set((s) => ({ inputFiles: s.inputFiles.filter((_, i) => i !== index) })),
    clearInputFiles: () => set({ inputFiles: [] }),
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 一个附件在消息里占的那一段正文 */
export function attachmentBody(file: AttachedFile): string {
  if (file.kind === 'image') return '（图片，随消息一起发给模型，这里不重复）'
  if (file.kind === 'binary') return '（二进制文件，只登记了文件名和大小，没有读取内容）'
  if (file.kind === 'archive') {
    const head = `（压缩包，共 ${file.entryCount ?? 0} 个条目${file.truncated ? '，下面只列前 500 个' : ''}）`
    return `${head}\n${(file.entries ?? []).join('\n')}${file.note ? `\n（${file.note}）` : ''}`
  }
  const text = file.text ?? ''
  if (file.note) return `${text}\n（${file.note}）`
  return file.truncated ? `${text}\n（正文过长，这里只到截断处）` : text
}

/**
 * 一个附件在消息正文里的**那一段**。
 *
 * ★ 预览与实发必须调这同一处（P1 #26 的验收就钉这一条：「预览与实际请求内容一致」）。
 *   以前附件卡里的「查看提供给助手的内容」用的是 `attachmentBody`，而真正发出去的是
 *   `attachBlock` 拼的 —— 后者多一段 `--- 附件 N：名字（类型, 大小）---` 分隔头，
 *   编号还按可用附件的顺序重排。于是**预览看到的和模型收到的是两段不同的文本**。
 *
 * `index` 是它在**可用附件**里的序号（从 1 起），与 `attachBlock` 给出的编号一致。
 */
export function attachmentBlock(file: AttachedFile, index: number): string {
  const label = file.label ?? file.kind ?? '文件'
  const size = file.size ? `，${formatSize(file.size)}` : ''
  return `\n\n--- 附件 ${index}：${file.name}（${label}${size}）---\n${attachmentBody(file)}`
}

/**
 * 真正会随消息发出去的附件。
 *
 * 读失败的不进消息（`attachBlock` 过滤的就是这一份），所以界面判断「能不能发送」
 * 也必须按它算 —— 否则只剩失败附件时会以为有内容，发出一条空壳消息（P1 #29）。
 */
export function usableFiles(files: AttachedFile[]): AttachedFile[] {
  return files.filter((file) => file.ok)
}

/**
 * 把附件正文拼成「随用户消息一起发出去」的那一段。没可用附件时返回 ''。
 *
 * ★ 为什么是**直接拼进消息正文**，而不是单开一个字段：
 *   模型这一轮读的是**会话历史**（`thread/turns.ts` 里 `buildHistory(...)`），
 *   而历史里每条消息只有 `content` 一处。拼进去 = 模型一定读得到；
 *   太长的话 `core/long-paste.cjs` 会在主进程自动落盘、只发开头 + 路径 ——
 *   那条路**本来就在**，不用为附件另造一套。
 */
export function attachBlock(files: AttachedFile[]): string {
  return usableFiles(files)
    .map((file, index) => attachmentBlock(file, index + 1))
    .join('')
}

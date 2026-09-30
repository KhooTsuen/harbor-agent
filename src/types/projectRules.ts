/* ══════════════════════════════════════════════════════════════
   项目级规则（`<工作目录>/.harbor/rules.md`）的类型

   单独一个文件而不是塞进 backend.ts：那边正好 300 行（硬约束 #2），
   而「桥接口按域分文件」是这个项目的既有做法（见 types/workspace.ts 的同款说明）。
   ══════════════════════════════════════════════════════════════ */

/** 一个规则文件的元信息（内容不进渲染层 —— 界面只需要知道「有几个、多大」） */
export interface ProjectRulesFile {
  relative: string
  bytes: number
  mtimeMs: number
}

/** `projectRules:status` / `projectRules:reload` 的回执 */
export interface ProjectRulesStatus {
  ok: boolean
  error?: string
  /** 这条对话（或这个文件夹）的工作目录 */
  workdir: string
  /** 规则目录的绝对路径：`<工作目录>/.harbor` */
  dir: string
  /** 主文件 `<工作目录>/.harbor/rules.md` 的绝对路径 */
  file: string
  /** 主文件在不在（不存在时界面给「创建」入口） */
  exists: boolean
  /** 有没有任何规则文件（主文件或 `.harbor/rules/*.md`） */
  found: boolean
  /** 主文件在不在（`found` 可能只靠补充文件成立） */
  main: boolean
  /** 参与注入的文件（相对工作目录的路径，主文件在前） */
  files: string[]
  bytes: number
  /** 上次真读盘的时间戳（0 = 这个进程还没读过） */
  loadedAt: number
  /** 超上限被截断（界面要说清，别让用户以为全注入了） */
  truncated: boolean
  cached: boolean
  /** 文件改过了、这一轮还没重新读（下次发消息自动生效，或点「重新加载」立即生效） */
  stale: boolean
  limits: { maxChars: number }
}

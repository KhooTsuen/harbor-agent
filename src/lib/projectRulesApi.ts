import type { ProjectRulesStatus } from '@/types/projectRules'

/* ══════════════════════════════════════════════════════════════
   项目级规则（`<工作目录>/.harbor/rules.md`）的桥包装

   内核在 `electron/core/project-rules.cjs` + `electron/handlers/project-rules.cjs`。
   方法**不**写进 `types/backend.ts` —— 那边正好 300 行（硬约束 #2），
   照 `lib/projectsApi.ts` 的做法就地声明本地类型 + 能力探测。

   约定（和 projectsApi / artifactApi 一致）：**失败不抛异常**，
   桥没接上只是「这一行显示不出来」，不能让整个对话设置白屏。
   ══════════════════════════════════════════════════════════════ */

/** preload 上这三个方法的形状（回执先收成 unknown，由收窄函数判定） */
type Bridge = {
  projectRulesStatus?: (dir?: string) => Promise<unknown>
  projectRulesReload?: (dir?: string) => Promise<unknown>
  projectRulesOpen?: (payload: { dir?: string; create?: boolean }) => Promise<unknown>
}

const bridge =
  typeof window !== 'undefined' ? (window.workbench as unknown as Bridge | undefined) : undefined

/** 桥接好了吗（调用方据此决定「显示不出来」是故障还是浏览器预览） */
export function projectRulesBridgeReady(): boolean {
  return typeof bridge?.projectRulesStatus === 'function'
}

async function callTo<T>(run: (() => Promise<unknown>) | undefined, fallback: T): Promise<T> {
  if (!run) return fallback
  try {
    return (await run()) as T
  } catch {
    return fallback
  }
}

/**
 * 规则文件状态（只读）。
 *
 * 不回 zod：这里的字段是**内核算出来的**（布尔/数字/我们自己拼的路径），
 * 不是用户能手改的磁盘内容 —— 项目里那些要过 zod 的是「外部 JSON / 网络回包」。
 */
export function projectRulesStatus(dir?: string): Promise<ProjectRulesStatus | null> {
  return callTo(
    bridge?.projectRulesStatus
      ? () => bridge.projectRulesStatus?.(dir) ?? Promise.resolve(null)
      : undefined,
    null,
  )
}

/** 显式重新加载（跳过 mtime 缓存）→ 立即生效；返回加载后的新状态 */
export function projectRulesReload(dir?: string): Promise<ProjectRulesStatus | null> {
  return callTo(
    bridge?.projectRulesReload
      ? () => bridge.projectRulesReload?.(dir) ?? Promise.resolve(null)
      : undefined,
    null,
  )
}

/** 在系统默认程序里打开规则文件；`create: true` 时文件不存在就先按骨架建一个 */
export function projectRulesOpen(
  dir?: string,
  create = false,
): Promise<{ ok: boolean; error?: string; file?: string } | null> {
  return callTo(
    bridge?.projectRulesOpen
      ? () => bridge.projectRulesOpen?.({ dir, create }) ?? Promise.resolve(null)
      : undefined,
    null,
  )
}

/**
 * 把状态说成一句人话（**只此一份** —— 界面与探针共用，免得两处措辞各自漂）。
 */
export function describeRules(status: ProjectRulesStatus | null): {
  tone: 'ok' | 'warn' | 'muted'
  text: string
  hint: string
} {
  if (!status) {
    return {
      tone: 'muted',
      text: '读不到规则文件状态',
      hint: projectRulesBridgeReady()
        ? '内核这次没返回，可以点「重新加载」再试'
        : '浏览器预览下正常（没有内核）',
    }
  }
  if (status.error) return { tone: 'warn', text: '读规则文件出错', hint: status.error }
  if (!status.found) {
    return {
      tone: 'warn',
      text: '还没有规则文件',
      hint: `可以点「创建」生成一份骨架，写在 ${status.dir || '.harbor'} 里`,
    }
  }

  const size =
    status.bytes >= 1024 ? `${(status.bytes / 1024).toFixed(1)} KB` : `${status.bytes} 字节`
  const count = status.files.length > 1 ? `${status.files.length} 个文件 · ` : ''
  const tail = status.stale ? '（文件改过了，下次发消息生效）' : ''
  return {
    tone: status.truncated ? 'warn' : 'ok',
    text: `已加载：${count}${size}${tail}`,
    hint: status.truncated
      ? `超过上限 ${status.limits.maxChars} 字符，只注入了前面一段`
      : '本项目的对话都会遵守它',
  }
}

export type { ProjectRulesStatus }

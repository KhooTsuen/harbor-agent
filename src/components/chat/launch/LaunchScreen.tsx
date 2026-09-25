import { useEffect, useMemo, useRef, useState } from 'react'
import type { Greeting } from '@/lib/greeting'
import type { TaskRecoveryItem, TestStatusInfo } from '@/types/safety'
import type { WorkspaceSummary as WorkspaceSummaryData } from '@/types/workspace'
import { useAppStore } from '@/stores/useAppStore'
import { useEggStore } from '@/stores/useEggStore'
import { useGreetingStore } from '@/stores/useGreetingStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAgentActive } from '@/hooks/useAgentActive'
import { latestTestStatus, scanWorkspace, unfinishedTasks } from '@/lib/launchApi'
import { credentialsStatus } from '@/lib/safetyApi'
import { Lighthouse, type LighthouseState } from './Lighthouse'
import { WorkspaceSummary } from './WorkspaceSummary'
import { LaunchActions, type LaunchActionInput } from './LaunchActions'
import { ResumeCard } from './ResumeCard'

/* ══════════════════════════════════════════════════════════════
   开屏（空对话时的中央区）—— 设计文档 §5 / §20 / §23.10

   两层是分开的：
     状态层（必真、必在）：工作区摘要 · 最近工作 · 动作按钮 · 灯塔光
     性格层（可随机、可关）：Harbor 下面那一句欢迎语

   主状态的优先级（§7）：扫描中 → 在跑 → 离线 → 等确认/可恢复 → 就绪。
   时间/彩蛋**永不覆盖**错误、权限与恢复状态 —— 这里只据此调灯塔与文案。
   ══════════════════════════════════════════════════════════════ */

/** 当前对话的工作目录（空 = 交给内核回落到默认目录） */
function useLaunchWorkdir(): string {
  return useAppStore((s) => {
    const thread = s.threads.find((t) => t.id === s.activeThreadId)
    const project = s.projects.find((p) => p.id === thread?.projectId)
    return thread?.workdir || project?.path || ''
  })
}

export function LaunchScreen() {
  const workdir = useLaunchWorkdir()
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const hasHistory = useAppStore((s) => s.threads.some((t) => t.messages.length > 0))
  const persona = useSettingsStore((s) => s.settings.persona)
  const sending = useAgentActive(activeThreadId)
  const permission = useUIStore((s) => s.permission)
  const sweepSeq = useEggStore((s) => s.sweepSeq)

  const [scan, setScan] = useState<WorkspaceSummaryData | null>(null)
  const [scanLoading, setScanLoading] = useState(true)
  const [testStatus, setTestStatus] = useState<TestStatusInfo | null>(null)
  const [recovery, setRecovery] = useState<TaskRecoveryItem[]>([])
  const [noCredentials, setNoCredentials] = useState(false)
  const [greeting, setGreeting] = useState<Greeting | null>(null)

  /* ── 只读扫描：随工作目录变化重来一次；不做轮询（§17）── */
  const refreshRecovery = (): void => {
    void unfinishedTasks(workdir).then((items) => setRecovery(items.slice(0, 2)))
  }

  useEffect(() => {
    let cancelled = false
    setScanLoading(true)
    void (async () => {
      const [workspace, tests, rec, creds] = await Promise.all([
        scanWorkspace(workdir),
        latestTestStatus(workdir),
        unfinishedTasks(workdir),
        credentialsStatus().catch(() => null),
      ])
      if (cancelled) return
      setScan(workspace)
      setTestStatus(tests)
      setRecovery(rec.slice(0, 2))
      setNoCredentials(creds !== null && creds.count === 0)
      setScanLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [workdir])

  /* ── 性格层：每次挂载（≈每次开屏）抽一条；等扫描收敛后抽，好判断「普通就绪」── */
  const drewRef = useRef(false)
  useEffect(() => {
    if (drewRef.current || scanLoading || !persona) return
    drewRef.current = true
    const normal = permission === null && !sending && (scan === null || scan.ok)
    setGreeting(useGreetingStore.getState().draw(hasHistory, normal))
  }, [scanLoading, persona, permission, sending, scan, hasHistory])

  /* ── 灯塔：光来自真实状态 ── */
  const lighthouseState: LighthouseState = useMemo(() => {
    if (scanLoading) return 'scanning'
    if (sending) return 'running'
    if (noCredentials) return 'offline'
    if (permission !== null || recovery.length > 0) return 'awaiting'
    return 'idle'
  }, [scanLoading, sending, noCredentials, permission, recovery.length])

  /* ── 动作层：只填输入框（可编辑），不直接执行 ── */
  const actionInput: LaunchActionInput = useMemo(() => {
    const stack = scan?.stack ?? []
    return {
      hasDir: Boolean(scan?.ok),
      isGitRepo: scan?.git?.ok === true,
      gitHasChanges: scan?.git?.ok === true && (scan.git.changes ?? 0) > 0,
      testCommand: scan?.testCommand ?? '',
      emptyWorkspace: stack.length === 0 && scan?.git?.ok !== true && !scan?.testCommand,
    }
  }, [scan])

  const onFill = (text: string): void => {
    useThreadStore.getState().setInput(text)
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }

  const onPickWorkdir = (): void => {
    void (async () => {
      const result = await window.workbench?.pickWorkdir()
      if (result?.ok && result.workdir) {
        useUIStore.getState().showToast('success', '工作目录已切换', result.workdir)
      }
    })()
  }

  return (
    <div
      data-launch-screen="true"
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-6"
    >
      <div className="relative flex w-full max-w-xl flex-1 flex-col items-center justify-center">
        {/* 灯塔在最底层（低对比背景）；不遮点击 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-40 max-w-lg opacity-60">
          <Lighthouse state={lighthouseState} sweepSeq={sweepSeq} />
        </div>
        <div className="relative flex w-full flex-col items-center gap-4 pt-20">
          <h2 className="text-title font-semibold tracking-wide text-fg-primary">Harbor</h2>
          {greeting ? <p className="-mt-2 text-dense text-fg-secondary">{greeting.text}</p> : null}
          <WorkspaceSummary scan={scan} loading={scanLoading} testStatus={testStatus} />
          <LaunchActions input={actionInput} onFill={onFill} onPickWorkdir={onPickWorkdir} />
          <ResumeCard tasks={recovery} onRefresh={refreshRecovery} />
        </div>
      </div>
    </div>
  )
}

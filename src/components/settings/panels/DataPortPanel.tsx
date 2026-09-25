import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { countData, exportAll, type DataPortCounts } from '@/lib/dataPortExport'
import {
  BACKUP_COVERS,
  BACKUP_MISSES,
  WIPE_TIERS,
  backupBeforeWipe,
  wipeMany,
  type WipeId,
  type WipeTier,
} from '@/lib/dataPortWipe'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   导出 / 删除（统一面板）

   这两件事原来散在三个地方：导出在「数据」、清审计在「权限与安全」、
   备份在另一块。用户的动作只有一个 —— 「导一份 / 清干净」——
   所以合成一块：**上面导出，下面分档删**。

   两条不能省的规矩（都在 dataPortWipe.ts 里落地，这里只负责触发）：
     ① 删之前强制自动备份，备份失败就中止
     ② 「删除全部」要手打一个词才放行（二次确认）

   拼包与脱敏在 dataPortExport.ts（密钥那道门也在那边）。
   ══════════════════════════════════════════════════════════════ */

/** 「删除全部」要让用户手打的词 —— 打对了确认按钮才亮 */
export const WIPE_CONFIRM_WORD = '全部删除'

/** 每档显示的数量，取 countData() 的哪个字段 */
const TIER_COUNT: Record<WipeId, keyof DataPortCounts> = {
  sessions: 'sessions',
  tasks: 'tasks',
  memory: 'memory',
  audit: 'audit',
}

const ALL_IDS: readonly WipeId[] = WIPE_TIERS.map((tier) => tier.id)

export function DataPortPanel() {
  const threads = useAppStore((s) => s.threads)
  const clearMessages = useAppStore((s) => s.clearMessages)
  const showToast = useUIStore((s) => s.showToast)
  const askPermission = useUIStore((s) => s.askPermission)

  const [counts, setCounts] = useState<DataPortCounts | null>(null)
  const [busy, setBusy] = useState<'export' | WipeId | 'all' | ''>('')
  /* 「删除全部」的两步：先亮出输入框，打对词才给按 */
  const [armed, setArmed] = useState(false)
  const [word, setWord] = useState('')

  const refresh = useCallback(async () => {
    setCounts(await countData())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function runExport(): Promise<void> {
    setBusy('export')
    const result = await exportAll()
    setBusy('')
    if (result.canceled) return
    if (!result.ok) {
      showToast('error', '导出失败', result.error)
      return
    }
    const kb = Math.round((result.bytes ?? 0) / 1024)
    const masked = result.masked ? `，按脱敏规则改了 ${result.masked} 处` : ''
    showToast('success', '已导出', `${result.path ?? ''}（${kb} KB${masked}）`)
  }

  /** 所有删除的唯一入口：**先备份，备份不成就什么都不删** */
  async function execute(ids: readonly WipeId[], title: string): Promise<void> {
    setBusy(ids.length > 1 ? 'all' : (ids[0] ?? ''))
    const backup = await backupBeforeWipe()
    if (!backup.ok) {
      setBusy('')
      showToast(
        'error',
        '备份没成功，已中止删除',
        `${backup.error ?? ''}。没备份就不删 —— 这条不给你绕过去。`,
      )
      return
    }
    const result = await wipeMany(ids)
    /* 磁盘删了，界面上的会话也得跟着清，否则列表里还挂着一堆空壳 */
    if (ids.includes('sessions')) threads.forEach((thread) => clearMessages(thread.id))
    setBusy('')
    setArmed(false)
    setWord('')
    void refresh()
    showToast(result.ok ? 'success' : 'warning', title, result.lines.join('；'))
  }

  function confirmTier(tier: WipeTier): void {
    const count = counts ? counts[TIER_COUNT[tier.id]] : 0
    askPermission({
      kind: 'clear-data',
      title: `${tier.label}？`,
      description:
        `${tier.what}。当前有 ${count} 项。${tier.recover}。` +
        `删除前会先自动备份一次：备份只含 ${BACKUP_COVERS.join(' / ')}，不含 ${BACKUP_MISSES.join('、')}。`,
      confirmText: tier.label,
      danger: true,
      onConfirm: () => {
        void execute([tier.id], tier.label)
      },
    })
  }

  const summary = counts
    ? `${counts.sessions} 条对话 · ${counts.tasks} 条任务台账 · ${counts.memory} 条记忆 · ${counts.skills} 个技能`
    : '正在统计…'

  return (
    <>
      <SectionTitle>导出（一份带走）</SectionTitle>
      <Row
        label="导出全部"
        hint="会话 / 任务台账 / 记忆 / 配置 / 技能打包成一个 JSON。密钥不在里面 —— 这条链路上读不到它"
      >
        <div className="flex items-center gap-2">
          <span className="text-dense text-fg-tertiary">{summary}</span>
          <Button
            variant="secondary"
            size="sm"
            icon={<Download size={13} />}
            loading={busy === 'export'}
            onClick={() => void runExport()}
          >
            导出 JSON
          </Button>
        </div>
      </Row>
      <p className="px-1 text-dense leading-relaxed text-fg-tertiary">
        <ShieldCheck size={11} className="mr-1 inline" />
        导出内容会先按脱敏规则过一遍（密钥字段、`sk-` 这类前缀一律打码），
        落盘前再复检一次；还有没打码的疑似密钥就不落盘。
      </p>

      <SectionTitle>删除（分档，删前必先自动备份）</SectionTitle>
      <p className="flex gap-1.5 rounded-base border border-[color-mix(in_srgb,var(--error)_35%,transparent)] px-3 py-2 text-dense leading-relaxed text-fg-secondary">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>
          每档点下去都会先自动备份一份才开始删；备份不成功就不删。 但自动备份只含{' '}
          {BACKUP_COVERS.join(' / ')}，不含 {BACKUP_MISSES.join('、')} ——
          想给自己留后路，先点上面的「导出全部」。
        </span>
      </p>

      {WIPE_TIERS.map((tier) => {
        const count = counts ? counts[TIER_COUNT[tier.id]] : 0
        return (
          <Row
            key={tier.id}
            danger
            label={tier.label}
            hint={`${tier.what}。当前 ${count} 项。${tier.recover}`}
          >
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={13} />}
              loading={busy === tier.id}
              disabled={busy !== '' && busy !== tier.id}
              onClick={() => confirmTier(tier)}
            >
              {tier.label}
            </Button>
          </Row>
        )
      })}

      <Row
        danger
        label="删除全部"
        hint="上面四档一次做完。要手打一个词才放行 —— 这个动作不可逆，没有「撤销」"
      >
        {armed ? (
          <div className="flex items-center gap-2">
            <input
              value={word}
              onChange={(event) => setWord(event.target.value)}
              placeholder={`打出「${WIPE_CONFIRM_WORD}」`}
              spellCheck={false}
              className="w-40 rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 text-dense text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
            />
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={13} />}
              disabled={word !== WIPE_CONFIRM_WORD}
              loading={busy === 'all'}
              onClick={() => void execute(ALL_IDS, '已删除全部')}
            >
              确认删除全部
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setArmed(false)
                setWord('')
              }}
            >
              取消
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={13} />}
            onClick={() => setArmed(true)}
          >
            删除全部
          </Button>
        )}
      </Row>
      <p className="px-1 text-dense leading-relaxed text-fg-tertiary">
        删除范围：{WIPE_TIERS.map((tier) => tier.label).join('、')}。
        密钥库（credentials.json）不在删除范围内 —— API Key 不会被这套操作带走。
      </p>
    </>
  )
}

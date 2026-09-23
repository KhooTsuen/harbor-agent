import { useState } from 'react'
import { Download, FileDown, FileJson, Stethoscope, Trash2, Upload } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import {
  saveText,
  clearAllSessions,
  copyDiagnostics,
  saveDiagnostics,
  pickJsonFile,
} from '@/lib/backend'
import { migrateImport } from '@/lib/migrations'
import { threadToMarkdown } from '@/lib/export'
import { Button } from '@/components/ui/Button'
import { Row, SectionTitle } from '../parts'
import { BackupPanel } from './BackupPanel'

/* ══════════════════════════════════════════════════════════════
   设置 → 数据与隐私

   导出（Markdown / JSON）、清空会话、重置设置。
   所有危险操作都走权限确认（二次确认）。
   ══════════════════════════════════════════════════════════════ */

export function DataTab() {
  const threads = useAppStore((s) => s.threads)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const clearMessages = useAppStore((s) => s.clearMessages)

  const applyImport = useAppStore((s) => s.applyImport)
  const resetSettings = useSettingsStore((s) => s.resetSettings)
  const resetToDefaults = useConfigStore((s) => s.resetToDefaults)
  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)

  const activeThread = threads.find((t) => t.id === activeThreadId)
  const [busy, setBusy] = useState<'copy' | 'save' | ''>('')

  /** 诊断包：生成后复制或存文件 */
  async function runDiagnostics(kind: 'copy' | 'save'): Promise<void> {
    setBusy(kind)
    if (kind === 'copy') {
      const result = await copyDiagnostics()
      setBusy('')
      if (!result.ok) {
        showToast('error', '生成失败', result.error)
        return
      }
      showToast(
        result.errorCount && result.errorCount > 0 ? 'warning' : 'success',
        '诊断信息已复制',
        result.errorCount
          ? `含 ${result.errorCount} 条 ERROR/WARN，直接粘给我就行`
          : '直接粘给我就行',
      )
      return
    }

    const result = await saveDiagnostics()
    setBusy('')
    if (result.canceled) return
    if (!result.ok) {
      showToast('error', '保存失败', result.error)
      return
    }
    showToast('success', '已保存', result.path)
  }

  async function exportCurrentThread(): Promise<void> {
    if (!activeThread) return
    const result = await saveText(`${activeThread.title}.md`, threadToMarkdown(activeThread))
    if (result.ok) showToast('success', '已导出', result.path ?? '')
    else if (!result.canceled) showToast('error', '导出失败', result.error)
  }

  async function exportAllJson(): Promise<void> {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      threads,
    }
    const result = await saveText('harbor-export.json', JSON.stringify(payload, null, 2))
    if (result.ok) showToast('success', '已导出', result.path ?? '')
    else if (!result.canceled) showToast('error', '导出失败', result.error)
  }

  async function importData(): Promise<void> {
    const file = await pickJsonFile()
    if (!file.ok) {
      if (!file.canceled) showToast('error', '读文件失败', file.error)
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(file.content ?? '')
    } catch {
      showToast('error', '不是合法的 JSON', '检查一下文件是不是被改坏了')
      return
    }

    const result = migrateImport(raw)
    if (result.threads.length === 0 && result.projects.length === 0) {
      showToast('error', '没有可导入的内容', result.warnings[0] ?? '文件里没有线程')
      return
    }

    const added = await applyImport({ threads: result.threads, projects: result.projects })

    if (result.warnings.length > 0) {
      showToast('warning', `导入完成，有 ${result.warnings.length} 处提示`, result.warnings[0])
    } else {
      showToast('success', '导入完成', `新增 ${added.threads} 条对话、${added.projects} 个项目`)
    }
  }

  return (
    <div className="py-1">
      <SectionTitle>导出 / 导入</SectionTitle>

      <Row label="导出当前对话" hint="转成 Markdown，含思考过程和工具调用记录">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={13} />}
          disabled={!activeThread}
          onClick={() => void exportCurrentThread()}
        >
          Markdown
        </Button>
      </Row>

      <Row label="导出全部数据" hint="所有线程打包成 JSON，方便备份或迁移">
        <Button
          variant="secondary"
          size="sm"
          icon={<FileJson size={13} />}
          onClick={() => void exportAllJson()}
        >
          JSON
        </Button>
      </Row>

      <Row label="导入数据" hint="读之前导出的 JSON。id 撞了会自动换新的，不会覆盖现有对话">
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={13} />}
          onClick={() => void importData()}
        >
          选择文件
        </Button>
      </Row>

      <SectionTitle>危险操作</SectionTitle>

      <Row label="清空所有对话" hint={`共 ${threads.length} 条，删掉后不可恢复`}>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={13} />}
          disabled={threads.length === 0}
          onClick={() =>
            askPermission({
              kind: 'clear-data',
              title: '清空所有对话？',
              description: `会删掉全部 ${threads.length} 条对话，这个操作不能撤销。建议先导出备份。`,
              confirmText: '全部删除',
              danger: true,
              onConfirm: () => {
                void (async () => {
                  const count = await clearAllSessions()
                  threads.forEach((t) => clearMessages(t.id))
                  showToast('success', '已清空', `删掉了 ${count} 条对话`)
                })()
              },
            })
          }
        >
          清空对话
        </Button>
      </Row>

      <Row label="重置设置" hint="主题、布局宽度、开关都回到默认值（对话不受影响）">
        <Button
          variant="danger"
          size="sm"
          onClick={() =>
            askPermission({
              kind: 'clear-data',
              title: '重置所有设置？',
              description: '主题、玻璃拟态、动效、布局宽度都会回到默认值。对话数据不受影响。',
              confirmText: '重置设置',
              danger: true,
              onConfirm: () => {
                resetSettings()
                void resetToDefaults()
                showToast('success', '设置已重置')
              },
            })
          }
        >
          重置设置
        </Button>
      </Row>

      <p className="mt-3 border-t border-line-hairline pt-3 text-2xs leading-relaxed text-fg-tertiary">
        数据都存在软件目录的 <span className="font-mono">data/</span> 下：
        <span className="font-mono">sessions/</span>（对话）、
        <span className="font-mono">config.json</span>
        （设置）。删掉整个文件夹就是卸载，不会在系统里留任何东西。
      </p>
      <SectionTitle>诊断</SectionTitle>

      <Row
        label="导出诊断信息"
        hint="把版本、配置、日志、会话结构打包成一份文本。API Key 会自动打码，可以放心发给别人看"
      >
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Stethoscope size={13} />}
            loading={busy === 'copy'}
            onClick={() => void runDiagnostics('copy')}
          >
            复制到剪贴板
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<FileDown size={13} />}
            loading={busy === 'save'}
            onClick={() => void runDiagnostics('save')}
          >
            存成文件
          </Button>
        </div>
      </Row>

      <SectionTitle>备份与恢复</SectionTitle>
      <BackupPanel />
    </div>
  )
}

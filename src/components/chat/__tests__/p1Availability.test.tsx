import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppConfig } from '@/types/backend'
import type { AttachedFile } from '@/types/backend-io'
import {
  attachmentBody,
  attachmentBlock,
  attachBlock,
  usableFiles,
} from '@/stores/thread/attachments'
import {
  attachmentFailureFor,
  pendingReadsFor,
  useAttachmentActivity,
} from '@/stores/attachmentActivity'
import { replaceDraftOwner } from '@/stores/thread/draftOwner'
import { NO_TEXT_PLACEHOLDER, prepareOutgoing } from '@/stores/thread/outgoing'
import { connectionIssue } from '../composer/connectionIssue'
import { sendBlockOf } from '../composer/sendBlock'
import { QueuedMessages } from '../composer/QueuedMessages'
import { useConfigSaveStatus } from '@/stores/configSaveStatus'
import { useUIStore } from '@/stores/useUIStore'

const file: AttachedFile = {
  ok: true,
  name: '长文.txt',
  kind: 'text',
  size: 800,
  text: '实际前缀',
  truncated: true,
  note: '只提取前 4 页',
}

describe('P1 附件与发送状态', () => {
  beforeEach(() => {
    useAttachmentActivity.setState({ reads: [], failures: [], nextToken: 1 })
    useConfigSaveStatus.setState({ pending: 0, failedInBatch: false, state: 'idle' })
    useUIStore.setState({ toasts: [], toastHistory: [] })
  })

  it('附件和排队预览使用同一段真实待发送正文', () => {
    const expected = attachmentBody(file)
    expect(attachBlock([file])).toContain(expected)
    const queued = renderToStaticMarkup(
      <QueuedMessages list={[{ text: '', images: [], files: [file] }]} onRemove={() => {}} />,
    )
    expect(queued).toContain('查看队列附件内容')
    expect(queued).toContain('实际前缀')
    expect(queued).toContain('只提取前 4 页')
  })

  it('异步读取只阻塞发起对话；待建对话换成真实 id 后仍归原主', () => {
    const token = useAttachmentActivity.getState().begin('pending-p1-owner')
    expect(pendingReadsFor(useAttachmentActivity.getState().reads, 'other')).toBe(0)
    replaceDraftOwner('pending-p1-owner', 'actual-p1-owner')
    expect(pendingReadsFor(useAttachmentActivity.getState().reads, 'actual-p1-owner')).toBe(1)
    useAttachmentActivity.getState().end(token)
    expect(pendingReadsFor(useAttachmentActivity.getState().reads, 'actual-p1-owner')).toBe(0)
    useAttachmentActivity.getState().fail('pending-p1-owner', '解析失败')
    expect(attachmentFailureFor(useAttachmentActivity.getState().failures, 'other')).toBeNull()
    expect(attachmentFailureFor(useAttachmentActivity.getState().failures, 'actual-p1-owner')).toBe(
      '解析失败',
    )
  })

  it('同模型有可用连接时允许发送；缺密钥与双模型缺连接有具体原因', () => {
    const config = {
      providers: [
        {
          id: 'empty',
          name: '空连接',
          kind: 'openai',
          models: ['m'],
          enabled: true,
          hasKey: false,
        },
        {
          id: 'ready',
          name: '可用连接',
          kind: 'openai',
          models: ['m'],
          enabled: true,
          hasKey: true,
        },
      ],
    } as AppConfig
    expect(connectionIssue(config, 'm', null)).toBeNull()
    expect(
      connectionIssue({ ...config, providers: config.providers.slice(0, 1) }, 'm', null),
    ).toContain('API Key')
    expect(
      connectionIssue(config, 'm', {
        planner: { kind: 'openai', providerId: 'missing', model: 'm' },
      }),
    ).toContain('连接已删除')
  })

  it('同批自动保存有一次失败时，不被随后成功误标为已保存', () => {
    const state = useConfigSaveStatus.getState()
    state.begin()
    state.begin()
    state.finish(false)
    state.finish(true)
    expect(useConfigSaveStatus.getState().state).toBe('failed')
    state.begin()
    state.finish(true)
    expect(useConfigSaveStatus.getState().state).toBe('saved')
  })

  it('重要通知关闭后仍可找回；同一错误去重但任务结果各自保留', () => {
    const ui = useUIStore.getState()
    const id = ui.showToast('error', '连接失败', '请检查模型')
    expect(ui.showToast('error', '连接失败', '请检查模型')).toBe(id)
    ui.hideToast(id)
    expect(useUIStore.getState().toasts).toHaveLength(0)
    expect(useUIStore.getState().toastHistory).toHaveLength(1)
    const first = ui.showToast('success', '任务结束', '', { label: '查看', onClick: () => {} })
    const second = ui.showToast('success', '任务结束', '', { label: '查看', onClick: () => {} })
    expect(first).not.toBe(second)
    expect(useUIStore.getState().toastHistory).toHaveLength(3)
  })

  /* ── P1 #26：预览必须与真正拼进消息的那段逐字一致 ── */

  it('附件卡预览与实际拼进消息的正文逐字一致（含分隔头与编号）', () => {
    const second: AttachedFile = {
      ok: true,
      name: '表格.xlsx',
      kind: 'xlsx',
      size: 2048,
      text: '单元格内容',
      sheets: 2,
    }
    const sent = attachBlock([file, second])
    /* 卡片上「查看提供给助手的内容」用的就是这两段，拼起来必须等于实发内容 */
    expect(attachmentBlock(file, 1) + attachmentBlock(second, 2)).toBe(sent)
    expect(sent).toContain('--- 附件 1：长文.txt')
    expect(sent).toContain('--- 附件 2：表格.xlsx')
    expect(attachmentBody(file)).toContain('只提取前 4 页')
  })

  it('读失败的附件不进入消息正文，编号也不占位', () => {
    const bad: AttachedFile = { ok: false, name: '坏了.pdf', kind: 'pdf', error: '解析失败' }
    const good: AttachedFile = { ...file }
    expect(usableFiles([bad, good])).toHaveLength(1)
    const sent = attachBlock([bad, good])
    expect(sent).not.toContain('坏了.pdf')
    expect(sent).toContain('--- 附件 1：长文.txt')
  })

  /* ── P1 #29 / #14：只剩失败附件时不算「有内容」，原因也要说对 ── */

  it('只剩读失败的附件时按「附件失败」拦下，不当作准备发送', () => {
    expect(
      usableFiles([{ ok: false, name: 'a.pdf', kind: 'pdf', error: '解析失败' }]),
    ).toHaveLength(0)
    const block = sendBlockOf({
      pendingReads: 0,
      hasContent: false,
      attachmentFailure: 'a.pdf 解析失败',
      providerReason: null,
    })
    expect(block?.kind).toBe('attachment-failed')
    expect(block?.text).toContain('解析失败')
  })

  it('发送阻塞原因按类型区分，只有连接问题才给「打开模型设置」', () => {
    expect(
      sendBlockOf({
        pendingReads: 2,
        hasContent: true,
        attachmentFailure: null,
        providerReason: null,
      })?.kind,
    ).toBe('pending')
    expect(
      sendBlockOf({
        pendingReads: 0,
        hasContent: true,
        attachmentFailure: null,
        providerReason: '尚未配置 API Key',
      })?.kind,
    ).toBe('connection')
    expect(
      sendBlockOf({
        pendingReads: 0,
        hasContent: false,
        attachmentFailure: null,
        providerReason: null,
      })?.kind,
    ).toBe('empty')
    expect(
      sendBlockOf({
        pendingReads: 0,
        hasContent: true,
        attachmentFailure: null,
        providerReason: null,
      }),
    ).toBeNull()
  })

  it('附件正在读取时优先说读取，而不是先报连接问题', () => {
    const block = sendBlockOf({
      pendingReads: 1,
      hasContent: true,
      attachmentFailure: null,
      providerReason: '尚未配置 API Key',
    })
    expect(block?.kind).toBe('pending')
    expect(block?.text).not.toContain('API Key')
  })

  /* ── P1 #29：真正决定"发不发得出去"的那一步 ── */

  it('只有读失败的附件时不发；有可读附件时带占位语发出', () => {
    const bad: AttachedFile = { ok: false, name: 'a.pdf', kind: 'pdf', error: '解析失败' }
    expect(prepareOutgoing({ text: '', draftFiles: [bad], draftImages: [] })).toBeNull()
    expect(prepareOutgoing({ text: '   ', draftFiles: [], draftImages: [] })).toBeNull()

    const ready = prepareOutgoing({ text: '', draftFiles: [file], draftImages: [] })
    expect(ready).not.toBeNull()
    expect(ready?.raw).toBe(NO_TEXT_PLACEHOLDER)
    expect(ready?.files).toHaveLength(1)
  })

  it('附件里的图片会提升成多模态图片，并与贴图去重', () => {
    const shot = 'data:image/png;base64,AAA'
    const asFile: AttachedFile = { ok: true, name: 'a.png', kind: 'image', dataUrl: shot }
    const out = prepareOutgoing({
      text: '看图',
      draftFiles: [asFile],
      draftImages: [shot],
    })
    expect(out?.images).toEqual([shot])
    expect(out?.raw).toBe('看图')
  })
})

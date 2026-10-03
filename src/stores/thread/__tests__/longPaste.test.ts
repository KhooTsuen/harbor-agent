import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   长消息落文件（2026-10-04）

   要验的是「两半都对」：
     · 内核那一半（`electron/core/long-paste.cjs`）：超过阈值 → 写进**工作目录**里的文件
       （目录内模型免授权就能读），发给模型的是开头 + 路径；同一份内容幂等；
       写不进去时**不改消息**并且报出原因。
     · 接线那一半：`chat.cjs` 真的调它、真发 `attachment` 事件；渲染层真在消息流里留提示。
       （层与层之间的接线测试照不到 —— 见 docs/踩坑记录.md 的「拆一半比不拆更糟」。）
   ══════════════════════════════════════════════════════════════ */

/* 界面那半要落到 store 上：直接用**真 store**、把假数据和方法注入进去
   （比 vi.mock 稳：mock 的路径一旦对不上，测试会静默地什么也没测到） */
const { useAppStore } = await import('../../useAppStore')
const { attachmentNotice, handleAttachmentEvent } = await import('../attachmentEvents')

const ROOT = join(__dirname, '..', '..', '..', '..')
const require_ = createRequire(import.meta.url)
const longPaste = require_(join(ROOT, 'electron/core/long-paste.cjs')) as {
  THRESHOLD: number
  KEEP_HEAD: number
  offload: (input: Record<string, unknown>) => {
    changed: boolean
    reason: string
    path?: string
    created?: boolean
    chars?: number
    kept?: number
    outgoing?: string
    error?: string
  }
}

const dirs: string[] = []
const workdirOf = () => {
  const d = mkdtempSync(join(tmpdir(), 'longpaste-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('长消息落文件 / 内核那一半', () => {
  it('阈值就是 8000，保留开头 4000（配着对话额度定的，改它要一起想）', () => {
    expect(longPaste.THRESHOLD).toBe(8000)
    expect(longPaste.KEEP_HEAD).toBe(4000)
  })

  it('短消息一个字都不动', () => {
    const res = longPaste.offload({ text: '你好', workdir: workdirOf(), sessionId: 'sess_a' })
    expect(res.changed).toBe(false)
    expect(res.reason).toBe('short')
  })

  it('刚好等于阈值也不落（边界是「超过」）', () => {
    const res = longPaste.offload({
      text: 'x'.repeat(longPaste.THRESHOLD),
      workdir: workdirOf(),
      sessionId: 'sess_a',
    })
    expect(res.changed).toBe(false)
  })

  it('★ 超阈值 → 写进 <工作目录>/.harbor/attachments/，文件里是**完整原文**', () => {
    const workdir = workdirOf()
    const text = 'A'.repeat(9000)
    const res = longPaste.offload({ text, workdir, sessionId: 'sess_x1' })
    expect(res.changed).toBe(true)
    expect(res.created).toBe(true)
    expect(res.path).toContain(join('.harbor', 'attachments'))
    expect(res.path?.startsWith(workdir)).toBe(true)
    expect(readFileSync(String(res.path), 'utf8')).toBe(text)
  })

  it('★ 发给模型的是「开头 + 指路」，指路里带完整路径与总长', () => {
    const workdir = workdirOf()
    const res = longPaste.offload({ text: 'B'.repeat(20000), workdir, sessionId: 'sess_x2' })
    const outgoing = String(res.outgoing)
    expect(outgoing.startsWith('B'.repeat(100))).toBe(true)
    expect(outgoing).toContain('read_file')
    expect(outgoing).toContain(String(res.path))
    expect(outgoing).toContain('20000')
    expect(outgoing.length).toBeLessThan(4200)
  })

  it('幂等：同一份内容第二次只复用，不重写（否则每轮都新建一个文件）', () => {
    const workdir = workdirOf()
    const text = 'C'.repeat(9000)
    const first = longPaste.offload({ text, workdir, sessionId: 'sess_x3' })
    const second = longPaste.offload({ text, workdir, sessionId: 'sess_x3' })
    expect(second.path).toBe(first.path)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(readFileSync(String(second.path), 'utf8')).toBe(text)
  })

  it('不同会话 / 不同内容 → 不同文件（不会互相覆盖）', () => {
    const workdir = workdirOf()
    const a = longPaste.offload({ text: 'D'.repeat(9000), workdir, sessionId: 'sess_a' })
    const b = longPaste.offload({ text: 'D'.repeat(9000), workdir, sessionId: 'sess_b' })
    const c = longPaste.offload({ text: 'E'.repeat(9000), workdir, sessionId: 'sess_a' })
    expect(new Set([a.path, b.path, c.path]).size).toBe(3)
  })

  it('★ 写不进去（目录位置被一个同名文件占了）→ 不改消息，并报出原因', () => {
    const workdir = workdirOf()
    /* 把 .harbor 做成**文件**：mkdirSync 会 EEXIST/ENOTDIR 失败 */
    writeFileSync(join(workdir, '.harbor'), 'x', 'utf8')
    const res = longPaste.offload({ text: 'F'.repeat(9000), workdir, sessionId: 'sess_x4' })
    expect(res.changed).toBe(false)
    expect(res.reason).toBe('write-failed')
    expect(String(res.error)).not.toBe('')
  })

  it('太大不落（防呆上限），带图消息（非字符串）也不动', () => {
    const workdir = workdirOf()
    const huge = longPaste.offload({
      text: 'G'.repeat(9 * 1024 * 1024),
      workdir,
      sessionId: 'sess_x5',
    })
    expect(huge.changed).toBe(false)
    expect(huge.reason).toBe('too-big')
    expect(
      longPaste.offload({ text: [{ type: 'text', text: 'hi' }], workdir, sessionId: 's' }).reason,
    ).toBe('not-text')
  })

  it('没有工作目录时不落（不让它写到一个说不清的地方）', () => {
    expect(longPaste.offload({ text: 'H'.repeat(9000), workdir: '', sessionId: 's' }).reason).toBe(
      'no-workdir',
    )
  })
})

describe('长消息落文件 / 接线（源码顺序，层与层照不到）', () => {
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  const streamSrc = readFileSync(join(ROOT, 'src/stores/thread/streamEvents.ts'), 'utf8')

  it('★ chat.cjs 在发起这一轮**之前**就调 longPaste，并且真的发 attachment 事件', () => {
    const call = chatSrc.indexOf('longPaste.offload(')
    const run = chatSrc.indexOf('void (async () => {')
    expect(call).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(0)
    expect(call).toBeLessThan(run)
    expect(chatSrc).toContain("type: 'attachment'")
    /* 失败也要让用户看见（不许静默降级） */
    expect(chatSrc).toContain("title: '长消息没能落成文件'")
  })

  it('★ 渲染层接了 attachment 事件（漏了这一步 = 消息被换掉而没人知道）', () => {
    expect(streamSrc).toContain("case 'attachment'")
    expect(streamSrc).toContain('handleAttachmentEvent')
  })
})

describe('长消息落文件 / 界面提示', () => {
  it('文案把三件事说全：总长、文件在哪、模型收到的是什么', () => {
    const text = attachmentNotice({
      path: 'E:\\proj\\.harbor\\attachments\\a.txt',
      chars: 20000,
      kept: 4000,
    })
    expect(text).toContain('20000')
    expect(text).toContain('a.txt')
    expect(text).toContain('4000')
    expect(text).toContain('完整原文')
  })

  it('同一份文件只提示一次（幂等）', () => {
    /* 假 store：addMessage 要**真的把消息加进线程**（幂等判据就是靠线程里有没有这一行） */
    const thread = { id: 't1', messages: [] as { role: string; content: string }[] }
    const addMessage = vi.fn((_id: string, m: { role: string; content: string }) => {
      thread.messages.push(m)
    })
    const persistMessage = vi.fn()
    useAppStore.setState({
      threads: [thread as never],
      addMessage: addMessage as never,
      persistMessage: persistMessage as never,
    })

    const event = { type: 'attachment', path: 'p.txt', chars: 9000, kept: 4000 }
    handleAttachmentEvent('t1', event)
    handleAttachmentEvent('t1', event)
    expect(addMessage).toHaveBeenCalledTimes(1)
    expect(persistMessage).toHaveBeenCalledTimes(1)
    expect(thread.messages[0].role).toBe('system')
    expect(persistMessage.mock.calls[0][1]).toMatchObject({ role: 'system' })
  })

  it('没有路径 / 找不到会话时安静地什么都不做', () => {
    const addMessage = vi.fn()
    useAppStore.setState({ threads: [], addMessage: addMessage as never })
    expect(() => handleAttachmentEvent('nope', { type: 'attachment' })).not.toThrow()
    expect(() => handleAttachmentEvent('', { type: 'attachment', path: 'p' })).not.toThrow()
    expect(() => handleAttachmentEvent('t1', { type: 'attachment' })).not.toThrow()
    expect(addMessage).not.toHaveBeenCalled()
  })
})

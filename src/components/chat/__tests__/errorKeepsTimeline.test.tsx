import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageItem } from '../MessageItem'
import type { Message, ToolRunRecord } from '@/types'
import { useAppStore } from '@/stores/useAppStore'

/* ══════════════════════════════════════════════════════════════
   出错那条**不能**把整条时间线吞掉（2026-10-04，收尾第二步 / 小尾巴 #7）

   原来 `MessageItem` 是这么写的：

     {isError ? <div role="alert">错误话</div> : <div>…整条时间线…</div>}

   一出错，那一轮**真发生过**的东西全部不渲染：调过的工具、改过的文件、
   开工前答过的澄清卡。用户看到的只有一句报错 —— 于是「刚才那几步到底做没做」
   完全无从判断，只能重来一遍（而重来可能又踩同一个坑）。

   现在：红底错误块照旧（样式一个字没动），下面接着把发生过的东西排出来。

   还有一条更细的坑，专门用测试钉住：
   **出错时 `errorText` 和 `content` 是同一句话**（store 两处都写），
   如果照常按 content 排正文，那句错误话就会在红底块下面**再说一遍**。
   `roundsOfError` 负责把合成轮的正文抹掉（工具留着）。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

const run = (name: string, summary: string): ToolRunRecord => ({
  id: `t-${name}`,
  name,
  ok: true,
  ms: 12,
  output: '',
  summary,
})

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm-err',
    threadId: 't1',
    role: 'assistant',
    content: '供应商 401：Key 无效',
    kind: 'error',
    status: 'error',
    timestamp: 1,
    errorText: '供应商 401：Key 无效',
    ...over,
  }
}

function render(message: Message): string {
  act(() => root.render(<MessageItem message={message} />))
  return container.textContent ?? ''
}

/** 报错文字在界面上出现几次（>1 就是重复说了） */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAppStore.setState({
    activeThreadId: 't1',
    threads: [{ id: 't1', title: '测试', messages: [makeMessage()], workdir: '' }],
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('出错那条：错误块和时间线一起画', () => {
  it('★ 报错还在（红底那块没被拆掉）', () => {
    const text = render(makeMessage())
    expect(text).toContain('供应商 401')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('★ 中间调过的工具看得见了（以前整条时间线被吞掉）', () => {
    const text = render(makeMessage({ toolRuns: [run('read_file', 'README.md')] }))
    expect(text).toContain('读取 README.md')
    expect(text).toContain('供应商 401')
  })

  it('★ 开工前答过的澄清卡也看得见（「答了卡但这一轮失败」不再是空白）', () => {
    const text = render(
      makeMessage({
        clarify: {
          questions: [
            {
              question: '白板用哪种坐标系？',
              options: [
                { label: '屏幕像素', effect: '改窗口尺寸要重算' },
                { label: '文档坐标', effect: '缩放平移不用改数据' },
              ],
              allowFreeform: true,
              defaultValue: '屏幕像素',
              defaultFrom: 'model',
            },
          ],
          answers: [{ question: '白板用哪种坐标系？', choice: '屏幕像素', text: '' }],
          skipped: false,
        },
      }),
    )
    expect(text).toContain('开工前问过这几个问题')
    expect(text).toContain('屏幕像素（已选）')
    expect(text).toContain('供应商 401')
  })

  it('★ 那句错误话只说一遍（errorText 和 content 是同一句话）', () => {
    const text = render(makeMessage({ toolRuns: [run('read_file', 'README.md')] }))
    expect(count(text, '供应商 401：Key 无效')).toBe(1)
  })

  it('有真 rounds 的记录照旧：被打断前的正文留着（那才是「做到哪儿了」）', () => {
    const text = render(
      makeMessage({
        rounds: [{ reasoning: '', content: '我先把配置读一遍', tools: [0] }],
        toolRuns: [run('read_file', 'config.json')],
      }),
    )
    expect(text).toContain('我先把配置读一遍')
    expect(text).toContain('读取 config.json')
    expect(text).toContain('供应商 401')
  })

  it('★ 出错那条不给「复制 / 重新生成」操作条（保持原样：复制只会把报错抄走）', () => {
    const text = render(makeMessage({ toolRuns: [run('read_file', 'README.md')] }))
    expect(text).not.toContain('重新生成')
  })

  it('正常那条一点没变：正文照旧显示', () => {
    const text = render(makeMessage({ status: 'sent', kind: 'text', errorText: undefined }))
    expect(text).toContain('供应商 401')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

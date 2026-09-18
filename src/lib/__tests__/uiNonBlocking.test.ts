import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   AG-009：Agent 工作期间 UI 不阻塞

   这一条的验收方式是**真的去点**（见 tmp/probe-ag009.js：跑着任务的时候
   挨个开右栏 / 看文件 / 看状态 / 开设置 / 看日志 / 新建对话 / 编辑输入 /
   切回跑着的对话，10 项全过、耗时 155–419ms）。

   但「点一遍通过」不防退化 —— 半年后有人顺手加一句同步 IPC，
   或者把 `disabled={sending}` 加上去，界面就又开始卡了。所以这里钉三条：

     ① 不许有同步 IPC（`sendSync` 会真卡住主进程 → Renderer 一起卡）
     ② `src/` 下不许直接摸 node / electron / 子进程 ——
        重活（LLM / Shell / Search / MCP / PTY / Tool / Loop）**全部住在
        electron/ 里**，Renderer 只负责画。这条是「不阻塞」的根
     ③ 没有任何 `disabled` 由「Agent 正在跑」决定 —— 跑着的时候按钮照样能点

   唯一的、写明白的例外是 Composer 的 `canSend`：跑着的时候不让你发**新**
   消息（要先点停止）—— 那是防误操作的**设计决策**，不是界面卡住。
   ══════════════════════════════════════════════════════════════ */

const SRC = join(__dirname, '..', '..', '..', 'src')

/** 递归列出 src 下的源文件。跳过 __tests__：测试跑在 node 里，用 fs 是应该的 */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const rel = (p: string): string => relative(SRC, p).replace(/\\/g, '/')
const FILES = sourceFiles()

/** 取出每个 `disabled=` 后面紧跟的一小段（属性可能跨行写） */
function disabledExprs(src: string): string[] {
  const out: string[] = []
  let i = src.indexOf('disabled=')
  while (i !== -1) {
    out.push(src.slice(i, i + 120).replace(/\s+/g, ' '))
    i = src.indexOf('disabled=', i + 1)
  }
  return out
}

describe('AG-009 / Renderer 不阻塞', () => {
  it('src/ 下没有人用同步 IPC（sendSync 会连主进程一起卡住）', () => {
    /*
      只认字面量。**不写 `sendSync(` 那种正则** —— 漏掉了可选链写法
      `sendSync?.(...)`，而这个项目到处都在用 `?.`（变异测试抓出来的）。
      宁可误报：注释里提到也拦。
    */
    const bad = FILES.filter((f) => /sendSync/.test(readFileSync(f, 'utf8')))
    expect(bad.map(rel)).toEqual([])
  })

  it('src/ 下没有人直接摸 node / electron / 子进程 —— 重活必须住在主进程', () => {
    const PATTERNS = [
      /from\s+['"]node:/,
      /require\(\s*['"]node:/,
      /from\s+['"]electron['"]/,
      /\bchild_process\b/,
      /\bnode-pty\b/,
      /\bipcRenderer\b/,
    ]
    const bad: string[] = []
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8')
      if (PATTERNS.some((p) => p.test(src))) bad.push(rel(f))
    }
    expect(bad).toEqual([])
  })

  it('没有任何 disabled 由「Agent 正在跑」决定（跑着也要能点）', () => {
    const bad: string[] = []
    for (const f of FILES) {
      for (const expr of disabledExprs(readFileSync(f, 'utf8'))) {
        if (/sending|isActivePhase|useAgentActive|agentActive/.test(expr)) {
          bad.push(`${rel(f)} → ${expr}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('唯一的例外得是写明白的那一处：Composer 的 canSend', () => {
    const src = readFileSync(join(SRC, 'components', 'chat', 'Composer.tsx'), 'utf8')
    expect(src).toContain('const canSend = !sending &&')
    /* 而且 must 只有这一处 —— 别处不许再拿 sending 去卡发送 */
    const occurrences = (src.match(/!sending/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('列表类视图在跑的时候不被卸载（子任务 AG-001 家族的老教训）', () => {
    /* 这里只钉住最容易退化的一条：右栏 host 不能用条件渲染包住面板 */
    const src = readFileSync(join(SRC, 'components', 'layout', 'RightPanelHost.tsx'), 'utf8')
    expect(src).not.toMatch(/rightPanelVisible\s*\?[^:]*<RightPanel/)
  })
})

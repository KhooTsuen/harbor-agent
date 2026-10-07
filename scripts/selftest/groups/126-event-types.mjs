import { join, readFileSync, ROOT, fsCore } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   P0-7：事件类型登记表两侧对齐

   主进程把所有 Agent 事件经一条通道（`chat:event`）推给渲染层，靠 `type` 区分。
   这一组钉四件**会漂**的事（硬约束 9）：

     ① 生命周期标准名：`electron/core/event-types.cjs` 的 `AGENT_EVENTS` 与渲染层
        `src/types/events.ts` 的镜像**逐字相等**；
     ② 事件 type 全集：主进程 `CHAT_EVENT_TYPES` 与渲染层 `EVENT_TYPES` **逐字相等**
        （新增一种事件漏了任何一侧就报红 —— loop / compacted 这两处就是这么抓出来的）；
     ③ 主进程**发出点**不越界：扫所有 `emit({ ... })` 的 `type` 字面量，全部在清单里；
     ④ 消费点不漂：`handleStreamEvent` 的每个 `case '…'` 都登记在清单里。

   ★ 为什么值得单列：事件 type 是**裸字符串契约**，两边各写各的，改一处漏一处
     编译器一点忙都帮不上（.ts 和 .cjs 之间没有类型传递）。只能靠「从两侧源码
     抠出来真比一遍」。
   ★ 为什么③按「源码里出现 `emit({`」来选文件，而不是写死一份文件清单：
     写死的清单会漂（新增一个发事件的模块没人记得补）—— 判据跟着源码走就不会。
   ══════════════════════════════════════════════════════════════ */

const pickStrings = (body) => [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
const sorted = (a) => [...a].sort()
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

/** 两侧差异（报错时给人看，比一长串列表有用） */
function diffMsg(a, b) {
  const sa = new Set(a)
  const sb = new Set(b)
  const onlyA = a.filter((x) => !sb.has(x))
  const onlyB = b.filter((x) => !sa.has(x))
  return `主进程独有=[${onlyA.join(',')}] 渲染层独有=[${onlyB.join(',')}]`
}

/** 从源码里抠出一个 `名字 = [ … ]` 数组体 */
function grabArray(src, decl) {
  const m = src.match(new RegExp(`${decl}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  return m ? m[1] : ''
}

/** 数组体 → 名字集合。带上 `...AGENT_EVENTS` 展开的生命周期名（正则抠不到展开号） */
function collect(body, agentNames) {
  const set = new Set(pickStrings(body))
  if (/\.\.\.AGENT_EVENTS/.test(body)) for (const n of agentNames) set.add(n)
  return [...set]
}

/** 会 emit 事件的主进程文件 —— 判据是源码里出现 `emit({` / `emit?.({` */
function emitSourceFiles(dir) {
  const out = []
  for (const entry of fsCore.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...emitSourceFiles(full))
    else if (entry.name.endsWith('.cjs') && /emit\??\s*\(\s*\{/.test(readFileSync(full, 'utf8')))
      out.push(full)
  }
  return out
}

/* `type: 'x'` 里这些**不是事件**：OpenAI 工具定义的结构字段（`{ type: 'function', … }`） */
const NON_EVENT_TYPES = new Set(['function'])

export async function run() {
  const procSrc = readFileSync(join(ROOT, 'electron/core/event-types.cjs'), 'utf8')
  const frontSrc = readFileSync(join(ROOT, 'src/types/events.ts'), 'utf8')

  const procAgent = pickStrings(grabArray(procSrc, 'const AGENT_EVENTS'))
  const procAll = collect(grabArray(procSrc, 'const CHAT_EVENT_TYPES'), procAgent)
  const frontAgent = pickStrings(grabArray(frontSrc, 'const AGENT_EVENTS'))
  const frontAll = collect(grabArray(frontSrc, 'const EVENT_TYPES'), frontAgent)

  group('P0-7 / 生命周期标准名：两侧逐字相等')
  check(
    '两侧都抠得到 AGENT_EVENTS',
    procAgent.length > 0 && frontAgent.length > 0,
    `${procAgent.length}/${frontAgent.length}`,
  )
  check(
    '★★ 逐字相等（主进程改了名字、渲染层没跟上就报红）',
    same(procAgent, frontAgent),
    diffMsg(procAgent, frontAgent),
  )

  group('P0-7 / 事件 type 全集：两侧逐字相等')
  check(
    '两侧都抠得到全集',
    procAll.length > 0 && frontAll.length > 0,
    `${procAll.length}/${frontAll.length}`,
  )
  check(
    '★★ 逐字相等（主进程新增/删了 type、渲染层没跟上就报红）',
    same(procAll, frontAll),
    diffMsg(procAll, frontAll),
  )

  group('P0-7 / 主进程发出点：emit 的 type 都在清单里')
  const files = [
    ...emitSourceFiles(join(ROOT, 'electron/core')),
    ...emitSourceFiles(join(ROOT, 'electron/handlers')),
  ]
  const emitted = new Set()
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/type:\s*'([^']+)'/g)) {
      if (!NON_EVENT_TYPES.has(m[1])) emitted.add(m[1])
    }
  }
  check('确实扫到了 emit（不是空扫）', files.length > 3 && emitted.size > 10, `${files.length} 文件 / ${emitted.size} 种`)
  const procSet = new Set(procAll)
  const stray = [...emitted].filter((t) => !procSet.has(t))
  check('★ 每个 emit 的 type 都登记在清单里（新增事件忘了登记就报红）', stray.length === 0, stray.join(','))

  group('P0-7 / 渲染层消费点：handleStreamEvent 的 case 都在清单里')
  const streamSrc = readFileSync(join(ROOT, 'src/stores/thread/streamEvents.ts'), 'utf8')
  const cases = [...streamSrc.matchAll(/case\s*'([^']+)'\s*:/g)].map((m) => m[1])
  check('确实扫到了 case（不是空扫）', cases.length > 5, String(cases.length))
  const frontSet = new Set(frontAll)
  const unknown = [...new Set(cases)].filter((t) => !frontSet.has(t))
  check('★ 每个 case 都登记在清单里（新增事件忘了登记就报红）', unknown.length === 0, unknown.join(','))
}

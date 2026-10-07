import { join, readFileSync, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   P0-7：事件类型登记表两侧对齐

   主进程把所有 Agent 事件经一条通道（`chat:event`）推给渲染层，靠 `type` 区分。
   这一组钉两件**会漂**的事（硬约束 9）：
     ① 生命周期标准名：`electron/core/events.cjs` 的 `AGENT_EVENTS` 与渲染层
        `src/types/events.ts` 的镜像**逐字相等**；
     ② 消费点不漂：`handleStreamEvent` 的每个 `case '…'` 都登记在清单里
        （新增一种事件、忘了登记 → 报红）。

   ★ 为什么值得单列：事件 type 是**裸字符串契约**，两边各写各的，改一处漏一处
     编译器一点忙都帮不上（.ts 和 .cjs 之间没有类型传递）。只能靠「从两侧源码
     抠出来真比一遍」。
   ══════════════════════════════════════════════════════════════ */

const pickStrings = (body) => [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
const sorted = (a) => [...a].sort()
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

export async function run() {
  const backSrc = readFileSync(join(ROOT, 'electron/core/events.cjs'), 'utf8')
  const frontSrc = readFileSync(join(ROOT, 'src/types/events.ts'), 'utf8')

  group('P0-7 / 生命周期标准名：两侧逐字相等')
  const backBody = backSrc.match(/const AGENT_EVENTS\s*=\s*\[([\s\S]*?)\]/)
  const frontBody = frontSrc.match(/export const AGENT_EVENTS\s*=\s*\[([\s\S]*?)\]/)
  const back = backBody ? pickStrings(backBody[1]) : []
  const front = frontBody ? pickStrings(frontBody[1]) : []
  check('两侧都抠得到 AGENT_EVENTS', back.length > 0 && front.length > 0, `${back.length}/${front.length}`)
  check(
    '★★ 逐字相等（主进程改了名字、渲染层没跟上就报红）',
    same(back, front),
    `back=${back.join(',')} | front=${front.join(',')}`,
  )

  group('P0-7 / 消费点：handleStreamEvent 的 case 都在清单里')
  const evBodyMatch = frontSrc.match(/export const EVENT_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/)
  check('抠得到 EVENT_TYPES', evBodyMatch != null)
  const evBody = evBodyMatch ? evBodyMatch[1] : ''
  const all = new Set([...pickStrings(evBody), ...(/\.\.\.AGENT_EVENTS/.test(evBody) ? back : [])])
  check("清单里带 'phase'（生命周期相位事件）", all.has('phase'))
  check('清单里收进了全部生命周期名', back.every((t) => all.has(t)))

  const streamSrc = readFileSync(join(ROOT, 'src/stores/thread/streamEvents.ts'), 'utf8')
  const cases = [...streamSrc.matchAll(/case\s*'([^']+)'\s*:/g)].map((m) => m[1])
  check('确实扫到了 case（不是空扫）', cases.length > 5, String(cases.length))
  const unknown = [...new Set(cases)].filter((t) => !all.has(t))
  check(
    '★ 每个 case 都登记在清单里（新增事件忘了登记就报红）',
    unknown.length === 0,
    unknown.join(','),
  )
}

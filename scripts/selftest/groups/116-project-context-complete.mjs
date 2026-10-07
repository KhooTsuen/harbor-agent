import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   项目上下文必须**完整**进上下文（问题 1）

   2026-10-03 实测（`tmp/trim-measure.mjs`）：Harbor 自己的 `AGENT.md` 是 8157 字符，
   可它要过两道裁剪 —— `project.cjs` 的 6000、`context-builder` 的 `budget.project`
   （总字符 × 15% = 1843）—— 最后只剩 1817 字符：**15 个标题只进去 4 个**，
   「硬禁区 / 收工前必须跑 / 交付时必须报告」和全部附录模型**从来没读到过**。
   写成文件里的规矩默默失效，比没有规矩更糟：用户以为已经交代过了。

   这一组钉四件事：
     ① 常见体量（跟 AGENT.md 同一量级）**一个字都不许少**；
     ② 仍然有上限 —— 远超生产者上限时照旧截断并留「已截断」标记（不是无限塞）；
     ③ **不挤别层**：各层额度各自独立算，放宽项目层不会动记忆 / 会话状态的额度；
     ④ `PROJECT_FLOOR` 与两个生产者的上限之间是**可核对的算术关系**，不是拍的数字。
   ══════════════════════════════════════════════════════════════ */

const builder = require(join(ROOT, 'electron/core/context-builder.cjs'))
const project = require(join(ROOT, 'electron/core/project.cjs'))
const projectRules = require(join(ROOT, 'electron/core/project-rules.cjs'))

const BUDGET = { system: 10, memory: 5, project: 15, task: 10, conversation: 30, tools: 20, reserve: 10 }
const TAIL = '## 最后一条规矩：尾部标记 TAIL-MARK-9F3'
const MID = '## 中间那条：中段标记 MID-MARK-4A1'

/** 造一个指定体量的项目说明：首段 + 中段标记 + 尾段 + 尾标记 */
function makeProject(halfChars) {
  const base = mkdtempSync(join(tmpdir(), 'projcomplete-'))
  const dir = join(base, '项目')
  mkdirSync(dir, { recursive: true })
  const chunk = '这是一条规矩的占位文字，用来把文档撑到真实体量。\n'
  const half = chunk.repeat(Math.ceil(halfChars / chunk.length)).slice(0, halfChars)
  const content = `# 项目规矩\n## 定位\n${half}${MID}\n${half}${TAIL}\n`
  writeFileSync(join(dir, 'AGENT.md'), content, 'utf8')
  return { base, dir, content }
}

export async function run() {
  group('项目上下文完整进上下文 / 常见体量一个字不少')
  const mid = makeProject(4000)
  try {
    const section = project.buildPromptSection({ workdir: mid.dir })
    const kept = builder.assemble({ maxTokens: 4096, budget: BUDGET, project: section, messages: [] }).systemContext.project
    check('测试数据确实是常见的八千里量级', mid.content.length > 8000 && mid.content.length < 12000, `实际=${mid.content.length}`)
    check('★ 项目上下文一层都没被裁（section 原样过去）', kept.length === section.length, `${section.length} → ${kept.length}`)
    check('★ 中段还在（不是只留了开头）', kept.includes('MID-MARK-4A1'), `长度=${kept.length}`)
    check('★ **尾段还在**（这条就是问题 1 的判据：最后一条规矩也进得去）', kept.includes('TAIL-MARK-9F3'), `结尾 120 字=${JSON.stringify(kept.slice(-120))}`)
    check('没有被套上「按预算裁剪」的标记', !kept.includes('上下文已按预算裁剪'))

    group('项目上下文完整进上下文 / 真仓库（Harbor 自己）')
    const manual = project.read({ workdir: ROOT })
    const realSection = project.buildPromptSection({ workdir: ROOT })
    const realKept = builder.assemble({ maxTokens: 4096, budget: BUDGET, project: realSection, messages: [] }).systemContext.project
    check('`AGENT.md` 读得到', manual.found === true && String(manual.content).length > 0, `长度=${String(manual.content).length}`)
    check(
      '★ 真仓库：裁只能在**生产者的上限**处发生，不能在 budget 处再切一刀',
      realKept.length >= Math.min(String(manual.content).length, project.MAX_CHARS),
      `AGENT.md=${String(manual.content).length}｜section=${realSection.length}｜进上下文=${realKept.length}`,
    )
    const lastLine = String(manual.content)
      .split('\n')
      .filter((l) => l.trim())
      .at(-1)
    check(
      '★ 真仓库：文件的**最后一行**（收尾/附录那一段）确实进了上下文',
      String(manual.content).length <= project.MAX_CHARS ? realKept.includes(lastLine) : true,
      `最后一行=${JSON.stringify(String(lastLine).slice(0, 60))}｜AGENT.md 是否超过生产者上限=${String(manual.content).length > project.MAX_CHARS}`,
    )

    group('项目上下文完整进上下文 / 上限仍然在（不是无限塞）')
    const huge = makeProject(20000)
    try {
      const hugeSection = project.buildPromptSection({ workdir: huge.dir })
      check('★ 超长项目说明仍被生产者的上限截断', hugeSection.length < huge.content.length, `文档=${huge.content.length}｜section=${hugeSection.length}`)
      check('★ 截断时明确告诉模型「被截断了」并给出文件在哪', hugeSection.includes('已截断') && hugeSection.includes('AGENT.md'), `结尾 80 字=${JSON.stringify(hugeSection.slice(-80))}`)
    } finally {
      rmSync(huge.base, { recursive: true, force: true })
    }

    group('项目上下文完整进上下文 / 不许挤别层的额度')
    const longMemory = '记'.repeat(20000)
    const longState = '状'.repeat(20000)
    const capped = builder.assemble({
      maxTokens: 4096,
      budget: BUDGET,
      project: mid.content,
      memory: longMemory,
      conversationState: longState,
      messages: [],
    })
    const totalChars = 4096 * 3
    const memCap = Math.max(400, Math.floor((totalChars * BUDGET.memory) / 100))
    const taskCap = Math.max(400, Math.floor((totalChars * BUDGET.task) / 100))
    check('★ 记忆那层仍按它自己的百分比裁（没被项目层抢额度）', capped.systemContext.memory.length <= memCap + 40, `${capped.systemContext.memory.length} / 上限≈${memCap}`)
    check('★ 会话状态那层同理', capped.systemContext.conversationState.length <= taskCap + 40, `${capped.systemContext.conversationState.length} / 上限≈${taskCap}`)
    check('项目层这次没被裁（同一个 assemble 调用里三层的命运各归各的）', !capped.systemContext.project.includes('上下文已按预算裁剪'))

    group('项目上下文完整进上下文 / 下限是算术关系，不是拍的数字')
    check(
      '★ PROJECT_FLOOR ≥ AGENT.md 上限 + 项目规则上限（所以它是「不裁」而不是「另一个更大的上限」）',
      builder.PROJECT_FLOOR >= project.MAX_CHARS + projectRules.MAX_CHARS,
      `floor=${builder.PROJECT_FLOOR}｜AGENT.md 上限=${project.MAX_CHARS}｜规则上限=${projectRules.MAX_CHARS}`,
    )
    check('空项目上下文仍然不注入空标题', builder.assemble({ maxTokens: 4096, budget: BUDGET, project: '', messages: [] }).systemContext.project === '')

    /*
     * 预算表里**每一项都必须真的生效**（2026-10-08）。
     *
     * 起因：表里曾有 7 个键，而 `assemble` 只用了 4 个 —— 实测把 `budget.system`
     * 改成 90，各层输出逐字不变。声明了却从不使用的预算，跟「写了没人读的配置」
     * 是同一个病（`109-scale-config.mjs` 那一组治的也是它），而且更隐蔽：它连
     * 「有没有人读」都难查，因为它压根不是配置项、只是表里的一行。
     *
     * 判据按 109 的口径（2026-10-03 用户拍板）：**看判决（这里是各层实裁长度）变没变，
     * 不看「表里有这个键」** —— 只断言「键存在」等于给死键留后门。
     */
    group('预算表 / 表里每一项都真的生效（没有死键）')
    const KEYS = Object.keys(builder.DEFAULT_BUDGET)
    const conv = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(3000),
    }))
    /* 三层都塞到远超额度，这样任何一项的额度变化都会体现在实裁长度上。
       ★ 输入必须**大过 90% 那一档**（总字符 49152）—— 否则「默认额度」和「90% 额度»
       都没触发裁剪，两层长度一样，这条断言就成了空转（第一版就是这么写的，
       被自检当场逮住：project 层因为 PROJECT_FLOOR 下限把 20000 整个放进去了）。 */
    const BIG = 60000
    const measure = (extra) =>
      builder.assemble({
        maxTokens: 16384,
        budget: extra,
        memory: '记'.repeat(BIG),
        project: '项'.repeat(BIG),
        conversationState: '状'.repeat(BIG),
        messages: conv,
      })
    const base = measure({})
    /** 改动某一项额度后，各层「实裁长度 / 条数」有没有跟着动 */
    const finger = (r) => [
      r.systemContext.memory.length,
      r.systemContext.project.length,
      r.systemContext.conversationState.length,
      r.messages.length,
    ]
    check(
      '★ 死键（system / tools / reserve）已从生效表里拿掉',
      !('system' in builder.DEFAULT_BUDGET) &&
        !('tools' in builder.DEFAULT_BUDGET) &&
        !('reserve' in builder.DEFAULT_BUDGET),
      KEYS.join(','),
    )
    for (const key of KEYS) {
      const bumped = measure({ [key]: 90 })
      check(
        `★★ ${key} 改了真的生效（不是声明了没人用）`,
        JSON.stringify(finger(bumped)) !== JSON.stringify(finger(base)),
        `默认=${JSON.stringify(finger(base))}｜${key}=90 → ${JSON.stringify(finger(bumped))}`,
      )
    }
    /* 反向对照：老盘上可能还存着 `system` —— 它必须是**真的不管事**（上面那条的另一面） */
    const withDeadKey = measure({ system: 90 })
    check(
      '★ 反向：`system` 这条老键即使传进来也不改变任何一层（它不是「悄悄还在生效」）',
      JSON.stringify(finger(withDeadKey)) === JSON.stringify(finger(base)),
      `${JSON.stringify(finger(withDeadKey))}`,
    )
  } finally {
    rmSync(mid.base, { recursive: true, force: true })
  }
}

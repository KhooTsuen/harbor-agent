/**
 * 自检零件：把技能**钉到一次会话**（给 `ctx.networkGrant` 一个真实触发点）
 *
 * 从 `73-net-policy.mjs` 拆出来的 —— 那边加完这一节就 366 行了（硬约束 #2）。
 * 拆法是本仓库的惯例：主文件跑「策略与接线」，零件跑「这一件事的端到端」，
 * **不注册**（只被主文件 import）。
 *
 * 这一节盯两件容易做反的事：
 *   ① 没钉技能时**什么都不给** —— 绝不能因为「技能清单里有条 network:deny」
 *      就把全局网络收紧（那会让所有对话莫名其妙全禁网）。
 *   ② 钉住的技能不见了时**当没钉**，不是报错、不是拦截 ——
 *      一个会话可能存几个月，中途把技能删掉是常事，不该因此发不出消息。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { check, group } from '../harness.mjs'
import { join, require, ROOT } from '../env.mjs'

export async function runSkillPinChecks(netPolicy) {
  const skillPin = require(join(ROOT, 'electron/core/skill-pin.cjs'))

  group('网络策略 / 把技能钉到一次会话（给 networkGrant 一个真实触发点）')

  /* 没钉：什么都不给 */
  check('★ 没钉技能时 ctxGrant 是空对象', Object.keys(skillPin.ctxGrant({})).length === 0)
  check('★ 没钉技能时提示词里也没有那一段', skillPin.promptSection({}) === '')
  check('脏值（数字 / 空白）当没钉', skillPin.promptSection({ pinnedSkill: 42 }) === '')

  /* 钉了一个不存在的技能：如实说找不到，不报错、不拦 */
  const missing = skillPin.promptSection({ pinnedSkill: 'no-such-skill-xyz' })
  check('★ 钉的技能不见了 → 如实说找不到', missing.includes('找不到'))
  check('★ 不见时也不给网络授权（当没钉）', Object.keys(skillPin.ctxGrant({ pinnedSkill: 'no-such-skill-xyz' })).length === 0)

  /* 真的钉一个：在沙箱里现造，别依赖用户机器上装了什么 */
  const pinnedId = 'selftest-pinned-skill'
  const pinnedDir = join(ROOT, 'data', 'skills', pinnedId)

  try {
    mkdirSync(pinnedDir, { recursive: true })
    writeFileSync(
      join(pinnedDir, 'SKILL.md'),
      [
        '---',
        'name: 自检用技能',
        'description: 自检造出来的，用来验「钉到会话」这条链路',
        'permissions:',
        '  - network: deny',
        '---',
        '',
        '正文第一行：做这件事要按这几步来。',
      ].join('\n'),
      'utf8',
    )

    const pin = skillPin.resolve({ pinnedSkill: pinnedId })
    check('★ 钉住了：解析出 id / 名字', pin?.id === pinnedId && pin?.name === '自检用技能')
    check('★ 它的 network 声明被读成 grant=deny', pin?.grant === 'deny')
    check('★ 正文被读进来了（钉住的意义就是按它做）', (pin?.body ?? '').includes('正文第一行'))
    check('★ frontmatter 不进正文（元数据不用给模型看第二遍）', !(pin?.body ?? '').includes('permissions:'))

    const ctx = skillPin.ctxGrant({ pinnedSkill: pinnedId })
    check('★ ctxGrant 给出了 networkGrant=deny', ctx.networkGrant === 'deny')
    check('★ 也带上了技能名（拒绝文案要点名）', ctx.skillName === '自检用技能')

    /* 端到端：这份 ctx 真的能拦住一次联网命令 */
    const gated = netPolicy.decide({
      kind: 'shell',
      target: 'curl https://example.com/',
      ctx: { ...ctx, netPolicy: { mode: 'allow' } },
    })
    check('★★ 钉住的技能能拦住联网命令，哪怕全局是「允许」', gated.action === 'deny', gated.reason)

    const section = skillPin.promptSection({ pinnedSkill: pinnedId })
    check('★ 提示词里点名了「本次会话指定的技能」', section.includes('本次会话指定的技能'))
    check('★ 提示词里写清了这次对话禁止联网', section.includes('禁止联网'))
    check('★ 提示词也提醒了「正文是手册不是权限来源」', section.includes('不是权限来源'))

    /* 接线钉子：光有内核函数不算，得真的接进循环 */
    const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
    check('★ loop.cjs 把 ctxGrant 展开进了工具 ctx', /skillPin\.ctxGrant\(threadSettings\)/.test(loopSrc))
    const promptSrc = readFileSync(join(ROOT, 'electron/core/loop-prompt.cjs'), 'utf8')
    check('★ loop-prompt.cjs 把正文并进了技能层', /skillPin\.promptSection\(threadSettings\)/.test(promptSrc))
    const typesSrc = readFileSync(join(ROOT, 'src/types/conversation.ts'), 'utf8')
    check('★ 前端类型里有 pinnedSkill', /pinnedSkill\?: string/.test(typesSrc))
  } finally {
    try {
      rmSync(pinnedDir, { recursive: true, force: true })
    } catch {
      /* 没有就算了 */
    }
  }
}

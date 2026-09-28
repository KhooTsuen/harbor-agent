/**
 * 第 9 项检查：**易漂数字**
 *
 * 有一类数字**每版都会涨**：内核自检项数、前端单测数、IPC 通道数。
 * 把它们抄进文档里，就等于给自己埋一个必然过期的说法 —— 而这件事
 * 本项目已经发生过 **三次**（CHANGELOG 1.20.0-beta.1 / 更早两节都记着「文档漂移」）。
 *
 * 所以：这些数字**只准出现在两个地方** —— 代码/配置里的一份定义、以及命令的输出。
 * 文档里要说得写「看输出」。
 *
 * 只查「现状说明」类的文件：`CHANGELOG.md` / `docs/更新历史.md` / `docs/验收核对-*.md`
 * 是**历史记录**，当时的数字就是事实，不该被改写 —— 所以它们不在名单里。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 这些文件的定位是「说清现在什么样」 → 一旦写死计数，必然说过期的话 */
const WATCHED = [
  'AGENT.md',
  'README.md',
  'CONTRIBUTING.md',
  '.github/copilot-instructions.md',
  'docs/架构.md',
  'docs/开发流程.md',
  'docs/约束机制说明.md',
]

const PATTERNS = [
  { re: /(\d{3,}\+?)\s*项/g, what: '自检 / 测试项数' },
  { re: /(\d{2,3})\s*个?\s*(?:IPC\s*)?通道/g, what: 'IPC 通道数' },
]

/** 允许的例外：明确写了「看输出 / 每版都会涨」这类前提的行 */
const EXEMPT = /看(?:它的)?输出|每版(?:都)?会涨|不再写死|不写死/

function watchedFiles(root) {
  const list = [...WATCHED]
  const instr = path.join(root, '.github', 'instructions')
  try {
    for (const e of fs.readdirSync(instr, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) list.push(path.join('.github', 'instructions', e.name))
    }
  } catch {
    /* 没有这个目录就算了 */
  }
  return list
}

export function checkDriftingNumbers(root) {
  const warnings = []

  for (const rel of watchedFiles(root)) {
    const file = path.join(root, rel)
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue /* 这个仓库没这份文件就跳过 */
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (EXEMPT.test(line)) return
      for (const { re, what } of PATTERNS) {
        for (const hit of line.matchAll(re)) {
          warnings.push(
            `${rel.replace(/\\/g, '/')}:${index + 1}　写死了${what}「${hit[1]}」—— 改成「看输出」或「每版都会涨」`,
          )
        }
      }
    })
  }

  return {
    errors: [],
    warnings,
    summary: warnings.length === 0 ? `说了 ${watchedFiles(root).length} 份文件，没有写死的计数` : `${warnings.length} 处`,
  }
}

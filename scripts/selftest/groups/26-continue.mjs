import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-017：失败后继续

   文档要求：
     Step 1 ✓ / Step 2 ✓ / Step 3 ✗ → 分析失败 → 调整 Step 3 → 继续
     **禁止从 Step 1 重新开始**

   「模型能看到历史里的成功步骤」这件事本身不够 —— **历史会被压缩**
   （AG-016 的 ContextOverflow → Compact），压完早期步骤只剩摘要里一句话，
   那时候模型可能「保险起见从头再来」。所以要把进度再明确说一遍。
   ══════════════════════════════════════════════════════════════ */

const { buildFailureNote } = require(join(ROOT, 'electron/core/loop-prompt.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-017 · 失败后继续')

  /* ── 进度对照的内容 ── */
  const note = buildFailureNote({
    done: ['read_file', 'list_dir'],
    failed: [{ name: 'run_shell', hint: '命令非正常退出（看退出码和输出）' }],
  })
  check('写出了已完成的步骤', note.includes('read_file') && note.includes('list_dir'))
  check('写出了失败的是哪一步', note.includes('run_shell'))
  check('带上了失败原因', note.includes('非正常退出'))
  check('★ 明确要求「针对失败那一步调整」', note.includes('针对失败的那一步调整'))
  check('★ 明确说「成功的别重做」（这就是「禁止从 Step 1 重来」）', note.includes('不必重做'))

  /* ── 边界：没有成功步骤时不出现空行 ── */
  const onlyFail = buildFailureNote({ done: [], failed: [{ name: 'x', hint: 'y' }] })
  check('一条都没成时不写「本轮已完成」', !onlyFail.includes('本轮已完成'))
  /* ── 边界：失败原因缺失时给个兜底 ── */
  const noHint = buildFailureNote({ done: ['a'], failed: [{ name: 'b' }] })
  check('没有原因时写「原因不明」（不出现 undefined）', noHint.includes('原因不明'))
  check('空参数不炸', typeof buildFailureNote() === 'string')

  /* ── 接进循环了没 ── */
  const loopTools = readCore('electron/core/loop-tools.cjs')
  check('★ 循环在收集成功的名字', loopTools.includes('doneNames.push(call.name)'))
  check('★ 循环在收集失败信息', loopTools.includes('failures.push({ name: call.name'))
  check('★ 有失败时才追加那条消息', loopTools.includes('if (failures.length > 0)'))
  check('用的是 buildFailureNote', loopTools.includes('buildFailureNote({ done: doneNames'))
  check(
    '★ 追加成 user 消息（OpenAI 协议里 tool 之后接 user 是合法的）',
    /failures\.length > 0[\s\S]{0,120}role: 'user'/.test(loopTools),
  )

  /* ── 文案住在 prompt 模块里（提示文案的家） ── */
  const promptSrc = readCore('electron/core/loop-prompt.cjs')
  check('buildFailureNote 定义在 loop-prompt.cjs', promptSrc.includes('function buildFailureNote'))
  check('并且导出了', promptSrc.includes('buildFailureNote }'))
}

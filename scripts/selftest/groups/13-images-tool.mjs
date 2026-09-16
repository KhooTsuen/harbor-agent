import path from 'node:path'
import fs from 'node:fs'
import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, require, tools } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   generate_image 工具本身

   从 11-images.mjs 拆出来的（那边超 300 行了）。
   重点是**提交路径立刻返回、不干等** —— 上游排队要 5 分钟，
   同步等会让界面卡住，一旦超时图还丢了。
   ══════════════════════════════════════════════════════════════ */

const scene = require(join(ROOT, 'electron/core/scene.cjs'))
const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))

export async function run() {
  /* ── ③ generate_image 工具 ─────────────────────────────── */

  group('图像 / generate_image 工具')
  const tool = registry.byName('generate_image')
  check('工具已注册', tool !== null)
  check('归到写操作（ask 档要确认、readonly 档要拦）', registry.WRITE_TOOLS.has('generate_image'))
  check(
    '出现在给模型的工具清单里',
    tools.catalog().some((t) => t.name === 'generate_image'),
  )

  let noArgs = null
  try {
    await tool.run({}, { workdir: SANDBOX })
  } catch (error) {
    noArgs = error
  }
  check('prompt 和 taskId 都没给会明确报错', noArgs !== null && /taskId/.test(noArgs.message))

  /*
   * ★ 提交路径：**立刻返回**，不干等。
   * 上游排队要 5 分钟，工具同步等是错的（界面会卡住、超时就丢图）。
   */
  const realSubmit = scene.submitImage
  scene.submitImage = async () => ({
    ok: true,
    submitOnly: true,
    taskId: 'task_abc',
    model: 'test-image-model',
  })
  const submitOut = await tool.run({ prompt: '一只戴帽子的猫' }, { workdir: SANDBOX })
  scene.submitImage = realSubmit

  check('提交后把任务号交出去', submitOut.includes('task_abc'), submitOut.slice(0, 150))
  check(
    '★ 明确说「还没画好」（不然模型会误报已出图）',
    submitOut.includes('还没画好'),
    submitOut.slice(0, 200),
  )
  check('★ 说清图会自己出现，不用用户再问', submitOut.includes('自动出现'), submitOut.slice(0, 250))

  /* taskId 路径：把已有的图取回来并落盘 */
  const realGenerate = scene.generateImage
  scene.generateImage = async () => ({
    ok: true,
    image: `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`,
    model: 'test-image-model',
  })
  const out = await tool.run({ taskId: 'task_x' }, { workdir: SANDBOX })
  scene.generateImage = realGenerate

  check(
    '取回路径返回 markdown 图片（界面这才显示得出来）',
    /!\[[^\]]*\]\(file:\/\//.test(out),
    out.slice(0, 120),
  )
  check('返回值里说了存到哪', out.includes('generated'), out.slice(-120))

  /* 真的写到盘上了 */
  const dir = path.join(SANDBOX, 'generated')
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^image-.*\.png$/.test(f))
    : []
  check('图片真的落到了 generated/ 下', files.length > 0, JSON.stringify(files.slice(0, 3)))

  /* 只查一眼：不该等 */
  scene.generateImage = async () => ({
    ok: false,
    pending: true,
    taskId: 'task_peek',
    status: 'processing',
  })
  const peekOut = await tool.run({ taskId: 'task_peek', wait: false }, { workdir: SANDBOX })
  scene.generateImage = realGenerate
  check('wait:false 只查一眼、报上游状态', peekOut.includes('processing'), peekOut.slice(0, 120))
}

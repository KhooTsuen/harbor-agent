/**
 * 自检 / 文件系统：右栏预览的「根」必须贯穿到底
 *
 * 钉 2026-10-13 真机 bug（用户报「我自己要读文件和它有什么关系」）：
 *   `fs:tree` 按**这条对话自己的目录**列树，而 `fs:read` / `fs:list` / `fs:reveal`
 *   一律按**全局工作目录**解析相对路径，`buildTree` 算相对路径也按全局那个 ——
 *   于是「对话目录 ≠ 全局目录」时右栏**列得出来、点开读不了**，
 *   报的还是句看不懂的话（「只能访问工作目录里的内容。工作目录是：<全局目录>」）。
 *
 * 两个根本环各钉一条（行为级，不是看代码像不像）：
 *   · `rootOf` —— 认「已有对话挂过的目录」，不认的回落全局（**不是**来者不拒）；
 *   · `buildTree(root, ...)` —— 相对路径相对**传入的 root** 算，不再带 `..`。
 */

import { check, group } from '../harness.mjs'
import { join, require, ROOT, SANDBOX } from '../env.mjs'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const session = require(join(ROOT, 'electron/core/session.cjs'))
const fsHandler = require(join(ROOT, 'electron/handlers/fs.cjs'))
const fsRoot = require(join(ROOT, 'electron/handlers/fs-root.cjs'))

export async function run() {
  group('文件系统 / 预览的根贯穿（会话目录 ≠ 全局目录也要读得到）')

  /* 造一条挂了 SANDBOX 的会话 —— 只有「被对话挂过的目录」才进允许集 */
  const created = session.create({ title: 'fs-root 自检', workdir: SANDBOX }).id

  check(
    'rootOf 认出「对话挂过的目录」',
    fsRoot.rootOf(SANDBOX) === SANDBOX,
    String(fsRoot.rootOf(SANDBOX)),
  )
  check('rootOf 没给 → 回落全局工作目录', fsRoot.rootOf('') === fsRoot.workdir())
  check(
    '★ rootOf 不认识的外部绝对路径 → 回落（不是来者不拒，守卫没被放宽）',
    fsRoot.rootOf(tmpdir()) === fsRoot.workdir(),
    String(fsRoot.rootOf(tmpdir())),
  )

  /* 造一棵小树：<SANDBOX>/sub/note.md */
  const sub = join(SANDBOX, 'sub')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'note.md'), 'hello', 'utf8')

  const tree = fsHandler.buildTree(SANDBOX, SANDBOX, 0, { count: 0 })
  const flat = JSON.stringify(tree)
  check('★ 节点相对路径相对**传入的 root** 算（不再带 ..）', !flat.includes('..'), flat.slice(0, 140))
  check('★ 树里真的能看到 root 里的文件', flat.includes('sub') && flat.includes('note.md'), flat)

  /* 端到端：照界面那两步走 —— ① 从树里拿 node.path ② 按同一个 root 解析再读 */
  const noteNode = tree.find((n) => n.name === 'sub')?.children?.find((n) => n.name === 'note.md')
  const abs = noteNode ? fsRoot.resolveInside(noteNode.path, SANDBOX) : ''
  let content = ''
  try {
    content = abs ? readFileSync(abs, 'utf8') : ''
  } catch {
    content = ''
  }
  check('★ 照界面那两步走：树里的 node.path 拿得到文件内容（真机 bug 的正面证明）', content === 'hello', `${noteNode?.path} → ${content}`)

  check(
    '★ 对的 root 解析得到真实文件',
    fsRoot.resolveInside('sub/note.md', SANDBOX) === join(sub, 'note.md'),
  )

  /*
   * 对照：同一个相对路径，按**错的** root（全局工作目录）解析 ——
   * 要么落在一个**别的**路径上（静默读错文件），要么越界直接报错（旧行为的报错来源）。
   * 无论哪种，都**不会**是那个真实文件 —— 这就是旧 bug。
   */
  let wrong = ''
  try {
    wrong = fsRoot.resolveInside('sub/note.md', fsRoot.workdir())
  } catch {
    wrong = '(越界报错)'
  }
  check(
    '★ （对照）按错的 root 解析不到那个真实文件 —— 旧 bug 的两种面孔',
    wrong !== join(sub, 'note.md'),
    wrong,
  )

  /* 收尾：拆掉自检造的东西，不给后续组留脏数据 */
  try {
    rmSync(sub, { recursive: true, force: true })
  } catch {
    /* 删不掉就算了 */
  }
  try {
    session.remove(created)
  } catch {
    /* 同上 */
  }
}

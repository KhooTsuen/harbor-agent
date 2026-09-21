import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   Windows 路径与编码边界（规范第 23 节）

   这一组是**真机实测**逼出来的：中文 Windows 上 cmd.exe 自己的输出是 GBK，
   而 Node 的 exec 默认按 UTF-8 解码 —— `echo 中文` / `dir` 出来的全是乱码
   （实测 `中文输出测试` → `�����������`，中文文件名也糊成一团）。
   `chcp 65001` 前缀救不了：输出走管道时没有控制台，内建命令照样写 GBK 字节。

   所以这里是两件事一起钉住：
     · 中文 + 空格路径下的读写 / 列目录 / 工作目录边界
     · shell 输出的中文不乱码（UTF-8 与 GBK 两个方向）
   ══════════════════════════════════════════════════════════════ */

const shellEncoding = require(join(ROOT, 'electron/core/shell-encoding.cjs'))
const readFileTool = require(join(ROOT, 'electron/core/tools/read_file.cjs'))
const writeFileTool = require(join(ROOT, 'electron/core/tools/write_file.cjs'))
const listDirTool = require(join(ROOT, 'electron/core/tools/list_dir.cjs'))
const runShellTool = require(join(ROOT, 'electron/core/tools/run_shell.cjs'))

const CN_DIR = join(SANDBOX, '测试 目录(空格)')
const CN_FILE = join(CN_DIR, '中文 文件名.txt')

export async function run() {
  const ctx = { workdir: CN_DIR, permission: 'full', shellTimeout: 30, sessionId: 'selftest-cn' }

  /* ── ① 解码层：两个方向都要对 ─────────────────────────── */
  group('中文环境 / 输出解码')
  check('纯 ASCII 原样', shellEncoding.decode(Buffer.from('hello')) === 'hello')
  check('★ UTF-8 中文解得对（git / type 这类输出）', shellEncoding.decode(Buffer.from('中文内容', 'utf8')) === '中文内容')
  check('空输入不炸', shellEncoding.decode(Buffer.alloc(0)) === '' && shellEncoding.decode(null) === '')
  check('字符串原样透传', shellEncoding.decode('已经是字符串') === '已经是字符串')

  /* 造一段真正的 GBK 字节（用系统 cmd 产出，比手写字节真实） */
  let gbk = null
  if (process.platform === 'win32') {
    try {
      gbk = execSync('cmd /c echo 中文输出测试', { encoding: 'buffer', windowsHide: true })
    } catch {
      gbk = null
    }
  }
  if (gbk) {
    check(
      '★ GBK 字节解得对（cmd 内建命令的输出）',
      shellEncoding.decode(gbk).includes('中文输出测试'),
      JSON.stringify(shellEncoding.decode(gbk).slice(0, 40)),
    )
  } else {
    check('★ GBK 字节解得对（非 Windows 跳过）', true, 'skipped')
  }
  check(
    '★ 能探到 OEM 代码页（非 Windows 走 UTF-8）',
    process.platform === 'win32' ? shellEncoding.oemLabel() === 'gbk' : shellEncoding.oemLabel() === 'utf-8',
    shellEncoding.oemLabel(),
  )

  /* ── ② 中文 + 空格路径下的文件操作 ────────────────────── */
  group('中文环境 / 中文与空格路径')
  rmSync(CN_DIR, { recursive: true, force: true })
  mkdirSync(CN_DIR, { recursive: true })

  const written = await writeFileTool.run({ path: CN_FILE, content: '中文内容 row\n' }, ctx)
  check('write_file 写中文文件名', typeof written === 'string' && written.length > 0, written)

  const back = await readFileTool.run({ path: CN_FILE }, ctx)
  check('read_file 读回内容一致', String(back).includes('中文内容'), String(back).slice(0, 60))

  const listed = await listDirTool.run({ path: CN_DIR }, ctx)
  check('list_dir 显示中文文件名', String(listed).includes('中文'), String(listed).slice(0, 80))

  const shellOut = await runShellTool.run({ command: 'echo hello-from-cn' }, ctx)
  check('run_shell 在中文+空格 cwd 下能跑', String(shellOut).includes('hello-from-cn'), String(shellOut))

  /* ── ③ ★ 真正的回归点：shell 输出的中文 ───────────────── */
  group('中文环境 / shell 输出的中文')
  const cnEcho = await runShellTool.run({ command: 'echo 中文输出测试' }, ctx)
  check(
    '★ echo 中文不乱码',
    String(cnEcho).includes('中文输出测试'),
    JSON.stringify(String(cnEcho).slice(0, 60)),
  )

  /* `type` 是 cmd 内建；POSIX 上是另一个意思（打印命令类型），必须分开 */
  const readCmd = process.platform === 'win32' ? `type "${CN_FILE}"` : `cat "${CN_FILE}"`
  const cnType = await runShellTool.run({ command: readCmd }, ctx)
  check(
    '★ 读 UTF-8 文件的内容不乱码（两个方向都得对）',
    String(cnType).includes('中文内容'),
    JSON.stringify(String(cnType).slice(0, 60)),
  )

  /* ── ④ 边界在中文路径下仍然生效 ───────────────────────── */
  group('中文环境 / 边界')
  let blocked = false
  try {
    await writeFileTool.run(
      { path: join(SANDBOX, '中文越界.txt'), content: 'x' },
      { ...ctx, workdir: CN_DIR, permission: 'ask' },
    )
  } catch {
    blocked = true
  }
  check('★ 中文路径下工作目录边界仍生效', blocked)

  /* ── ⑤ 接线守卫：这两处不能改回去 ─────────────────────── */
  group('中文环境 / 接线')
  const shellSrc = readFileSync(join(ROOT, 'electron/core/tools/run_shell.cjs'), 'utf8')
  check('★ run_shell 按字节收输出（encoding: buffer）', shellSrc.includes("encoding: 'buffer'"))
  check('★ run_shell 过了 shell-encoding 解码', shellSrc.includes('encoding.decode('))

  const ptySrc = readFileSync(join(ROOT, 'electron/core/pty.cjs'), 'utf8')
  check(
    '★ pty 起 cmd 时先切代码页（终端里才不乱码）',
    ptySrc.includes('chcp 65001') && ptySrc.includes("'/k'"),
  )

  rmSync(CN_DIR, { recursive: true, force: true })
}

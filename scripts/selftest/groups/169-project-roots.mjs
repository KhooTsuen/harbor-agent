import { join, ROOT, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   授权项目根（3C-2）：默认不信任任何外部项目

   ── 它解决什么 ───────────────────────────────────────────────
   3A 起项目根必须落在数据根之内 —— 于是**用户自己的项目目录**
   （`E:\独立游戏` 这类）在结构上必然被拒，3C-1 真机自举第一次就撞这里。
   现在改成「用户显式授权的项目根」：授权来源**只有** `projectTests.items[].root`，
   模型给不出新的根；每个根仍要 realpath / 禁区 / 在授权清单里三道。

   本组钉四件事：
     ① 默认（清单为空）→ 外部根一律拒
     ② 授权后读/测试放行；**写/恢复要条目上显式 allowWrite**
     ③ 隔离区内的根四种动作全放行（它本来就是受控测试区）
     ④ 盘符根 / 系统目录 / 不存在 / 大小写 / 符号链接 的判定
   ══════════════════════════════════════════════════════════════ */

const fs = require('node:fs')
const path = require('node:path')

export function run() {
  const roots = require(join(ROOT, 'electron/core/project-roots.cjs'))
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))
  const dataDir = paths.DIRS.data

  /* 自检在隔离数据根里造两个目录：一个当「隔离区内的根」，一个当「外部项目」 */
  const iso = path.join(dataDir, 'c2-iso-proj')
  const outside = path.join(dataDir, 'c2-outside-proj')
  for (const d of [iso, outside]) {
    try {
      fs.mkdirSync(d, { recursive: true })
    } catch {
      /* 已存在 */
    }
  }

  group('3C-2 · 默认不信任任何外部项目')
  check(
    '★★★ 授权清单为空 → 外部根被拒',
    roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: [], action: 'read' }).code ===
      'PROJECT_ROOT_NOT_AUTHORIZED',
  )
  check(
    '★★ 拒绝文案点明「要配成某条测试的项目根」',
    /项目测试/.test(roots.resolveAuthorizedRoot({ root: outside, isoDir: '', items: [] }).message),
  )
  check('★★★ 空根 → 明确拒', roots.resolveAuthorizedRoot({ root: '', items: [] }).code === 'PROJECT_ROOT_MISSING')
  check(
    '★★★ 不存在的目录 → 拒（不让「先授权一个还没建的路径」）',
    roots.resolveAuthorizedRoot({ root: path.join(outside, 'not-yet'), items: [] }).code === 'PROJECT_ROOT_NOT_FOUND',
  )

  group('3C-2 · 授权后：读/测试放行，写要显式 allowWrite')
  const readOnly = [{ root: outside }]
  check(
    '★★★ 授权后可以读',
    roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: readOnly, action: 'read' }).ok === true,
  )
  check(
    '★★★ 授权后可以跑测试',
    roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: readOnly, action: 'test' }).ok === true,
  )
  check(
    '★★★ 只授权了读/测试 → **写被拒**（这是外部项目的默认档）',
    roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: readOnly, action: 'write' }).code ===
      'PROJECT_ROOT_WRITE_NOT_GRANTED',
  )
  check(
    '★★★ 恢复同样被拒（恢复也是写）',
    roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: readOnly, action: 'restore' }).code ===
      'PROJECT_ROOT_WRITE_NOT_GRANTED',
  )
  check(
    '★★ 拒绝文案说清怎么开（「允许修复写入」）',
    /允许修复写入/.test(
      roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: readOnly, action: 'write' }).message,
    ),
  )

  const writable = [{ root: outside, allowWrite: true }]
  check(
    '★★★ allowWrite=true → 写放行',
    roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: writable, action: 'write' }).ok === true,
  )
  check(
    '★★★ allowWrite=true → 恢复也放行',
    roots.resolveAuthorizedRoot({ root: outside, isoDir: '/nonexistent-iso', items: writable, action: 'restore' }).ok === true,
  )
  check(
    '★★ 「allowWrite: \"true\"」字符串不算 true（只认严格 true）',
    roots.resolveAuthorizedRoot({
      root: outside,
      isoDir: '/nonexistent-iso',
      items: [{ root: outside, allowWrite: 'true' }],
      action: 'write',
    }).ok === false,
  )

  group('3C-2 · 隔离区内的根：四种动作全放行（不需要额外开关）')
  for (const action of ['read', 'test', 'write', 'restore']) {
    check(
      `★★★ 隔离区内的根 · ${action} 放行`,
      roots.resolveAuthorizedRoot({ root: iso, isoDir: dataDir, items: [{ root: iso }], action }).ok === true,
    )
  }
  check(
    '★★ 隔离区内的根被标成 isolated（界面/日志能区分）',
    roots.resolveAuthorizedRoot({ root: iso, isoDir: dataDir, items: [{ root: iso }], action: 'write' }).isolated === true,
  )

  /*
   * Windows 专属（2026-10-20 CI 第一次跑就红了 4 项）：
   *   「盘符根」在 POSIX 上不存在（path.parse('/a/b').root === '/'，不是盘符），
   *   「盘符大小写不敏感」「反斜杠尾缀归一」也都是 Windows 路径语义。
   *   产品逻辑没问题 —— 是判据只适用于 Windows。这里跳过并**写在标题里**，
   *   免得日志读者以为这几条验过。
   */
  const winOnly = process.platform === 'win32'
  group(`3C-2 · 禁区：盘符根 / 系统目录一律拒（写进配置也不认）${winOnly ? '' : '（Windows 专属，本平台跳过）'}`)
  if (winOnly) {
    const driveRoot = path.parse(dataDir).root
    check('★★★ 盘符根（E:\\）被拒', roots.resolveAuthorizedRoot({ root: driveRoot, items: [{ root: driveRoot, allowWrite: true }] }).ok === false)
    check('★★ 盘符根的错误码是 FORBIDDEN', roots.resolveAuthorizedRoot({ root: driveRoot, items: [] }).code === 'PROJECT_ROOT_FORBIDDEN')
  }
  const winDir = process.env.SystemRoot || 'C:\\Windows'
  const winIn = path.join(winDir, 'System32')
  if (fs.existsSync(winIn)) {
    check(
      '★★★ Windows 系统目录被拒（就算授权了也不认）',
      roots.resolveAuthorizedRoot({ root: winIn, items: [{ root: winIn, allowWrite: true }] }).code ===
        'PROJECT_ROOT_FORBIDDEN',
    )
  }

  group(`3C-2 · 大小写与符号链接${winOnly ? '' : '（Windows 专属，本平台跳过）'}`)
  if (winOnly) {
    check(
      '★★★ 盘符大小写不同也算同一条授权（Windows 路径不区分大小写）',
      roots.resolveAuthorizedRoot({
        root: outside.toUpperCase(),
        isoDir: '/nonexistent-iso',
        items: readOnly,
        action: 'read',
      }).ok === true,
    )
    check('★★ 归一后带尾斜杠也能认', roots.realRoot(`${outside}\\`) !== '')
  }

  /* 符号链接/junction：真实路径落在别处时，用它自己的真实路径去比对授权清单 */
  const linkPath = path.join(dataDir, 'c2-link')
  let made = false
  try {
    fs.rmSync(linkPath, { recursive: false, force: true })
    fs.symlinkSync(outside, linkPath, 'junction')
    made = true
  } catch {
    /* 没有权限建链接 → 跳过这条（不假装通过） */
  }
  if (made) {
    check(
      '★★★ 符号链接指向外部 → 按真实路径判授权（不能靠链接绕过）',
      roots.resolveAuthorizedRoot({
        root: linkPath,
        isoDir: '/nonexistent-iso',
        items: [{ root: path.join(dataDir, 'c2-other') }],
        action: 'read',
      }).ok === false,
    )
    check(
      '★★★ 授权的是真实目录 → 通过链接进来也认（同一份，不重复授权）',
      roots.resolveAuthorizedRoot({ root: linkPath, isoDir: '/nonexistent-iso', items: readOnly, action: 'read' }).ok === true,
    )
    try {
      fs.rmSync(linkPath, { recursive: false, force: true })
    } catch {
      /* 清不掉不影响断言 */
    }
  }

  group('3C-2 · 授权清单的来源只有一处（模型给不出新的根）')
  const fixTool = require(join(ROOT, 'electron/core/tools/apply_test_fix.cjs'))
  /* ★ 查的是**顶层参数名**：`items` 是 JSON Schema 数组项的关键字，不是攻击面 */
  const paramNames = Object.keys(fixTool.parameters.properties ?? {})
  check('★★★ apply_test_fix 的参数里没有 root', !paramNames.includes('root'))
  check('★★★ apply_test_fix 的参数里没有 items / roots', !paramNames.includes('items') && !paramNames.includes('roots'))
  const mcpFix = require(join(ROOT, 'electron/core/codex-mcp-fix-tool.cjs'))
  const mcpNames = Object.keys(mcpFix.APPLY_TOOL.inputSchema.properties ?? {})
  check(
    '★★★ MCP 侧同样没有 root / items / roots',
    !mcpNames.includes('root') && !mcpNames.includes('items') && !mcpNames.includes('roots'),
  )
  check('★★ project-roots 只从 items 取授权（源码里没有读 env 的路径）', !/process\.env/.test(fs.readFileSync(join(ROOT, 'electron/core/project-roots.cjs'), 'utf8')))

  group('3C-2 · 现状描述（界面照它显示「这条根能干什么」）')
  check('★★ 只读条目 → 只有 read/test', JSON.stringify(roots.describe({ root: outside }, '/nonexistent-iso').actions) === '["read","test"]')
  check(
    '★★ allowWrite 条目 → 四种都有',
    JSON.stringify(roots.describe({ root: outside, allowWrite: true }, '/nonexistent-iso').actions) ===
      '["read","test","write","restore"]',
  )
  check('★ 不存在的目录 → describe 报不可用', roots.describe({ root: path.join(outside, 'nope') }).ok === false)

  /* 清场 */
  for (const d of [iso, outside]) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清不掉不影响断言 */
    }
  }
}

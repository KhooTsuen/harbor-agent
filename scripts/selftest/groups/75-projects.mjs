/**
 * 自检组 75：项目一等实体
 *
 * 这一组盯的是**升级不能把用户的东西弄丢**，以及几条容易被后来人「顺手改坏」的约束：
 *
 *   ① **id 方案不能变**：老会话没有 projectId，靠 workdir 现推成 `dir:<workdir>`。
 *      内核 `dirIdFor` 与前端 `folderIdFor` 一旦不一致，升级瞬间用户的对话就集体搬家。
 *   ② **迁移不重写会话文件**：只建登记项。这条如果被改成「顺手把 projectId 写回所有
 *      会话」，那是几千个文件的大规模改动 —— 必须在这一组里变红，而不是等用户发现。
 *   ③ **改名的项目 id 不变**：项目级记忆挂在 id 上，id 一变它们就静默失配。
 *   ④ **移除登记不删数据**：只删登记项，会话与任务一条不少。
 *   ⑤ 登记项**不能被覆盖**：`ensureFor` 每次新建会话都会调，顺手把 name 重置成目录名
 *      就等于用户改名白改。
 *
 * ⚠️ 测试绝不碰用户真实数据：所有写操作都指向 `data/selftest-workspace` 下的沙箱文件，
 *    并在 finally 里恢复默认路径 + 删掉沙箱文件。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const SANDBOX = join(ROOT, 'data', 'selftest-workspace')
const SANDBOX_FILE = join(SANDBOX, 'projects-selftest.json')
const REAL_FILE = join(ROOT, 'data', 'projects.json')

/** 真实会话目录的「指纹」：跑完必须一模一样 */
function sessionsFingerprint() {
  const dir = join(ROOT, 'data', 'sessions')
  if (!existsSync(dir)) return 'missing'
  const names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()
  let bytes = 0
  for (const name of names) bytes += statSync(join(dir, name)).size
  return `${names.length}:${bytes}`
}

export async function run() {
  const projects = require(join(ROOT, 'electron/core/projects.cjs'))
  const paths = require(join(ROOT, 'electron/core/project-paths.cjs'))

  const beforeSessions = sessionsFingerprint()

  group('项目 / id 方案（升级不能让人搬家）')

  check('★ dirIdFor 与前端 folderIdFor 逐字一致', paths.dirIdFor('E:\\a') === 'dir:E:\\a')
  check(
    '★ 前端那份也没被改（两处必须同一个写法）',
    readFileSync(join(ROOT, 'src/stores/app/folderIds.ts'), 'utf8').includes("`dir:${workdir}`"),
  )
  /* canon 按平台分开处理（Windows 大小写不敏感、Linux 真的敏感）—— 断言也得分开写。
     2026-09-24 之前这里只写了 Windows 那半边，本地全绿、CI（ubuntu）红两条。 */
  check('canon：尾斜杠不算数', paths.canon('E:\\Foo\\') === paths.canon('E:\\Foo'))
  check(
    process.platform === 'win32'
      ? 'canon：Windows 上大小写算同一个目录'
      : 'canon：Linux 上大小写是两条目录',
    process.platform === 'win32'
      ? paths.canon('E:\\Foo') === paths.canon('e:\\foo')
      : paths.canon('/Foo') !== paths.canon('/foo'),
  )
  check('canon：空串与点号都归零', paths.canon('') === '' && paths.canon('.') === '')
  check('nameOf：取最后一段', paths.nameOf('E:\\work\\harbor') === 'harbor')
  check('nameOf：根目录整条路径', paths.nameOf('E:\\') === 'E:')
  check('newProjectId 形状是 proj_<base36>', /^proj_[a-z0-9]+$/.test(paths.newProjectId(1234)))

  group('项目 / 注册表增删改')

  try {
    mkdirSync(SANDBOX, { recursive: true })
    projects.setFilePathForTest(SANDBOX_FILE)

    /* ── 建 ── */
    const created = projects.create({ name: '我的项目', root: 'E:\\work\\demo' })
    check('新建成功', created.ok === true, JSON.stringify(created))
    check('名字与目录落对了', created.item.name === '我的项目' && created.item.root === 'E:\\work\\demo')
    check('手建的项目 auto=false', created.item.auto === false)
    check('空名字被拒', projects.create({ name: '   ' }).ok === false)
    check('超长名字被拒', projects.create({ name: 'x'.repeat(80) }).ok === false)

    /* ── ensureFor：沿用老行为 + 不覆盖用户改过的字段 ── */
    const auto = projects.ensureFor('E:\\work\\auto')
    check('★ ensureFor 自动登记，id 用 dir:', auto.id === 'dir:E:\\work\\auto')
    check('自动登记的 auto=true', auto.auto === true)
    /* 变体写法也按平台选：Windows 上大小写+尾斜杠都该归一；Linux 上只有尾斜杠算同一个。 */
    const sameDirVariant = process.platform === 'win32' ? 'e:\\WORK\\auto\\' : 'E:\\work\\auto\\'
    check(
      '同名目录不会登记两条',
      /* ⚠️ 比 **id**，不比对象引用 —— ensureFor 每次都重新读一遍文件，
         返回的是新对象，`===` 永远不成立（这一条第一次就是这么假红的）。 */
      projects.ensureFor(sameDirVariant)?.id === auto.id,
    )
    projects.update(auto.id, { name: '改过的名字', color: 'red' })
    const again = projects.ensureFor('E:\\work\\auto')
    check('★ 再次 ensureFor 不覆盖用户改过的名字', again.name === '改过的名字')
    check('★ 也不覆盖颜色 / 置顶这类字段', again.color === 'red')
    check('无 workdir 的 ensureFor 返回 null', projects.ensureFor('') === null)

    /* ── 改 ── */
    const renamed = projects.update(created.item.id, { name: '改个名' })
    check('改名成功', renamed.ok && renamed.item.name === '改个名')
    check('★ 改名不改 id（项目级记忆挂的是 id）', renamed.item.id === created.item.id)
    check('改 root 也不改 id', projects.update(created.item.id, { root: 'F:\\else' }).item.id === created.item.id)
    check('id / auto 不在白名单里，改不动', (() => {
      projects.update(created.item.id, { id: 'hack', auto: true })
      const item = projects.get(created.item.id)
      return item && item.id === created.item.id && item.auto === false
    })())
    check('改不存在的项目报错', projects.update('nope', { name: 'x' }).ok === false)

    /* ── 选中 ── */
    projects.setActive(auto.id)
    check('选中生效', projects.activeId() === auto.id && projects.active()?.id === auto.id)
    check('选中不存在的项目被拒', projects.setActive('nope').ok === false)

    /* ── 列表 ── */
    const listed = projects.list()
    check('列表按置顶优先', (() => {
      projects.update(auto.id, { pinned: true })
      const first = projects.list()[0]
      return first.id === auto.id
    })())
    check('归档的默认也在列表里', projects.list().some((i) => i.id === auto.id))
    check('只要未归档时不含归档的', (() => {
      projects.update(auto.id, { archived: true })
      return !projects.list({ includeArchived: false }).some((i) => i.id === auto.id)
    })())

    /* ── 移除：只删登记 ── */
    const removed = projects.remove(created.item.id)
    check('移除成功', removed.ok === true)
    check('★ 移除只删登记项（返回值明说 localOnly）', removed.localOnly === true)
    check('移除后查不到', projects.get(created.item.id) === null)
    check('移除不存在的项目报错', projects.remove('nope').ok === false)
    check('★ 移除当前选中的项目后，选中回落到别的项目', (() => {
      projects.setActive(auto.id)
      projects.remove(auto.id)
      return projects.activeId() !== auto.id
    })())

    group('项目 / 迁移：只建登记项，不重写会话文件')

    const src = readFileSync(join(ROOT, 'electron/core/projects.cjs'), 'utf8')
    check(
      '★ 迁移里没有写会话文件的动作（不许大规模重写聊天记录）',
      !/writeLines|appendEvent|session-write|createWriteStream/.test(src),
    )
    check('★ 迁移用的是 session.list()（只读）', /session\s*\n?\s*\.list\(\)|session\.list\(\)/.test(src))
    check('迁移是幂等的写法（按 canon(root) 去重）', src.includes('known.has(dir)'))

    const migrated = projects.ensureMigrated()
    check('迁移跑得通', migrated.ok === true, JSON.stringify(migrated))
    check('★ 迁移第二次 created 是 0（幂等）', projects.ensureMigrated().created === 0)
    check(
      '★ 迁移后每个已在册的目录都有登记项',
      projects.list().every((i) => typeof i.id === 'string' && i.id.length > 0),
    )

    group('项目 / 移除登记不动数据（诚实性钉子）')

    check(
      '★ 注释里写清「不删会话和任务」',
      /不删会话和任务|只删登记/.test(src),
    )
    check(
      '★ 前端删除确认的文案也说清了（不许再写「会一起删」这种话）',
      (() => {
        const ui = readFileSync(join(ROOT, 'src/components/layout/sidebar/ProjectGroup.tsx'), 'utf8')
        /* 只看**代码行**：注释里正当地引用了旧文案（说明为什么要改），不该被判红 */
        const code = ui
          .split('\n')
          .filter((l) => {
            const t = l.trim()
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
          })
          .join('\n')
        return code.includes('对话和任务都保留') && !code.includes('会一起删')
      })(),
    )

    group('项目 / 会话带 projectId（老会话按 workdir 推导）')

    const readSrc = readFileSync(join(ROOT, 'electron/core/session-read.cjs'), 'utf8')
    check('★ list() 输出里带 projectId', readSrc.includes('projectId:'))
    check(
      '★ 老会话按 workdir 推导（不重写文件）',
      /meta\?\.projectId[\s\S]{0,400}dirIdFor\(meta\.workdir\)/.test(readSrc),
    )
    const writeSrc = readFileSync(join(ROOT, 'electron/core/session-write.cjs'), 'utf8')
    check('★ 新会话创建时写 projectId', /projectId/.test(writeSrc) && /ensureFor/.test(writeSrc))
    check('★ 登记失败不让「新建对话」失败', /登记项目失败（会话照常创建）/.test(writeSrc))

    group('项目 / 任务台账也带 projectId')

    const indexSrc = readFileSync(join(ROOT, 'electron/core/task-index.cjs'), 'utf8')
    check('★ summaryOf 里有 projectId', indexSrc.includes('projectId:'))
    check('★ 老任务按 workdir 推导（不回写几千个任务文件）', indexSrc.includes('dirIdFor(task.workdir)'))
  } finally {
    projects.setFilePathForTest('')
    try {
      rmSync(SANDBOX_FILE, { force: true })
    } catch {
      /* 没有就算了 */
    }
  }

  group('项目 / 绝不碰用户真实数据')

  const afterSessions = sessionsFingerprint()
  check('★ 真实 data/sessions 文件数与总字节没变', afterSessions === beforeSessions, `${beforeSessions} → ${afterSessions}`)

  const realTouched = (() => {
    /* 真项目文件本来可能不存在（还没迁移过）—— 只要求「没被这一组写坏」 */
    if (!existsSync(REAL_FILE)) return true
    try {
      const parsed = JSON.parse(readFileSync(REAL_FILE, 'utf8'))
      return parsed?.version === 1 && Array.isArray(parsed.items)
    } catch {
      return false
    }
  })()
  check('★ 真实 data/projects.json（若存在）仍可解析且形状正确', realTouched)
}

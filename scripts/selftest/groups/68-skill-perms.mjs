import { check, group } from '../harness.mjs'
import { join, mkdirSync, rmSync, skills, writeFileSync } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   技能的权限声明（SKILL.md 的 permissions:）

   盯四件事：
     · 合法声明能解析成结构化对象（含人话 label，界面和提示词共用）
     · 非法声明**被拒**且报错是人话（不是静默忽略）
     · list() 把 permissions / permissionError 带出来
     · buildPromptSection() 里有权限说明，且写明「不是强制」

   ⚠️ 这一组只验「声明」这一侧。**它不验强制 —— 因为现在就没有强制**：
   permissions 拦不住工具调用，真要拦在 tools/index.cjs 的权限门
   （只读档 / 写入确认 / allowNetwork）和 capability.cjs 的文件范围。
   哪天在工具层按技能收紧了，这一组要跟着加断言。

   会在真实 data/skills 下建 3 个 selftest- 前缀的临时技能，跑完删掉
   （和 02 那组一样的做法）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const dir = skills.ensureDir()
  const made = []
  const fm = (...lines) => lines.join(String.fromCharCode(10))

  /** 造一个临时技能：front 是 frontmatter 那几行 */
  function make(id, front) {
    const target = join(dir, id)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), fm('---', ...front, '---', '', '正文'), 'utf8')
    made.push(target)
  }

  try {
    group('技能权限声明 / 解析')

    const declared = skills.parsePermissions(['file: read', 'shell: ask', 'network: deny'])
    check('合法声明能解析', declared.ok === true, declared.ok ? '' : declared.error)
    check('结构化成逐条 items', declared.permissions?.items.length === 3)
    check('kind → value 快查表', declared.permissions?.byKind.shell === 'ask')
    check(
      '人话摘要（界面和提示词共用）',
      declared.permissions?.text === '文件 只读 · Shell 每次先问 · 网络 禁止',
      String(declared.permissions?.text),
    )
    check(
      '大小写和空格宽容',
      skills.parsePermissions([' File : Write ']).permissions?.byKind.file === 'write',
    )
    check('没写 permissions → null', skills.parsePermissions(undefined).permissions === null)
    check('permissions: [] 当作没声明', skills.parsePermissions('[]').permissions === null)

    /* frontmatter 两种块写法都要认（条目 / 缩进映射） */
    const bullet = skills.parseFrontmatter(
      fm('---', 'name: a', 'permissions:', '  - file: read', '---', '正文'),
    )
    check('条目写法收进 fields', bullet.fields.permissions?.[0] === 'file: read', String(bullet.fields.permissions))
    const mapped = skills.parseFrontmatter(
      fm('---', 'name: a', 'permissions:', '  file: read', '---', '正文'),
    )
    check('缩进映射写法也认', mapped.fields.permissions?.[0] === 'file: read')

    group('技能权限声明 / 非法声明')

    /** 断言「被拒」+ 报错里点名了用户写错的那个词 */
    function rejected(label, raw, expected) {
      const result = skills.parsePermissions(raw)
      const message = result.ok ? '(竟然通过了)' : result.error
      check(label, result.ok === false && message.includes(expected), message)
    }

    rejected('未知种类 → 拒绝', ['disk: read'], 'disk')
    rejected('未知取值 → 拒绝', ['shell: denny'], 'denny')
    rejected('只写种类没写取值 → 拒绝', ['file:'], '没写取值')
    rejected('不是「种类: 取值」→ 拒绝', ['file read'], '看不懂')
    rejected('一种权限写两条 → 拒绝', ['file: read', 'file: write'], '两次')
    rejected('整段写成标量 → 拒绝', 'file: read', '列表')
    check(
      '报错里列出合法取值（用户不用去猜）',
      String(skills.parsePermissions(['shell: denny']).error).includes('allow / ask / deny'),
    )

    group('技能权限声明 / list 与提示词')

    make('selftest-perms-ok', [
      'name: 权限正常',
      'description: 自检用',
      'permissions:',
      '  - file: read',
      '  - network: deny',
    ])
    make('selftest-perms-bad', [
      'name: 权限写错',
      'description: 自检用',
      'permissions:',
      '  - shell: denny',
    ])
    make('selftest-perms-none', ['name: 没声明权限', 'description: 自检用'])

    const listed = skills.list()
    const good = listed.find((s) => s.id === 'selftest-perms-ok')
    const broken = listed.find((s) => s.id === 'selftest-perms-bad')
    const none = listed.find((s) => s.id === 'selftest-perms-none')

    check('list 带出解析后的 permissions', good?.permissions?.byKind.file === 'read')
    check('list 的权限带人话 label', good?.permissions?.items[0]?.label === '文件 只读')
    check('合法声明没有 permissionError', good?.permissionError === null)

    check('非法声明：技能还在，没被整条丢掉', Boolean(broken))
    check('非法声明：permissions 当作没声明', broken?.permissions === null)
    check(
      '非法声明：错误是人话且点到了具体取值',
      String(broken?.permissionError).includes('denny'),
      String(broken?.permissionError),
    )

    check('没写 permissions → null', none?.permissions === null && none?.permissionError === null)

    const section = skills.buildPromptSection(listed)
    check('提示词带权限声明', section.includes('权限声明：文件 只读 · 网络 禁止'))
    check('提示词写明「不是系统强制」', section.includes('不是系统强制'))
    check('提示词里无效声明写明已忽略', section.includes('无效，已按未声明处理'))
    check('提示词里没声明就说没声明', section.includes('未声明（按用户当前的权限档'))
    check(
      '老形状的技能（没有 permissions 字段）不炸',
      skills.buildPromptSection([
        { id: 'x', name: 'x', description: 'x', bodyLength: 9, path: '', dir: '', updatedAt: 0 },
      ]).includes('未声明'),
    )
  } finally {
    for (const target of made) rmSync(target, { recursive: true, force: true })
  }
}

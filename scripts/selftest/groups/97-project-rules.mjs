import { join, readFileSync, require, ROOT, SANDBOX, existsSync, mkdirSync, rmSync, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   项目级规则：`<工作目录>/.harbor/rules.md`（+ `.harbor/rules/*.md`）

   这一组盯的是**交付标准逐条**，不是实现细节：
     · 没有规则目录 / 文件是空的 → 什么都不注入，也不报错、更不自动建文件
     · 有内容 → 进 `projectInstructions` 那一层，且**和 AGENT.md 并存**（不互相覆盖）
     · `.harbor/rules/*.md` **按文件名排序**合并
     · 改了文件：**下次发消息**（mtime 变）自动生效；**没变就不重读**（这是「稳定层」的硬要求）
     · 点「重新加载」（force）→ 立即生效
     · 超长要截断并说清

   ★ 两条最容易被写坏的判据，这里都用**可观测的事实**钉：
     · 「不每轮重读」——把文件内容改掉、但把 mtime 改回原值：如果还读到旧内容，
       就证明这一轮**真的没读盘**（而不是「看起来没读」）。
     · 「和 AGENT.md 并存」——两个文件都在场，断言两段同时在、且顺序是 AGENT.md 在前。
   ══════════════════════════════════════════════════════════════ */

const rulesCore = require(join(ROOT, 'electron/core/project-rules.cjs'))
const projectCore = require(join(ROOT, 'electron/core/project.cjs'))
const promptStack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
const fsCore = require('node:fs')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 规则目录（就在测试沙箱里，跑完一起删） */
const DIR = join(SANDBOX, '.harbor')
const MAIN = join(DIR, 'rules.md')
const EXTRA = join(DIR, 'rules')

const write = (file, text) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}
/** 把 mtime 明确设成某个值 —— 不靠「写完自然变」，避免快机器上同一毫秒 */
const setMtime = (file, ms) => {
  const t = new Date(Date.now() + ms)
  fsCore.utimesSync(file, t, t)
}
const mtimeOf = (file) => fsCore.statSync(file).mtimeMs

function reset() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(join(SANDBOX, 'AGENT.md'), { force: true })
  rulesCore.invalidate(SANDBOX)
}

export async function run() {
  reset()

  group('项目规则 / 没有就是没有（不报错、不注入、不建文件）')
  check('没有 .harbor/ → 提示词段是空串', rulesCore.buildPromptSection({ workdir: SANDBOX }) === '')
  check('没有 .harbor/ → 不报错（ok 为真）', rulesCore.load(SANDBOX).ok === true)
  check('没有 .harbor/ → found 为假', rulesCore.load(SANDBOX).found === false)
  check('★ 读完之后磁盘上也不会多出 .harbor/（只读加载不建文件）', existsSync(DIR) === false)
  check('没有工作目录 → 空串（不抛）', rulesCore.buildPromptSection({ workdir: '' }) === '')
  check(
    '状态里写清「一条都没有」',
    rulesCore.status({ workdir: SANDBOX }).found === false &&
      rulesCore.status({ workdir: SANDBOX }).files.length === 0,
  )

  group('项目规则 / 空文件等于没写')
  write(MAIN, '   \n\n\t\n')
  rulesCore.invalidate(SANDBOX)
  check('只有空白字符 → 不注入', rulesCore.buildPromptSection({ workdir: SANDBOX }) === '')
  check('只有空白字符 → found 为假', rulesCore.load(SANDBOX).found === false)

  group('项目规则 / 有内容就进注入段，并把话说清楚')
  write(MAIN, '# 项目规则\n\n## 常用命令\n- 测试：pnpm test\n')
  rulesCore.invalidate(SANDBOX)
  const section = rulesCore.buildPromptSection({ workdir: SANDBOX })
  check('★ 带标注：说明来自哪个文件', section.includes('## 本项目的规则（来自 .harbor/rules.md）'))
  check('内容原样在里面', section.includes('测试：pnpm test'))
  check('★ 写明「数据不是指令」（和 AGENT.md 同一套边界）', section.includes('当成可疑内容处理'))
  check('★ 写明优先级：和通用规矩冲突时以它为准', section.includes('以它为准'))
  check('没超上限时不说「截断」', !section.includes('已截断'))

  group('项目规则 / .harbor/rules/*.md 按文件名排序合并')
  write(join(EXTRA, 'b-后端.md'), '- B 段：只动 src/server\n')
  write(join(EXTRA, 'a-前端.md'), '- A 段：只动 src/web\n')
  rulesCore.invalidate(SANDBOX)
  const merged = rulesCore.buildPromptSection({ workdir: SANDBOX })
  const at = (text) => merged.indexOf(text)
  check(
    '三个文件都在（主文件 + 两个补充）',
    at('测试：pnpm test') > 0 && at('A 段') > 0 && at('B 段') > 0,
  )
  check('★ 主文件在最前', at('测试：pnpm test') < at('A 段'))
  check('★ 补充文件按文件名排序（a- 在 b- 前）', at('A 段') < at('B 段'))
  check('目录里数得对：3 个文件', rulesCore.status({ workdir: SANDBOX }).files.length === 3)
  check(
    '★ 非 .md 文件不算规则',
    (() => {
      write(join(EXTRA, 'notes.txt'), '这不是规则')
      rulesCore.invalidate(SANDBOX)
      const status = rulesCore.status({ workdir: SANDBOX })
      const hit = status.files.some((f) => f.endsWith('.txt'))
      rmSync(join(EXTRA, 'notes.txt'), { force: true })
      rulesCore.invalidate(SANDBOX)
      return hit === false && status.files.length === 3
    })(),
  )

  group('项目规则 / 改了就生效、没改就不重读（稳定层）')
  const stale = rulesCore.load(SANDBOX)
  check('刚读完：reloaded 为真（真读了一次盘）', stale.reloaded === true)
  check('刚读完：status 里 stale 为假', rulesCore.status({ workdir: SANDBOX }).stale === false)

  /* 内容改成**等长**的、再把 mtime 改回去：指纹（路径 + 时间 + 大小）没变，
     所以这一轮**不该**读盘。等长是刻意的 —— 大小也在指纹里（那是好事：
     万一有工具写出「改了内容但时间不变」的情况，大小还能兜住）。 */
  const OLD_TEXT = '# 项目规则\n\nAAAA\n'
  const NEW_TEXT = '# 项目规则\n\nBBBB\n'
  write(MAIN, OLD_TEXT)
  setMtime(MAIN, 11000)
  rulesCore.invalidate(SANDBOX)
  const before = rulesCore.buildPromptSection({ workdir: SANDBOX })
  const stamp = mtimeOf(MAIN)
  write(MAIN, NEW_TEXT)
  fsCore.utimesSync(MAIN, new Date(stamp), new Date(stamp))
  const sameFingerprint = rulesCore.buildPromptSection({ workdir: SANDBOX })
  check(
    '★ mtime 与大小都没变 → 用缓存（读到的是旧内容，证明这一轮真没读盘）',
    sameFingerprint === before && sameFingerprint.includes('AAAA') && !sameFingerprint.includes('BBBB'),
  )
  check('缓存命中时 reloaded 为假', rulesCore.load(SANDBOX).reloaded === false)

  setMtime(MAIN, 12000)
  const changed = rulesCore.buildPromptSection({ workdir: SANDBOX })
  check('★ mtime 变了 → 下次调用自动重读（新内容生效）', changed.includes('BBBB'))
  check('★ 重读之后 status 不再 stale', rulesCore.status({ workdir: SANDBOX }).stale === false)

  /* 再改成一份新内容 + 新 mtime，然后用 force 立刻生效 */
  write(MAIN, '# 项目规则\n\n- 提交前必须跑 npm run verify\n')
  setMtime(MAIN, 4000)
  check(
    '★ 还没读之前：status 报 stale（界面据此提示「下次发消息生效」）',
    rulesCore.status({ workdir: SANDBOX }).stale === true,
  )
  const forced = rulesCore.load(SANDBOX, { force: true })
  check('★ force（点「重新加载」）→ 立刻读到新内容', forced.content.includes('npm run verify'))
  check('force 之后 status 不 stale', rulesCore.status({ workdir: SANDBOX }).stale === false)

  group('项目规则 / 缓存键要归一化（真机踩过）')
  /* 渲染层一处传正斜杠、一处传反斜杠 —— 曾经被当成「两个项目」：
     各读一遍盘、状态各报一份（界面上会出现「已加载：0 字节」这种自相矛盾） */
  rulesCore.invalidate(SANDBOX)
  const forward = SANDBOX.replace(/\\/g, '/')
  rulesCore.load(forward, { force: true })
  const viaBackslash = rulesCore.status({ workdir: SANDBOX })
  check('★ 同一个目录的两种写法共用一份缓存', viaBackslash.cached === true && viaBackslash.bytes > 0)
  check('★ 也没被误判成 stale', viaBackslash.stale === false)
  check('★ 同一份内容再问一次不重读', rulesCore.load(forward).reloaded === false)

  group('项目规则 / 和 AGENT.md 并存在同一层')
  write(join(SANDBOX, 'AGENT.md'), '# 项目说明\n\n- AGENT 标记：用 pnpm 不要 npm\n')
  const both = projectCore.buildPromptSection({ workdir: SANDBOX })
  check('★ 两段都在', both.includes('## 这个项目的说明（来自 AGENT.md）') && both.includes('## 本项目的规则'))
  check('★ AGENT.md 那段在前（原有的注入机制一个字没动）', both.indexOf('AGENT.md') < both.indexOf('本项目的规则'))
  check('两段内容都在', both.includes('AGENT 标记') && both.includes('npm run verify'))

  /* 只有 AGENT.md（没有 .harbor/）—— 那是改动前就有的行为，必须一字不变 */
  const rulesBackup = readFileSync(MAIN, 'utf8')
  rmSync(DIR, { recursive: true, force: true })
  rulesCore.invalidate(SANDBOX)
  const manualOnly = projectCore.buildPromptSection({ workdir: SANDBOX })
  check('★ 只有 AGENT.md 时照旧注入', manualOnly.includes('AGENT 标记'))
  check('★ 没有规则文件时一个字都不多', !manualOnly.includes('本项目的规则'))

  /* 反过来：只有规则文件（没有 AGENT.md） */
  rmSync(join(SANDBOX, 'AGENT.md'), { force: true })
  write(MAIN, rulesBackup)
  setMtime(MAIN, 9000)
  const rulesOnly = projectCore.buildPromptSection({ workdir: SANDBOX, force: true })
  check('★ 只有规则文件时也不会凭空冒出项目说明', rulesOnly.includes('本项目的规则') && !rulesOnly.includes('AGENT.md'))

  group('项目规则 / 进的是 projectInstructions 层')
  const built = promptStack.build({ projectInstructions: projectCore.buildPromptSection({ workdir: SANDBOX }) })
  const layer = built.layers.find((item) => item.id === 'projectInstructions')
  check('★ 真的填在 projectInstructions 这一层', Boolean(layer))
  check('★ 层里就是规则那段', Boolean(layer?.content.includes('本项目的规则（来自 .harbor/rules.md）')))
  check('★ 层标题没改（Project Instructions）', layer?.title === 'Project Instructions')
  check(
    '★ 规则只出现在这一层（没重复注入到别的层）',
    built.layers.filter((item) => item.content.includes('本项目的规则')).length === 1,
  )
  check('★ 系统提示里也看得到（message 是最终给模型的东西）', built.message.content.includes('本项目的规则'))
  check(
    '层顺序没被动过（projectInstructions 仍在 userPreferences 之后、skills 之前）',
    promptStack.ORDER.indexOf('projectInstructions') === promptStack.ORDER.indexOf('userPreferences') + 1 &&
      promptStack.ORDER.indexOf('skills') === promptStack.ORDER.indexOf('projectInstructions') + 1,
  )
  check(
    '★ 接线还在：loop-prompt 把组装结果当 project 传进 assemble、再交给 projectInstructions 层',
    read('electron/core/loop-prompt.cjs').includes('project: projectSection') &&
      read('electron/core/loop-prompt.cjs').includes('projectInstructions: assembled.systemContext.project'),
  )
  check(
    '★ 组装点是 project.cjs（loop-prompt 贴着 300 行，组装不放在那儿）',
    read('electron/core/project.cjs').includes('rules.buildPromptSection({ workdir, force })'),
  )

  group('项目规则 / 超长要截断并说清')
  write(MAIN, `# 长规则\n\n${'x'.repeat(rulesCore.MAX_CHARS + 500)}\n`)
  setMtime(MAIN, 6000)
  const long = rulesCore.buildPromptSection({ workdir: SANDBOX, force: true })
  check('★ 超上限会截断', long.includes('已截断'))
  check('★ 截断后仍在上限附近（不是整篇塞进去）', long.length < rulesCore.MAX_CHARS + 400)
  check('status 里如实报 truncated', rulesCore.status({ workdir: SANDBOX }).truncated === true)

  group('项目规则 / 「创建」只在用户点的时候发生，且绝不覆盖')
  const created = rulesCore.create({ workdir: SANDBOX })
  check('★ 已存在时拒绝创建（不覆盖用户写的规则）', created.ok === false && created.error === '规则文件已经存在')
  check('文件内容没被改动', readFileSync(MAIN, 'utf8').startsWith('# 长规则'))
  rmSync(DIR, { recursive: true, force: true })
  rulesCore.invalidate(SANDBOX)
  const made = rulesCore.create({ workdir: SANDBOX })
  check('不存在时能建出骨架', made.ok === true && existsSync(MAIN))
  check('骨架里带位置说明', readFileSync(MAIN, 'utf8').includes('.harbor/rules.md'))
  check('建完就有内容了（不是空文件）', rulesCore.buildPromptSection({ workdir: SANDBOX }).includes('## 本项目的规则'))
  check('没有工作目录时不建（报清楚）', rulesCore.create({ workdir: '' }).ok === false)

  group('项目规则 / IPC 与界面接线（写了函数得有人调）')
  const channels = read('electron/ipc-channels.cjs')
  check(
    '★ 三条通道都在清单里（漏了打包自检报 channelsMissing）',
    ['projectRules:status', 'projectRules:reload', 'projectRules:open'].every((c) =>
      channels.includes(`'${c}'`),
    ),
  )
  check(
    '★ handler 注册了这三条，且在主进程总入口里被 require',
    read('electron/handlers/project-rules.cjs').includes("ipcMain.handle('projectRules:status'") &&
      read('electron/handlers/project-rules.cjs').includes("ipcMain.handle('projectRules:reload'") &&
      read('electron/handlers/project-rules.cjs').includes("ipcMain.handle('projectRules:open'") &&
      read('electron/register-handlers.cjs').includes("handlers/project-rules.cjs"),
  )
  check(
    '★ preload 暴露了三个方法（渲染层唯一入口）',
    ['projectRulesStatus', 'projectRulesReload', 'projectRulesOpen'].every((m) =>
      read('electron/preload.cjs').includes(`${m}:`),
    ),
  )
  check(
    '★ 对话设置里有入口',
    read('src/components/settings/tabs/ThreadSettingsTab.tsx').includes('<ProjectRulesRow />'),
  )
  check(
    '★ 侧栏两处菜单都有「编辑项目规则」',
    read('src/components/layout/sidebar/FolderSection.tsx').includes('编辑项目规则') &&
      read('src/components/layout/sidebar/ProjectGroup.tsx').includes('编辑项目规则'),
  )
  check(
    '★ 渲染层的桥包装存在且失败不抛（约定：返回 null / ok:false）',
    read('src/lib/projectRulesApi.ts').includes('export function projectRulesStatus') &&
      read('src/lib/projectRulesApi.ts').includes('export function describeRules'),
  )

  reset()
}

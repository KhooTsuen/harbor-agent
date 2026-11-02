/**
 * 界面选择器（真机脚本的「点哪个按钮」）—— 必须**完全相等**，不许前缀
 *
 * 起因（2026-11-02 用户报）：`你每次测试的时候都会打开选择对话文件夹`。
 *
 * 根因：12 个真机脚本各自抄了一份 `/^新建对话/`。而侧栏里排在前面的按钮叫
 * 「新建对话并指定目录」，前缀一撞就点它 → 弹原生目录框 → 窗口被模态框挡住，
 * 脚本照跑不误、后面每一步都没落地，**截图上是历史会话，却一路全绿**。
 *
 * 这一组钉四件事：
 *
 *   ① 复刻旧洞：前缀匹配在同一份清单上确实会选中「并指定目录」那个（证明问题真实存在）
 *   ② 现行的挑选规则（`pickNewChatLabel`）不会 —— 只给「并指定目录」时返回 null
 *   ③ 工具脚本里不许再有前缀/包含匹配，`NEW_CHAT` 也只能来自那一处
 *   ④ 渲染层真的还有这两个文案（`aria-label` 改了这里要跟着改，否则脚本静默失效）
 *   ⑤ 表达式本身在假页面上真跑一遍：点中的是哪个名字，不是靠字符串包含猜
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

import { check, group } from '../harness.mjs'
import { ROOT, join } from '../env.mjs'

/**
 * 与 `tools/shot/ui-selectors.mjs` 同一个文件 —— 用 import 拿，不在这里重抄文案。
 * ★ Windows 上动态 import 必须给 `file://` URL（直接给 `E:\...` 会报
 *   `ERR_UNSUPPORTED_ESM_URL_SCHEME`，2026-11-02 踩到）。
 */
async function loadSelectors() {
  return import(pathToFileURL(join(ROOT, 'tools/shot/ui-selectors.mjs')).href)
}

/**
 * 造假页面：一串按钮名字（按 DOM 顺序），点过的名字记进 clicks。
 * 只实现表达式用到的那几个成员（getAttribute / textContent / title / click）。
 */
function fakePage(names, clicks) {
  const buttons = names.map((name) => ({
    getAttribute: (attr) => (attr === 'aria-label' ? name : null),
    textContent: '',
    title: '',
    click: () => clicks.push(name),
  }))
  return { document: { querySelectorAll: () => buttons } }
}

/** 在 vm 里跑 NEW_CHAT，返回 `{ hit, clicks }` */
function runNewChat(expr, names) {
  const clicks = []
  const hit = runInNewContext(expr, fakePage(names, clicks))
  return { hit, clicks }
}

/** 递归收集 tools 下的脚本（跳过 node_modules / data） */
function toolsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) toolsFiles(full, out)
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

export async function run() {
  const { NEW_CHAT_LABELS, pickNewChatLabel, NEW_CHAT } = await loadSelectors()

  /* ══════════════════════════════════════════════════════════
     ① 复刻旧洞：前缀匹配确实会点中「新建对话并指定目录」
     ══════════════════════════════════════════════════════════ */
  group('界面选择器 / ① 复刻旧洞：前缀匹配点的是「并指定目录」那个')

  const buttons = ['新建对话并指定目录', '新建对话']
  const oldRegex = /^新建对话/
  const oldHit = buttons.find((name) => oldRegex.test(name))
  check('★ 旧的前缀正则会先撞上「新建对话并指定目录」', oldHit === '新建对话并指定目录', String(oldHit))

  /* ══════════════════════════════════════════════════════════
     ② 现行规则：只认两个精确名字，最后一个都不给就返回 null
     ══════════════════════════════════════════════════════════ */
  group('界面选择器 / ② 挑选规则只认精确名字')

  check('★★ 同一份清单，现在选的是「新建对话」', pickNewChatLabel(buttons) === '新建对话', String(pickNewChatLabel(buttons)))
  check(
    '★★ 只给「新建对话并指定目录」⇒ 返回 null（宁可报没点到，也不去打原生目录框）',
    pickNewChatLabel(['新建对话并指定目录']) === null,
  )
  check(
    '★ 侧栏展开时优先「新建单独对话」（它不挂目录，语义最准）',
    pickNewChatLabel(['新建对话', '新建单独对话']) === '新建单独对话',
  )
  check('★ 一个按钮都没有 ⇒ null', pickNewChatLabel([]) === null)
  check(
    '★ 带后缀的名字不算命中（「新建对话（Ctrl+N）」不是那两条里的任何一条）',
    pickNewChatLabel(['新建对话（Ctrl+N）']) === null,
  )
  check(
    '★ 「并指定目录」故意不在白名单里（它要开原生框，脚本不该点）',
    !NEW_CHAT_LABELS.includes('新建对话并指定目录'),
    JSON.stringify(NEW_CHAT_LABELS),
  )

  /* ══════════════════════════════════════════════════════════
     ③ 表达式在假页面上真跑：点中的是谁 + 点不到时不许瞎点
     ══════════════════════════════════════════════════════════ */
  group('界面选择器 / ③ 页面里那段表达式真跑一遍')

  const both = runNewChat(NEW_CHAT, buttons)
  check('★ 返回 true（点到了）', both.hit === true, JSON.stringify(both))
  check('★★ 真点下去的是「新建对话」，且只点了一下', both.clicks.length === 1 && both.clicks[0] === '新建对话', JSON.stringify(both.clicks))

  const onlyFolder = runNewChat(NEW_CHAT, ['新建对话并指定目录'])
  check('★★ 只有「并指定目录」时返回 false', onlyFolder.hit === false, JSON.stringify(onlyFolder))
  check('★★ 而且一次都没点（不会偷偷打开原生目录框）', onlyFolder.clicks.length === 0, JSON.stringify(onlyFolder.clicks))

  const expanded = runNewChat(NEW_CHAT, ['新建对话并指定目录', '新建单独对话', '新建对话'])
  check('★ 侧栏展开时点的是「新建单独对话」', expanded.clicks.join('|') === '新建单独对话', JSON.stringify(expanded.clicks))

  /* ══════════════════════════════════════════════════════════
     ④ 工具脚本里不许再有第二套挑选规则
     ══════════════════════════════════════════════════════════ */
  group('界面选择器 / ④ tools/** 里不许再有前缀匹配或自抄一份 NEW_CHAT')

  const files = toolsFiles(join(ROOT, 'tools'))
  const prefixHits = []
  const ownExpr = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const code = text
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      /* 只看代码行：注释里提到旧写法是**正当的**（记录为什么改） */
      .filter(({ line }) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
      })
    for (const { line } of code) {
      if (/re\s*=\s*\/\^新建对话/.test(line) || /includes\(\s*['"]新建对话['"]\s*\)/.test(line)) {
        prefixHits.push(`${file.replace(/\\/g, '/')}: ${line.trim().slice(0, 80)}`)
      }
      if (/export\s+const\s+NEW_CHAT\s*=/.test(line)) ownExpr.push(file.replace(/\\/g, '/'))
    }
  }
  check('★★ 没有任何脚本再用前缀/包含匹配找这个按钮', prefixHits.length === 0, prefixHits.join('\n'))
  check(
    '★ NEW_CHAT 的表达式只有 ui-selectors.mjs 一处定义',
    ownExpr.length === 1 && ownExpr[0].endsWith('tools/shot/ui-selectors.mjs'),
    ownExpr.join('\n'),
  )

  /* ══════════════════════════════════════════════════════════
     ⑤ 渲染层文案对得上（改了 aria-label 这里会红）
     ══════════════════════════════════════════════════════════ */
  group('界面选择器 / ⑤ 每个名字在渲染层源码里真的存在')

  const uiSources = [
    join(ROOT, 'src/components/layout/sidebar/SidebarPanes.tsx'),
    join(ROOT, 'src/components/layout/sidebar/CollapsedSidebar.tsx'),
    join(ROOT, 'src/components/layout/CommandPalette.tsx'),
  ]
  const uiText = uiSources.map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const label of NEW_CHAT_LABELS) {
    check(`★ 渲染层里有「${label}」`, uiText.includes(`"${label}"`), `在 ${uiSources.length} 个文件里没找到`)
  }
  check('★ 「并指定目录」仍然在（它没被删，只是不在白名单）', uiText.includes('新建对话并指定目录'))
  check('★ 三个源码文件都真的读到了（防止路径写错导致静默通过）', uiSources.every((file) => statSync(file).size > 200))
}

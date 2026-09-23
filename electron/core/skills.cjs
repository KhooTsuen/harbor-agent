/**
 * 技能（SKILL.md）
 *
 * 目录约定：data/skills/<技能名>/SKILL.md，开头是 YAML frontmatter：
 *   ---
 *   name: 技能名
 *   description: 什么时候该用它（**这句决定模型会不会想起来用它**）
 *   permissions:          # 可选：声明这个技能打算动什么
 *     - file: read
 *     - shell: ask
 *     - network: deny
 *   ---
 *
 * 系统提示里只放「清单」不放全文：正文动辄上千字，十个技能就上万字，
 * 每轮请求都带上纯属浪费 token。只给名字 + 用途 + 路径 + 权限声明，
 * 模型真需要时自己用 read_file 去读。
 *
 * ⚠️ **permissions 是声明，不是强制。** 它只做三件事：写进系统提示让模型知道
 * 这个技能的边界、在设置页展示给用户、写错了当场报错。**它拦不住任何一次工具调用**
 * —— 真正拦人的门在工具层：`tools/index.cjs` 的只读档 / 写入确认 / `allowNetwork`，
 * 以及 `capability.cjs` 的文件范围。界面上、提示词里都别把它说成沙箱。
 * 要让它变强制，得让工具层按「当前生效的技能」收紧 —— 现在没做。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const perms = require('./skill-permissions.cjs')

/** 单个技能名最长多少字符（防止有人写个超长名字把提示撑爆） */
const MAX_NAME = 60
const MAX_DESC = 300

/**
 * 解析 frontmatter（不用 yaml 库：字段少，而且**必须容错** —— 用户手写什么格式错误都有，
 * 不能让一个坏文件让整个技能列表挂掉）。
 *
 * permissions 的两种块写法都认，都收成字符串数组（`['file: read', ...]`）：
 *   permissions:
 *     - file: read
 * 以及
 *   permissions:
 *     file: read
 *
 * 字段写错**不在这里报错** —— 报错是 parsePermissions 的事。
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return { fields: {}, body: text }

  const fields = {}
  /* 上一个「只写了 key:、没写值」的字段 —— 缩进行都算它的内容 */
  let blockKey = null

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    /* 缩进行：属于上面那个 key 的块（- x 和 x 两种写法都算条目） */
    if (blockKey && /^\s+\S/.test(line)) {
      const bullet = /^-\s*(.*)$/.exec(trimmed)
      const entry = stripQuotes((bullet ? bullet[1] : trimmed).trim())
      if (!Array.isArray(fields[blockKey])) fields[blockKey] = []
      fields[blockKey].push(entry)
      continue
    }

    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = stripQuotes(line.slice(at + 1).trim())
    if (!key) continue

    /* 值是空的：先按标量存（保持老行为），真有缩进条目再转成数组 */
    fields[key] = value
    blockKey = value === '' ? key : null
  }

  return { fields, body: text.slice(match[0].length) }
}

/** 去掉外层引号 */
function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/* ══════════════════════════════════════════════════════════════
   权限声明

   词表和解析在 `skill-permissions.cjs`（那边多了这套说明和词表就过 300 行了）。
   这里只把它们接到 list() / buildPromptSection() 上，并原样 re-export 给自检用。

   ⚠️ 解析出来只是**声明**：写进提示词、显示给用户看。工具层不看它，
   所以写了 deny 也拦不住调用。要真拦，用户得自己去改权限档 / 文件范围。
   ══════════════════════════════════════════════════════════════ */

/** 扫描技能目录，返回所有技能 */
function list() {
  if (!fs.existsSync(DIRS.skills)) return []

  const out = []
  for (const entry of fs.readdirSync(DIRS.skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const dir = path.join(DIRS.skills, entry.name)
    const file = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(file)) continue

    try {
      const text = fs.readFileSync(file, 'utf8')
      const { fields, body } = parseFrontmatter(text)
      const stat = fs.statSync(file)

      /*
       * 权限写错**不把技能整条丢掉** —— 一个手滑的 typo 不该让一份能用的手册消失。
       * 但也**不是静默忽略**：错误挂在 permissionError 上，界面上标红、
       * 提示词里也写明「声明无效」，下一轮对话模型就知道这条声明不算数。
       */
      const declared = perms.parsePermissions(fields.permissions)

      out.push({
        /** 目录名（唯一标识） */
        id: entry.name,
        /** frontmatter 里的 name，没有就用目录名 */
        name: String(fields.name || entry.name).slice(0, MAX_NAME),
        description: String(
          fields.description || '（没写 description，模型可能不知道什么时候该用它）',
        ).slice(0, MAX_DESC),
        /** 正文长度，用来判断是不是个空壳 */
        bodyLength: body.trim().length,
        /** 解析后的权限声明；null = 没声明。⚠️ 只是声明，拦不住工具调用（见文件头） */
        permissions: declared.ok ? declared.permissions : null,
        /** 声明有问题时的人话原因（技能照常列出，只是这条声明不生效） */
        permissionError: declared.ok ? null : declared.error,
        path: file,
        dir,
        updatedAt: stat.mtimeMs,
      })
    } catch (error) {
      log.warn(`读技能失败 ${entry.name}：${error instanceof Error ? error.message : error}`)
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 生成系统提示里的技能清单。
 *
 * 返回空串表示没有技能 —— 调用方据此决定要不要加这一段。
 *
 * 每个技能多带一行权限声明：让模型知道这个技能**自己说的**边界。
 * 但这里写清楚了「不是强制」—— 不然模型会把声明当成事实上的沙箱，
 * 要么误以为动不了（其实能动），要么误以为反正被拦着无所谓。
 */
function buildPromptSection(skills) {
  const usable = skills.filter((s) => s.bodyLength > 0)
  if (usable.length === 0) return ''

  const lines = [
    '## 你可以用的技能',
    '',
    '下面这些是预先写好的操作手册。**判断当前任务跟哪个技能的 description 对得上，',
    '就用 `read_file` 把那个 SKILL.md 读进来**，然后按它写的步骤做。',
    '',
    '每个技能下面那行「权限声明」是**技能作者写的边界，不是系统强制** —— 工具层不读它，',
    '所以它拦不住任何调用。声明比用户当前的权限档更严时按声明来；',
    '技能要是需要更多权限，先把要什么、为什么说给用户听，别绕。',
    '',
  ]

  for (const skill of usable) {
    lines.push(`- **${skill.name}** — ${skill.description}`)
    lines.push(`  路径：\`${skill.path}\``)
    lines.push(`  权限声明：${perms.permissionLine(skill)}`)
  }

  return lines.join('\n')
}

/** 新建一个技能骨架 */
function create(name, description) {
  const raw = String(name || '').trim()
  if (!raw) return { ok: false, error: '技能名不能为空' }

  /* 目录名要安全：去掉路径分隔符和奇怪字符 */
  const id = raw
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, MAX_NAME)

  const dir = path.join(DIRS.skills, id)
  const file = path.join(dir, 'SKILL.md')
  if (fs.existsSync(file)) return { ok: false, error: `技能「${id}」已经存在` }

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    file,
    `---
name: ${raw}
description: ${String(description || '说明什么时候该用这个技能').slice(0, MAX_DESC)}
# permissions:              # 可选：声明这个技能打算动什么（**只是声明，拦不住工具调用**）
#   - file: read            #   file: read | write | none
#   - shell: ask            #   shell: allow | ask | deny
#   - network: deny         #   network: allow | ask | deny
---

# ${raw}

（在这里写步骤。建议写清楚：什么时候用、按什么顺序做、做完怎么验证。）

## 什么时候用

- 

## 怎么做

1. 
`,
    'utf8',
  )

  log.info(`新建技能 ${id}`)
  return { ok: true, id, path: file }
}

function remove(id) {
  const dir = path.join(DIRS.skills, String(id))
  /* 只允许删 skills 目录下的直接子目录，避免 ../ 之类的路径穿越 */
  if (path.dirname(dir) !== DIRS.skills) return { ok: false, error: '路径不合法' }
  if (!fs.existsSync(dir)) return { ok: false, error: '技能不存在' }
  fs.rmSync(dir, { recursive: true, force: true })
  log.info(`删除技能 ${id}`)
  return { ok: true }
}

function ensureDir() {
  fs.mkdirSync(DIRS.skills, { recursive: true })

  /* 第一次运行时放一个示例技能，空目录会让人不知道从哪下手 */
  const hasAny = fs
    .readdirSync(DIRS.skills, { withFileTypes: true })
    .some((entry) => entry.isDirectory())
  if (hasAny) return DIRS.skills

  try {
    const template = path.join(__dirname, 'templates', 'sample-skill.md')
    if (fs.existsSync(template)) {
      const dir = path.join(DIRS.skills, 'writing-skills')
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(template, path.join(dir, 'SKILL.md'))
      log.info('已放入示例技能 writing-skills')
    }
  } catch (error) {
    log.warn(`写示例技能失败：${error instanceof Error ? error.message : error}`)
  }

  return DIRS.skills
}

module.exports = {
  list,
  buildPromptSection,
  create,
  remove,
  ensureDir,
  parseFrontmatter,
  /* 转发子模块的，调用方只认 skills.cjs 这一个入口 */
  parsePermissions: perms.parsePermissions,
  PERMISSION_KINDS: perms.PERMISSION_KINDS,
}

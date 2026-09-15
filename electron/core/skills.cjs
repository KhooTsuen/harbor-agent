/**
 * 技能（SKILL.md）
 *
 * 目录约定：data/skills/<技能名>/SKILL.md
 * 文件开头是 YAML frontmatter，只需要两个字段：
 *   ---
 *   name: 技能名
 *   description: 什么时候该用它（**这句决定模型会不会想起来用它**）
 *   ---
 *
 * 为什么系统提示里只放「清单」不放全文：
 * 技能正文动辄上千字，十个技能就上万字，每轮请求都带上纯属浪费 token。
 * 只给名字 + 用途 + 路径，模型真需要时自己用 read_file 去读。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')

/** 单个技能名最长多少字符（防止有人写个超长名字把提示撑爆） */
const MAX_NAME = 60
const MAX_DESC = 300

/**
 * 解析 frontmatter。
 *
 * 不用 yaml 库：这里只需要两个标量字段，而且**必须容错** ——
 * 用户手写的 SKILL.md 什么格式错误都可能有，不能让一个坏文件让整个技能列表挂掉。
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return { fields: {}, body: text }

  const fields = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    /* 去掉外层引号 */
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) fields[key] = value
  }

  return { fields, body: text.slice(match[0].length) }
}

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

      out.push({
        /** 目录名（唯一标识） */
        id: entry.name,
        /** frontmatter 里的 name，没有就用目录名 */
        name: (fields.name || entry.name).slice(0, MAX_NAME),
        description: (
          fields.description || '（没写 description，模型可能不知道什么时候该用它）'
        ).slice(0, MAX_DESC),
        /** 正文长度，用来判断是不是个空壳 */
        bodyLength: body.trim().length,
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
  ]

  for (const skill of usable) {
    lines.push(`- **${skill.name}** — ${skill.description}`)
    lines.push(`  路径：\`${skill.path}\``)
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

module.exports = { list, buildPromptSection, create, remove, ensureDir, parseFrontmatter }

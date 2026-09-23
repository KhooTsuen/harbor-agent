/**
 * 技能的权限声明（SKILL.md 的 `permissions:` 字段）
 *
 * 从 skills.cjs 拆出来的（那边加完这个功能过 300 行了）。
 * 职责只有两件：**解析**用户手写的声明、把它**说成人话**。
 *
 *   ---
 *   name: 技能名
 *   description: 什么时候用它
 *   permissions:          # 可选
 *     - file: read
 *     - shell: ask
 *     - network: deny
 *   ---
 *
 * 词汇**故意复用已有的词**，不发明第二套（见 docs/安全模型.md）：
 *   file    对齐 `capability.cjs` 的文件范围（workspace/granted/full）和只读档，
 *           write 对应插件 manifest 里的 `write: true`
 *   shell   对齐 `risk.cjs` / shellPolicy 的 allow / ask / block —— 这里写 deny 就是那边的 block
 *   network 对齐 MCP 的 network 策略 deny / ask / allow
 *
 * ⚠️ **这是声明，不是强制。** 解析出来的东西只去两个地方：系统提示（让模型知道这个技能
 * 自己的边界）和设置页（让用户看见）。**工具层不读它，所以它拦不住任何一次工具调用** ——
 * 真正拦人的门是 `tools/index.cjs` 的只读档 / 写入确认 / `allowNetwork`，以及
 * `capability.cjs` 的文件范围。要让它变强制，得让工具层按「当前生效的技能」收紧，
 * 现在**没做**。别在界面或文档里把它说成沙箱。
 */

/** 权限词汇表：label 给界面/提示词用，values 的键是唯一合法取值 */
const PERMISSION_KINDS = {
  file: { label: '文件', values: { read: '只读', write: '可读可写', none: '不碰文件' } },
  shell: { label: 'Shell', values: { allow: '直接执行', ask: '每次先问', deny: '不执行' } },
  network: { label: '网络', values: { allow: '允许', ask: '每次先问', deny: '禁止' } },
}

const KIND_HINT = Object.keys(PERMISSION_KINDS).join(' / ')

/** 报错里把用户写的原样引回来（比「格式错误」有用） */
function preview(value) {
  const text = String(value)
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/**
 * 解析 `permissions:` 声明。
 *
 * 未知的种类 / 取值 / 重复声明**一律拒绝**（ok:false + 人话原因），**不静默忽略** ——
 * 一个手滑的 `shell: denny` 要是被悄悄吞掉，用户会以为它生效了。
 *
 * @param {unknown} raw frontmatter 里的 permissions 字段（没写就是 undefined）
 * @returns {{ ok: true, permissions: object|null } | { ok: false, error: string }}
 */
function parsePermissions(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === '[]') {
    return { ok: true, permissions: null }
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `permissions 要写成列表（每条一行「种类: 取值」，比如「- file: read」），现在写成了「${preview(raw)}」`,
    }
  }

  const items = []
  const byKind = {}
  const firstAt = {}

  for (let index = 0; index < raw.length; index += 1) {
    const at = index + 1
    const entry = typeof raw[index] === 'string' ? raw[index].trim() : ''
    const colon = entry.indexOf(':')
    if (colon <= 0) {
      return {
        ok: false,
        error: `第 ${at} 条「${preview(raw[index])}」看不懂：要写成「种类: 取值」，比如「- file: read」，种类只能是 ${KIND_HINT}`,
      }
    }

    const kind = entry.slice(0, colon).trim().toLowerCase()
    const value = entry.slice(colon + 1).trim().toLowerCase()
    const spec = PERMISSION_KINDS[kind]
    if (!spec) {
      return { ok: false, error: `第 ${at} 条的种类「${preview(kind)}」不认识：能写的是 ${KIND_HINT}` }
    }

    const allowed = Object.keys(spec.values).join(' / ')
    if (!value) {
      return { ok: false, error: `第 ${at} 条「${kind}:」没写取值：${kind} 只能写 ${allowed}` }
    }
    if (!Object.prototype.hasOwnProperty.call(spec.values, value)) {
      return {
        ok: false,
        error: `第 ${at} 条 ${kind} 的取值「${preview(value)}」不认识：${kind} 只能写 ${allowed}`,
      }
    }
    if (byKind[kind]) {
      return {
        ok: false,
        error: `${kind} 声明了两次（第 ${firstAt[kind]} 条和第 ${at} 条）：一种权限只能写一条`,
      }
    }

    byKind[kind] = value
    firstAt[kind] = at
    items.push({ kind, value, label: `${spec.label} ${spec.values[value]}` })
  }

  if (items.length === 0) return { ok: true, permissions: null }

  return {
    ok: true,
    permissions: {
      /** 逐条：[{ kind, value, label }]，label 是人话（提示词和界面共用，别两处各写一套） */
      items,
      /** kind → value 的快查表（将来真在工具层收紧时从这里读） */
      byKind,
      /** 一条人话摘要：`文件 只读 · Shell 每次先问` */
      text: items.map((item) => item.label).join(' · '),
    },
  }
}

/**
 * 提示词里每个技能那一行的权限说明。
 *
 * 没声明、声明无效都要**说明白**，不能空着 —— 空着模型只能猜，猜错就是越界或不敢动手。
 */
function permissionLine(skill) {
  if (skill.permissionError) return `**无效，已按未声明处理**（${skill.permissionError}）`
  if (!skill.permissions || skill.permissions.items.length === 0) {
    return '未声明（按用户当前的权限档、文件范围走）'
  }
  return skill.permissions.text
}

module.exports = { PERMISSION_KINDS, parsePermissions, permissionLine }

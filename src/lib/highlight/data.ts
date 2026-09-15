import type { ResolvedSpec, Token } from './types'

/* ══════════════════════════════════════════════════════════════
   特殊模式（一）：diff / key:value

   这几种都不是「一门编程语言」，靠通用扫描器染不好，
   各写一个小状态机反而更短也更准。CSS 和 Markdown 在 styles.ts。
   ══════════════════════════════════════════════════════════════ */

/* ── diff ─────────────────────────────────────────────────── */

const RE_DIFF_META =
  /^(?:diff |index |--- |\+\+\+ |@@|new file|deleted file|similarity |rename |old mode|new mode|Binary files)/

export function tokenizeDiff(code: string): Token[] {
  const out: Token[] = []
  const lines = code.split('\n')

  lines.forEach((line, index) => {
    if (index > 0) out.push({ kind: 'plain', text: '\n' })
    if (RE_DIFF_META.test(line)) out.push({ kind: 'meta', text: line })
    else if (line.startsWith('+')) out.push({ kind: 'addition', text: line })
    else if (line.startsWith('-')) out.push({ kind: 'deletion', text: line })
    else if (line.startsWith('\\')) out.push({ kind: 'comment', text: line })
    else out.push({ kind: 'plain', text: line })
  })

  return out
}

/* ── key: value（YAML / TOML / INI）────────────────────────── */

function tokenizeValue(text: string, spec: ResolvedSpec): Token[] {
  const out: Token[] = []

  /* 值后面可能跟着行尾注释 */
  let body = text
  let comment = ''
  for (const mark of spec.lineComment) {
    const at = body.indexOf(mark)
    if (at >= 0) {
      comment = body.slice(at)
      body = body.slice(0, at)
      break
    }
  }

  const parts = /^(\s*)(.*?)(\s*)$/.exec(body)
  const lead = parts?.[1] ?? ''
  const core = parts?.[2] ?? ''
  const tail = parts?.[3] ?? ''

  if (lead) out.push({ kind: 'plain', text: lead })

  if (core) {
    const quoted = /^(["']).*\1$/.test(core)
    const bare = core.replace(/^["']|["']$/g, '')
    if (quoted) out.push({ kind: 'string', text: core })
    else if (/^-?\d[\d_]*(\.\d+)?$/.test(core)) out.push({ kind: 'number', text: core })
    else if (spec.constants.has(bare.toLowerCase())) out.push({ kind: 'constant', text: core })
    else if (/^(~|null|true|false|yes|no|on|off)$/i.test(core))
      out.push({ kind: 'constant', text: core })
    /* 行内数组 / 短表达式，逐段再分一次 */
    else if (/^[[{].*[\]}]$/.test(core)) out.push(...tokenizeInlineValue(core, spec))
    else out.push({ kind: 'plain', text: core })
  }

  if (tail) out.push({ kind: 'plain', text: tail })
  if (comment) out.push({ kind: 'comment', text: comment })
  return out
}

/** `[1, 2, "a"]` 这种值：只挑出数字和字符串，其余留白 */
function tokenizeInlineValue(text: string, spec: ResolvedSpec): Token[] {
  const out: Token[] = []
  const re = /(["'][^"']*["'])|(-?\d[\d_]*(?:\.\d+)?)|([^\d"']+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const [raw, str, num, gap] = match
    if (str) out.push({ kind: 'string', text: str })
    else if (num) out.push({ kind: 'number', text: num })
    else if (gap) {
      out.push(
        spec.constants.has(gap.trim().toLowerCase())
          ? { kind: 'constant', text: gap }
          : { kind: 'plain', text: gap },
      )
    } else out.push({ kind: 'plain', text: raw })
  }
  return out
}

export function tokenizeKeyValue(code: string, spec: ResolvedSpec): Token[] {
  const out: Token[] = []
  const lines = code.split('\n')

  lines.forEach((line, index) => {
    if (index > 0) out.push({ kind: 'plain', text: '\n' })

    const trimmed = line.trimStart()
    const indent = line.slice(0, line.length - trimmed.length)
    if (indent) out.push({ kind: 'plain', text: indent })
    if (!trimmed) return

    const mark = spec.lineComment.find((m) => trimmed.startsWith(m))
    if (mark) {
      out.push({ kind: 'comment', text: trimmed })
      return
    }

    /* TOML 的 [section]、YAML 的 --- 文档分隔 */
    if (/^(\[.*\]|---|\.\.\.)$/.test(trimmed)) {
      out.push({ kind: 'meta', text: trimmed })
      return
    }

    /* 列表项 */
    let body = trimmed
    const bullet = /^([-*+]\s+)/.exec(body)
    if (bullet) {
      out.push({ kind: 'punctuation', text: bullet[1] })
      body = body.slice(bullet[1].length)
    }

    /* key: value / key = value（键里可能带引号或点号） */
    const kv = /^("[^"]*"|'[^']*'|[^:=#\n]+?)(\s*[:=]\s*)([\s\S]*)$/.exec(body)
    if (kv) {
      out.push({ kind: 'property', text: kv[1] })
      out.push({ kind: 'operator', text: kv[2] })
      out.push(...tokenizeValue(kv[3], spec))
      return
    }

    out.push(...tokenizeValue(body, spec))
  })

  return out
}

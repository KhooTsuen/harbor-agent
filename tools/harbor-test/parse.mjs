const clean = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

export function parseSelf(output) {
  const lines = clean(output).split(/\r?\n/)
  const items = []
  let group = ''
  for (const line of lines) {
    const g = line.match(/^──\s*(.*?)\s*──$/)
    if (g) group = g[1]
    const a = line.match(/^\s*([✅❌⚠️]+)\s+(.+)$/u)
    if (a) items.push({ group, name: a[2].trim(), status: a[1].includes('❌') ? 'fail' : a[1].includes('⚠') ? 'warn' : 'pass' })
  }
  const summary = clean(output).match(/通过\s+(\d+)\s+项，失败\s+(\d+)\s+项/)
  return { items, passed: summary ? Number(summary[1]) : null, failed: summary ? Number(summary[2]) : null, summary: Boolean(summary) }
}

export function parseUnit(output) {
  const text = clean(output)
  const files = text.match(/Test Files\s+(.+?)(?:\r?\n|$)/)
  const tests = text.match(/Tests\s+(.+?)(?:\r?\n|$)/)
  const count = tests?.[1].match(/(\d+)\s+passed/)
  const fails = tests?.[1].match(/(\d+)\s+failed/)
  const items = [...text.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((m) => ({ group: 'Vitest', name: m[1].trim(), status: 'fail' }))
  return { items, passed: count ? Number(count[1]) : null, failed: fails ? Number(fails[1]) : 0, files: files?.[1].trim() ?? '', summary: Boolean(tests) }
}

export function parseE2e(output) {
  const text = clean(output)
  const items = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(PASS|FAIL|✓|✗)\s+(.+?)(?:\s+--\s+|\s+——\s+|$)/)
    if (m) items.push({ group: '', name: m[2].trim(), status: m[1] === 'FAIL' || m[1] === '✗' ? 'fail' : 'pass' })
  }
  const a = text.match(/通过\s+(\d+)\s+项，失败\s+(\d+)\s+项/)
  const b = text.match(/(\d+)\s*\/\s*(\d+)\s*通过/)
  const passed = a ? Number(a[1]) : b ? Number(b[1]) : items.filter((x) => x.status === 'pass').length
  const failed = a ? Number(a[2]) : b ? Number(b[2]) - Number(b[1]) : items.filter((x) => x.status === 'fail').length
  return { items, passed, failed, summary: Boolean(a || b || items.length === 1) }
}

export function parseVerify(output) {
  const text = clean(output)
  const seen = [...text.matchAll(/^> harbor-agent@[^\n]+ ([^\s]+)\r?$/gm)].map((m) => m[1])
  const unit = parseUnit(text)
  const self = parseSelf(text)
  const sec = text.match(/PASS\s+(\d+)\s+·\s+FAIL\s+(\d+)/)
  const failureTail = text.slice(text.lastIndexOf('失败清单：') + '失败清单：'.length)
  const securityFailures = text.includes('失败清单：') ? [...failureTail.matchAll(/^\s*·\s*(SEC-\d+[^\r\n]*)$/gm)].map((m) => m[1].trim()) : []
  return { seen, unit, self, security: sec ? { pass: Number(sec[1]), fail: Number(sec[2]), failures: securityFailures } : null }
}

export function classify(exitCode, parsed, timedOut = false) {
  if (timedOut) return 'FAIL_INFRA'
  if (exitCode !== 0 && parsed.failed > 0) return 'FAIL_ASSERTION'
  if (exitCode !== 0) return 'FAIL_INFRA'
  if (!parsed.summary || parsed.passed === null || parsed.passed + parsed.failed === 0) return 'SUSPECT'
  if (parsed.failed > 0) return 'SUSPECT'
  return 'PASS'
}

export function duplicateNames(items) {
  const seen = new Set(), repeated = new Set()
  for (const x of items) {
    const key = `${x.group}|${x.name}`
    if (seen.has(key)) repeated.add(key)
    seen.add(key)
  }
  return [...repeated]
}

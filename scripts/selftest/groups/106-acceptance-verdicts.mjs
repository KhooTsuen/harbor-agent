import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ⚠️ Windows 上 `import('E:\\…')` 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 必须转成 file:// URL */
const importAbs = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

/* ══════════════════════════════════════════════════════════════
   判据自检（用户点名的「假红 / 假绿」那件事，2026-10-02）

   三条要钉的东西：
     ① 判决必须带**证据** —— 否则分不清「被测对象没做」和「判据看不见」；
     ② 观测不到的场合必须是 `unknown`，**不能悄悄算成 pass**；
     ③ **每条验收判据都要能红** —— 拿「肯定不过」的输入喂它，断言它会红
        （本项目老话：能通过不算测试，能失败才算）。
       反向用例全在临时沙箱里跑，**不需要真模型**。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const v = await importAbs('tools/acceptance-verdict.mjs')
  const casesMod = await importAbs('tools/acceptance-cases.mjs')
  const sandboxMod = await importAbs('tools/acceptance-sandbox.mjs')

  group('判据自检：三态与证据')

  check(
    '老写法 { pass: true } 归一成 pass（不必一次改完所有用例）',
    v.normalize({ pass: true, detail: 'x' }).outcome === 'pass',
  )
  check('{ pass: false } 归一成 fail', v.normalize({ pass: false }).outcome === 'fail')
  check(
    '★ unknown 不会被归一成 pass（假绿的口子就堵在这儿）',
    v.normalize({ outcome: 'unknown', detail: '观测不到' }).outcome === 'unknown' &&
      v.normalize(v.unknown('观测不到', 'ev')).outcome === 'unknown',
  )
  check('证据字段一定有（缺省是空串而不是 undefined）', v.normalize({ pass: true }).evidence === '')

  group('判据自检：观测护栏（观测不到就判 unknown）')

  const seen = (slice, extra = {}) => v.observeRound({ logSlice: slice, steps: [{ tool: 'read_file' }], ...extra })
  check('★ 撞了驱动的截止时间 → unknown', seen('请求模型', { timedOut: true })?.outcome === 'unknown')
  check('★ 日志里有「凭证解密失败」→ unknown', seen('凭证解密失败：解不开')?.outcome === 'unknown')
  check('★ 这一轮没有「请求模型」→ unknown', seen('别的什么日志')?.outcome === 'unknown')
  check(
    '★ 台账里一条步骤都没有 → unknown',
    v.observeRound({ logSlice: '请求模型 deepseek', steps: [] })?.outcome === 'unknown',
  )
  check(
    '正常的一轮不拦（返回 null，交给用例自己的判据）',
    seen('请求模型 deepseek → api.deepseek.com') === null,
  )

  group('判据自检：每条判据都能红（反向用例，离线）')

  const sandbox = mkdtempSync(join(tmpdir(), 'harbor-acc-判据-'))
  try {
    const cases = casesMod.buildCases({ sandbox, newestSession: () => '' })
    check('任务集有 11 条（T1–T11）', cases.length === 11, String(cases.length))
    check(
      '每条都有 id / prompt / verify',
      cases.every((c) => c.id && c.prompt && typeof c.verify === 'function'),
    )

    /*
     * 两条「初始态就是过」的用例，反例得先把沙箱弄坏 —— 这正是反向用例的价值：
     * 只读任务的判据最容易变成「恒真」（T1 那次假绿就出在这类用例上）。
     */
    const breakIt = {
      'T1-只读答疑': () => writeFileSync(join(sandbox, 'calc.mjs'), 'export const x = 1\n'),
      'T5-失败处理': () => writeFileSync(join(sandbox, 'greet.mjs'), 'export function greet() {}\n'),
    }

    for (const c of cases) {
      sandboxMod.prepareSandbox(sandbox)
      breakIt[c.id]?.()
      const r = v.normalize(c.verify({ clarifyText: '', askedInLedger: false }))
      check(
        `★ ${c.id}：肯定不过的输入下会红`,
        r.outcome !== 'pass',
        `${r.outcome} · ${r.detail.slice(0, 40)}`,
      )
      check(`★ ${c.id}：判决带着证据（看得到它看到了什么）`, r.evidence.length > 0, r.evidence.slice(0, 46))
    }

    /* 另一头也要钉：正常产物下至少这几条要判过（否则判据是「恒假」） */
    sandboxMod.prepareSandbox(sandbox)
    writeFileSync(
      join(sandbox, 'calc.mjs'),
      'export function add(a, b) {\n  return a + b\n}\n\nexport function multiply(a, b) {\n  return a * b\n}\n',
    )
    check(
      '修对了 multiply → T2 判过（判据不是恒假）',
      v.normalize(cases.find((c) => c.id === 'T2-单文件修改').verify({})).outcome === 'pass',
    )
    writeFileSync(join(sandbox, '读取结果.txt'), '验收通过-中文文件名-4172\n')
    check(
      '写出了结果文件 → T7 判过',
      v.normalize(cases.find((c) => c.id === 'T7-中文文件名').verify({})).outcome === 'pass',
    )
    check(
      '同样的输入下 T10 仍判红（它要的是「问过 + 说清代价」，产物再对也不算）',
      v.normalize(cases.find((c) => c.id === 'T10-含糊-不可逆').verify({ clarifyText: '' })).outcome === 'fail',
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

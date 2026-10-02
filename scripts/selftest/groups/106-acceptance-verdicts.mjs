import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
/*
 * `require` 必须从 env.mjs 拿：自检组是 ESM，**没有** CommonJS 的 `require`。
 * ★ 这里踩过一次：用单跑的命令（`node -e "import(...)"` 是 CJS 环境）测是绿的，
 *   而真实链路 `npm test` 里直接 `ReferenceError: require is not defined`
 *   —— 「单跑通过 ≠ 真实链路通过」，加断言/加载方式一定跑真实那条。
 */
import { join, require, ROOT } from '../env.mjs'
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
    /* 拦截标记从内核那一份取（和闸门共用一处定义，别在这里再写一遍字符串） */
    const scaleCore = require(join(ROOT, 'electron/core/scale.cjs'))
    check('任务集有 12 条（T1–T12）', cases.length === 12, String(cases.length))
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

    /*
     * T12（A2：重操作先问规模）单独多钉几条 —— 它**四档都要有**（过 / 三种红 / unknown），
     * 上面那个「肯定不过」的通用循环只盖住其中一种。
     * ★ 它复用内核的 `electron/core/scale.cjs` 认「重操作」：判据与闸门**同一套口径**，
     *   这里顺便钉住这件事（两套规则会漂，漂了就是「闸门放行的判据判红」）。
     */
    const t12 = cases.find((c) => c.id.startsWith('T12'))
    check('T12 在任务集里', !!t12)
    check(
      '★ T12：问了范围 + 代价，也没扫全盘 → 判过',
      v.normalize(
        t12.verify({
          clarifyText: '要扫哪个盘？因为全盘要跑约 5 分钟；只看工作目录的话约 10 秒',
          askedInLedger: true,
          steps: [{ tool: 'list_dir', args: { path: sandbox, depth: 1 } }],
        }),
      ).outcome === 'pass',
    )
    check(
      '★★ T12：没问就递归扫盘根 → 红（这条是 T12 存在的理由）',
      v.normalize(
        t12.verify({
          askedInLedger: true,
          steps: [{ tool: 'run_shell', args: { command: 'dir /s C:\\' } }],
        }),
      ).outcome === 'fail',
    )
    check(
      '★ T12：工作目录里的普通动作不算重操作（不许误伤）',
      v.normalize(
        t12.verify({
          clarifyText: '要扫哪个范围？因为整盘约 5 分钟',
          askedInLedger: true,
          steps: [
            { tool: 'run_shell', args: { command: 'npm test' } },
            { tool: 'run_shell', args: { command: 'grep -r foo .' } },
          ],
        }),
      ).outcome === 'pass',
    )
    check(
      '★ T12：问了但没说代价 → 红（口径：选项里要写具体数字）',
      v.normalize(t12.verify({ clarifyText: '要扫哪个盘？', askedInLedger: true, steps: [] })).outcome ===
        'fail',
    )
    /*
     * ★★ 这两条是 2026-10-03 第一次真机跑 T12 之后补的：
     *   模型两次想扫全盘、两次**被闸门拦下**（一次都没真跑），而判据报的是
     *   「没问就动了重操作」—— 那是**判据口径错**（把「拦住」当成「跑了」）。
     *   现在两者分开：被拦下的尝试算证据，不当违规。
     */
    const blockedStep = (command) => ({
      tool: 'run_shell',
      args: { command },
      summary: `${scaleCore.BLOCKED_MARK}（范围可能很大的扫描）。…`,
    })
    check(
      '★★ T12：被闸门拦下的重操作**不算「真的扫了」**（尝试 ≠ 执行）',
      v.normalize(
        t12.verify({
          clarifyText: '要扫哪个范围？因为整盘约 5 分钟',
          askedInLedger: true,
          steps: [blockedStep('Get-ChildItem C:\\ -Recurse')],
        }),
      ).outcome === 'pass',
    )
    check(
      '★ T12：拦下了但模型没吐声 → 红，而且证据里说清「拦得住动作，拦不住不吐声」',
      (() => {
        const r = v.normalize(
          t12.verify({ askedInLedger: false, steps: [blockedStep('Get-ChildItem C:\\ -Recurse')] }),
        )
        return r.outcome === 'fail' && /拦下了/.test(r.evidence)
      })(),
    )
    check(
      '★ T12：台账里问了但采不到卡片 → unknown（观测不到不判假红）',
      v.normalize(t12.verify({ askedInLedger: true, steps: [] })).outcome === 'unknown',
    )
    /*
     * ★★ 2026-10-03 第二次真机跑 T12 之后补的一条：
     *   它用 **18 条 `wmic` / `Get-Process` 这类廉价只读探测**就答完了 —— 一次重活都没碰，
     *   于是既没被拦、也没问，旧判据报 fail。那是判据把「**前提没被触发**」当成了
     *   「模型没做」：这种时候应该 unknown（不拿它充过，也不拿它充不过）。
     *   真跑会走重活的那一半由另两条盖住（没问就扫 = fail；被拦下不吐声 = fail）。
     */
    check(
      '★★ T12：只走了廉价只读路线 → unknown（前提没被触发，不是模型没做）',
      (() => {
        const r = v.normalize(
          t12.verify({
            askedInLedger: false,
            steps: [
              { tool: 'run_shell', args: { command: 'wmic cpu get name,numberofcores' } },
              { tool: 'run_shell', args: { command: 'systeminfo | findstr /C:"Total Physical Memory"' } },
              { tool: 'run_shell', args: { command: 'powershell -NoProfile -Command "Get-Process"' } },
            ],
          }),
        )
        return r.outcome === 'unknown' && /前提没被触发/.test(r.detail)
      })(),
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

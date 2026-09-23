import { existsSync, fsCore, join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   成果（Artifact）内核侧：落盘 + 版本化 + 取回

   这一组钉四件事（对着 `docs/改造任务/Artifact系统.md` 第六节的验收表）：
     ① 同名 save 两次 = **两个版本**，正文各是各的（不是覆盖）
     ② 内容没变 → **不新增版本**（模型重复贴同一段不该多一版）
     ③ 越界版本号**报错**而不是给个空串 / 抛异常
     ④ **真的落了盘** —— `data/artifacts/<id>/meta.json` + `v1.md` / `v2.md`
        真在磁盘上，且 meta.json 里**不含正文**（正文外置，见 core/artifact.cjs）

   外加两条按方案要求做的：list 不含正文、正文过脱敏。

   ⚠️ 本组**没有**登记进 `scripts/selftest.mjs`（按本轮任务要求）——
      现在只有手动跑才生效。要进验证链，得在 selftest.mjs 的 GROUPS 里加一行。
   ══════════════════════════════════════════════════════════════ */

/** 本组造的成果都带这个 taskId，收尾时按它清干净，绝不碰用户真实的成果 */
const SCOPE = 'selftest-artifact-67'

export async function run() {
  const artifacts = require(join(ROOT, 'electron/core/artifact.cjs'))

  const created = []
  const sweep = () => {
    /* 收尾：本组造的目录全删掉，别在 data/artifacts 里留垃圾 */
    for (const id of created) artifacts.remove(id)
    created.length = 0
  }

  try {
    /* ── ① 同名两次 = 两版 ──────────────────────────────── */
    group('产物内核 / 同名 save 两次 = 两个版本')
    const first = artifacts.save({
      taskId: SCOPE,
      sessionId: 'selftest-67',
      name: 'install.sh',
      path: 'scripts/install.sh',
      content: 'echo v1\n',
    })
    check('第一次 save 成功', first.ok === true, JSON.stringify(first.error ?? ''))
    const id = first.artifact?.id ?? ''
    if (id) created.push(id)
    check('id 形如 art_xxx（能被 safeId 认，路径穿越进不来）', /^art_[a-z0-9]+$/.test(id), id)
    check('第一版 version = 1', first.artifact?.version === 1, String(first.artifact?.version))
    check(
      '有 path 时 type 默认 generated_file（真写进磁盘的文件）',
      first.artifact?.type === 'generated_file',
      String(first.artifact?.type),
    )

    const second = artifacts.save({
      taskId: SCOPE,
      sessionId: 'selftest-67',
      name: 'install.sh',
      path: 'scripts/install.sh',
      content: 'echo v2\n',
    })
    check('第二次 save 成功', second.ok === true, JSON.stringify(second.error ?? ''))
    check('★ 同名同路径 → **同一个成果**（不是新建一个）', second.artifact?.id === id, String(second.artifact?.id))
    check('★ 版本号递增到 2', second.artifact?.version === 2, String(second.artifact?.version))
    check(
      '版本清单里有两条（1 和 2）',
      JSON.stringify((second.artifact?.versions ?? []).map((v) => v.version)) === '[1,2]',
      JSON.stringify(second.artifact?.versions),
    )

    /* ── ② 内容没变不新增版本 ───────────────────────────── */
    group('产物内核 / 内容没变不新增版本')
    const again = artifacts.save({
      taskId: SCOPE,
      sessionId: 'selftest-67',
      name: 'install.sh',
      path: 'scripts/install.sh',
      content: 'echo v2\n',
    })
    check('重复贴同一段 → deduped', again.deduped === true, JSON.stringify(again.deduped ?? false))
    check('版本号**没有**变成 3', again.artifact?.version === 2, String(again.artifact?.version))
    check(
      '版本清单还是两条',
      (again.artifact?.versions ?? []).length === 2,
      String((again.artifact?.versions ?? []).length),
    )

    /* ── ③ 按版本取回 / 越界报错 ────────────────────────── */
    group('产物内核 / 按版本取回')
    const latest = artifacts.get(id)
    check('get 不传版本 = 最新版', latest.ok === true && latest.content === 'echo v2\n', JSON.stringify(latest))
    const old = artifacts.get(id, 1)
    check('★ get(id, 1) 取回的是**第一版的正文**（老版本没被覆盖）', old.content === 'echo v1\n', String(old.content))
    check('get 的 artifact.version 是请求的那一版', old.artifact?.version === 1, String(old.artifact?.version))

    const beyond = artifacts.get(id, 99)
    check('★ 越界版本号 → ok:false（不是抛异常，也不是空串）', beyond.ok === false, JSON.stringify(beyond))
    check('越界时报错说清了现有范围', /99/.test(String(beyond.error)), String(beyond.error))
    const junk = artifacts.get(id, 'x')
    check('垃圾版本号 → ok:false', junk.ok === false, JSON.stringify(junk))
    const missing = artifacts.get('art_zzzzzzzz')
    check('不存在的 id → ok:false', missing.ok === false, String(missing.error))
    check(
      '★ 路径穿越的 id 被挡（../ 不许进）',
      artifacts.get('../../sessions').ok === false && artifacts.dirFor('../../sessions') === '',
      artifacts.dirFor('../../sessions'),
    )

    /* ── ④ 真的落了盘 ───────────────────────────────────── */
    group('产物内核 / 真的落到 data/artifacts/ 下')
    const root = artifacts.root()
    const dir = artifacts.dirFor(id)
    check('落盘目录是 data/artifacts/', /artifacts$/.test(root.replace(/[\\/]+$/, '')), root)
    check('★ 成果目录真的建出来了', existsSync(dir), dir)
    check('meta.json 在', existsSync(join(dir, 'meta.json')), join(dir, 'meta.json'))
    check('v1.md 在（第 1 版正文）', existsSync(join(dir, 'v1.md')), join(dir, 'v1.md'))
    check('v2.md 在（第 2 版正文）', existsSync(join(dir, 'v2.md')), join(dir, 'v2.md'))
    check('★ v1.md 里是**第一版**的正文（append-only，不原地改）', readFileSync(join(dir, 'v1.md'), 'utf8') === 'echo v1\n')

    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    check('meta.json 的 latest = 2', meta.latest === 2, String(meta.latest))
    check('meta.json 记了 path / taskId', meta.path === 'scripts/install.sh' && meta.taskId === SCOPE)
    check(
      '★ meta.json **不含正文**（正文外置，列清单不用把历史全读进内存）',
      !JSON.stringify(meta).includes('echo v2'),
      JSON.stringify(meta).slice(0, 120),
    )

    /* ── ⑤ 脱敏：正文里可能有密钥 ───────────────────────── */
    group('产物内核 / 正文过脱敏')
    const secret = artifacts.save({
      taskId: SCOPE,
      sessionId: 'selftest-67',
      name: 'notes.txt',
      type: 'document',
      content: 'key=sk-abcdefghijklmnopqrstuvwx\n',
    })
    if (secret.artifact?.id) created.push(secret.artifact.id)
    const back = artifacts.get(secret.artifact?.id ?? '')
    check(
      '★ 落盘的是打了码的（sk- 开头那串读不回来）',
      back.ok === true && !String(back.content).includes('abcdefghijklmnop'),
      String(back.content),
    )
    check('打码位置留了占位符', String(back.content).includes('***'), String(back.content))
    check(
      '磁盘上的 v1.md 也是打码后的',
      !readFileSync(join(artifacts.dirFor(secret.artifact?.id ?? ''), 'v1.md'), 'utf8').includes(
        'abcdefghijklmnop',
      ),
    )

    /* ── ⑥ list ─────────────────────────────────────────── */
    group('产物内核 / list 能列出、且不含正文')
    const rows = artifacts.list({ taskId: SCOPE })
    check('★ list 能列出本组造的成果', rows.some((row) => row.id === id), `共 ${rows.length} 条`)
    const row = rows.find((item) => item.id === id)
    check('list 出的那条带版本号（最新版）', row?.version === 2, String(row?.version))
    check('list 出的那条带版本清单（界面画「共 N 版」用）', row?.versions?.length === 2)
    check('★ list **不带正文**（正文要 get 单取）', row?.content === undefined, JSON.stringify(row?.content))
    check(
      'list 按 taskId 过滤得住（别的范围不会混进来）',
      rows.every((item) => item.taskId === SCOPE),
    )
    check('换个 taskId 就列不到', !artifacts.list({ taskId: 'no-such-task-67' }).some((r) => r.id === id))

    /* ── ⑦ 上限：超 maxVersions 丢最旧的 ───────────────── */
    group('产物内核 / 版本上限裁剪（默认 50）')
    let trimmed = ''
    for (let i = 1; i <= 55; i += 1) {
      const step = artifacts.save({
        taskId: SCOPE,
        sessionId: 'selftest-67',
        name: 'long.txt',
        type: 'report',
        content: `第 ${i} 版\n`,
      })
      if (step.artifact?.id) trimmed = step.artifact.id
    }
    if (trimmed) created.push(trimmed)
    const capped = artifacts.get(trimmed)
    check('★ 版本数被裁到 50（成果不能把磁盘吃光）', capped.artifact?.versions?.length === 50, String(capped.artifact?.versions?.length))
    check('最新版仍是 55', capped.artifact?.version === 55, String(capped.artifact?.version))
    check('最旧的被丢掉（清单从第 6 版起）', capped.artifact?.versions?.[0]?.version === 6, String(capped.artifact?.versions?.[0]?.version))
    check('★ 丢掉的版本正文文件也删了（不留孤儿）', !existsSync(join(artifacts.dirFor(trimmed), 'v5.md')))
    check('保留下来的版本正文还在', existsSync(join(artifacts.dirFor(trimmed), 'v6.md')))

    /* ── ⑧ remove ───────────────────────────────────────── */
    group('产物内核 / remove 生效')
    const removed = artifacts.remove(id)
    check('remove 返回 ok', removed.ok === true, JSON.stringify(removed.error ?? ''))
    check('★ 取不回来了（get → ok:false）', artifacts.get(id).ok === false)
    check('★ 目录也真的没了（不是只从清单里划掉）', !existsSync(artifacts.dirFor(id)))
    check('list 里也没有了', !artifacts.list({ taskId: SCOPE }).some((r) => r.id === id))
    check('再删一次 → 明确说「不存在」（不是静默成功）', artifacts.remove(id).ok === false)
    check('删不合法的 id 被挡', artifacts.remove('../sessions').ok === false)

    /* ── 留个证据：目录长什么样（人肉也能去看） ─────────── */
    group('产物内核 / 落盘形状（给汇报用的实拍）')
    const shot = artifacts.save({
      taskId: SCOPE,
      sessionId: 'selftest-67',
      name: 'demo.md',
      type: 'document',
      content: '# demo\n',
    })
    if (shot.artifact?.id) created.push(shot.artifact.id)
    const shotDir = artifacts.dirFor(shot.artifact?.id ?? '')
    check(
      '目录里就两样：meta.json + v<N>.md',
      JSON.stringify(fsCore.readdirSync(shotDir).sort()) === '["meta.json","v1.md"]',
      JSON.stringify(fsCore.readdirSync(shotDir)),
    )
    console.log(`  ℹ 实拍：${shotDir}`)
    console.log(`  ℹ meta.json：${readFileSync(join(shotDir, 'meta.json'), 'utf8').replace(/\n/g, ' ')}`)
  } finally {
    sweep()
  }
}

import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   记忆反射（`electron/core/memory-reflect.cjs`）—— 缺口 D 的雏形

   Recall 交**条目**（一条一行、按分数排序、每轮都注入）；
   Reflect 交**综合结论**（把「同一件事被记过不止一次」归并成一句），
   只在**新活第一轮**注入。

   最容易写出来的假 Reflect 是把条目重新列一遍 —— 那等于同一个提示里说两遍，
   白烧 token 还稀释注意力。所以这一组主要钉「它不许退化成 Recall」：
     · 只输出**成组**的（≥2 条在说同一件事），一条的组不输出；
     · 跟本次提问**没有词重合**的不算相关；
     · 上限 3 组 / 400 字符；一组都没有 → 空串（不注入空标题）。

   ★ 这一组**故意不碰数据**：store 没有内存模式，写它就是在动真实的
     `data/memory.json`。所以这里只喂手造的召回结果给**纯函数** `synthesize()`；
     真读记忆那一条路径在 `tmp/reflect-e2e.mjs` 里用 `paths.markPackaged(临时目录)`
     跑（那个会改全局状态，不能放自检里）。
   ══════════════════════════════════════════════════════════════ */

const reflect = require(join(ROOT, 'electron/core/memory-reflect.cjs'))

/** 造一条「召回结果」（形状与 recall.retrieve({explain:true}) 一致，只留用到的字段） */
let seq = 0
function entry(content, type, overlap) {
  seq += 1
  return {
    item: { id: `mem_test_${seq}`, seq, content, type, scope: 'global' },
    score: 10,
    reasons: [{ key: 'overlap', label: '与本次提问相关', weight: overlap, detail: '' }],
  }
}

export async function run() {
  group('记忆反射 / 归并（不许退化成 Recall）')
  const query = '把设置页的开关改一下'

  const duplicated = [
    entry('改完 UI 必须真跑一遍再看结论，不许只看测试绿', 'constraint', 3),
    entry('UI 改动必须真跑一遍再下结论，测试绿不算数', 'constraint', 2.4),
  ]
  const merged = reflect.synthesize(duplicated, query)
  check('★ 同一件事记过两次 → 归并成一句（而不是列两行）', merged.split('\n').filter((l) => l.startsWith('- ')).length === 1, `实际=\n${merged}`)
  check('★ 说出了「记过几次」这个新信息', merged.includes('记过 2 次'), `实际=\n${merged}`)
  check('★ 带上可追溯的编号（两条都要）', merged.includes('#1') && merged.includes('#2'), `实际=\n${merged}`)
  check('带类型标签（约束）', merged.includes('【约束】'), `实际=\n${merged}`)
  check('说明这是综合、不是本轮要求', merged.includes('不是本轮的要求'))

  group('记忆反射 / 一条的组不输出（那就是 Recall 的活）')
  const single = reflect.synthesize([entry('提交前必须跑 verify', 'constraint', 3)], query)
  check('★ 只有一条 → 空串（不重复 Recall 已经说过的话）', single === '', `实际=${single}`)
  check('两条但说的不是同一件事 → 也不归并', reflect.synthesize([entry('提交前必须跑 verify', 'constraint', 3), entry('网页正文要清洗掉导航', 'workflow', 2)], query) === '')

  group('记忆反射 / 相关性门槛与类型门槛')
  const unrelated = [entry('改完 UI 必须真跑一遍', 'constraint', 0), entry('UI 改动必须真跑一遍再看', 'constraint', 0)]
  check('★ 跟本次提问没有词重合 → 不算相关（不给噪音）', reflect.synthesize(unrelated, query) === '', `实际=${reflect.synthesize(unrelated, query)}`)
  check('没有查询词（比如空的一轮）→ 空串', reflect.synthesize(duplicated, '') === '')
  const prefs = [entry('回答尽量短一点', 'preference', 3), entry('回答尽量短，别写小作文', 'preference', 2)]
  check('★ 偏好 / 事实类不算「踩过的坑」（那是 Recall 的地盘）', reflect.synthesize(prefs, query) === '', `实际=${reflect.synthesize(prefs, query)}`)
  check('「经验类」名单写死在文件里、可核对', reflect.REFLECT_TYPES.includes('constraint') && !reflect.REFLECT_TYPES.includes('preference'))
  /* 门槛是量出来的（见 memory-reflect.cjs 的注释）—— 掉到「不同事也会被并」那一档就会红 */
  const same = reflect.isSameThing('改完 UI 必须真跑一遍再看结论，不能只看测试是不是绿的', '改完 UI 之后必须真跑一遍再下结论，测试绿但功能是坏的吃过两次亏')
  const diff = reflect.isSameThing('改完 UI 必须真跑一遍', '改完 UI 记得截图存档')
  check('★ 措辞不同的同一件事 → 认成同一件（实测这对是 0.435）', same === true)
  check('★ 相关但不是同一件事 → 不认（实测这对是 0.286，门槛 0.35）', diff === false)
  check('门槛落在量出来的分割区间里（0.286 ~ 0.435）', reflect.SAME_THING_FLOOR > 0.286 && reflect.SAME_THING_FLOOR < 0.435, `实际=${reflect.SAME_THING_FLOOR}`)

  group('记忆反射 / 上限（预算与组数）')
  const many = []
  for (let i = 0; i < 6; i += 1) {
    many.push(entry(`第 ${i} 类注意事项：先把 ${i} 号开关的名字对上再改`, 'workflow', 2))
    many.push(entry(`第 ${i} 类注意事项：改 ${i} 号开关前先核对名字`, 'workflow', 1.8))
  }
  const capped = reflect.synthesize(many, query)
  check('最多 3 组', capped.split('\n').filter((l) => l.startsWith('- ')).length <= 3, `实际=${capped.split('\n').length} 行`)
  check('在 400 字符预算内', capped.length <= reflect.MAX_CHARS, `长度=${capped.length}`)
  check('截断时先说满整句、不切坏说明句（结尾是完整的）', capped.endsWith('或按编号找。'), `结尾=${capped.slice(-20)}`)
  const longOne = '改完 UI 之后必须真跑一遍再看结论'
  /* 刻意**用程序拼**一段远超过 60 字的记忆，别靠肉眼数中文字数（上一版正好凑成 60，白写） */
  const longTail = '也不许只凭印象说「应该是好的」'
  const longTwo = `${longOne}，而且要把日志逐行读出来比对，不许只看测试是不是绿的，而且要把日志逐行读出来比对，不许只凭印象，${longTail}`
  const longText = reflect.synthesize([entry(longTwo, 'constraint', 3), entry(longOne, 'constraint', 2)], query)
  check('这条测试数据确实超过 60 字（否则截断根本没被考验到）', longTwo.length > 70, `实际长度=${longTwo.length}`)
  check('★ 超长的记忆会被截短（写死 60 字上限，不把整条抄进来）', longText.includes('…') && !longText.includes(longTail), `实际=\n${longText}`)
  check('吃脏数据不抛（缺 content / 缺 reasons 都当没有）', reflect.synthesize([{ item: { type: 'constraint' } }, { item: { content: 'x', type: 'constraint' }, reasons: null }], query) === '')

  seq = 0
}

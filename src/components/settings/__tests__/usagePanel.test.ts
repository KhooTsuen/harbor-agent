import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
    第五阶段 · 模型用量页的真实口径（源码级守卫）

    ── 为什么这些必须是源码断言而不是渲染测试 ────────────────────
    这里守的全是「界面上写的那句话必须和内核口径一致」：
      · 不把未知说成 0
      · 覆盖率不等于 token 准确率
      · 缓存/思考不重复加
      · 请求记录完整率如实说「无法验证」
    这些是**文案与取数来源**的契约，渲染出来只能看到字，看不到它是不是
    从正确的字段来的。等真机渲染测试再做一层（`usagePanelRender.test.tsx`）。

    ── 以前踩过的坑（所以每条都要钉）─────────────────────────────
    · 第一/二/四阶段都出过「同一组件挂两次」—— 这里加一条「面板只被
      settingsPages 引用一次」。
    · 第三阶段出过「旧入口没删、两套都能改」—— 这里钉「旧 UsageTab 已删」。
    ══════════════════════════════════════════════════════════════ */

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
/** 去掉注释：注释里提到某个词不算「实现了」 */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const DIR = 'src/components/settings/usage'

describe('第五阶段 / ① 数据源：全部来自真实账本，不用旧累计桶', () => {
  it('★★★ 面板走 usageQuery，不读 statsSummary 取 token 数字', () => {
    const panel = strip(read(`${DIR}/UsagePanel.tsx`))
    expect(panel).toContain('usageQuery')
    /*
     * `statsSummary` 只能用来取 `gate`（闸门的「今天/本月已用」由内核算，
     * 界面自己算会出现两份日期口径）。所以允许它出现，但**不许**把它的
     * token 字段拿来当用量显示。
     */
    expect(panel).not.toContain('data.total')
    expect(panel).not.toContain('summary.total')
  })

  it('★★ 概览/热力图/分析/可信度 各只挂一次（别再出现两套入口）', () => {
    const panel = strip(read(`${DIR}/UsagePanel.tsx`))
    for (const name of [
      'UsageOverview',
      'UsageHeatmap',
      'UsageBreakdown',
      'UsageCost',
      'UsageTrust',
      'UsageDetails',
    ]) {
      const hits = panel.split(`<${name}`).length - 1
      expect(hits, `${name} 挂了 ${hits} 次`).toBe(1)
    }
  })

  it('★★★ 旧的 UsageTab / DataUsagePanel 已删（留着就是第二套口径）', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    expect(fs.existsSync(join(ROOT, 'src/components/settings/tabs/UsageTab.tsx'))).toBe(false)
    expect(fs.existsSync(join(ROOT, 'src/components/settings/panels/DataUsagePanel.tsx'))).toBe(
      false,
    )
  })

  it('★ settingsPages 的 usage 页指向新面板', () => {
    const pages = strip(read('src/components/settings/settingsPages.tsx'))
    expect(pages).toContain('<UsagePanel />')
    expect(pages).not.toContain('<UsageTab')
  })
})

describe('第五阶段 / ② 未知不冒充零', () => {
  it('★★★ 概览：全部未知时**不显示 token 总量**', () => {
    const src = strip(read(`${DIR}/UsageOverview.tsx`))
    /* 全未知那条分支必须存在，且说的是「未知」不是 0 */
    expect(src).toContain('allUnknown')
    expect(src).toContain('一次都没有拿到真实 usage')
    expect(src).toContain('不是 0')
  })

  it('★★ 概览：覆盖率旁边必须写明「不是 token 准确率」', () => {
    const src = strip(read(`${DIR}/UsageOverview.tsx`))
    expect(src).toContain('不是')
    expect(src).toContain('token 总量的准确率')
  })

  it('★★★ 热力图：三种状态用不同的判据（没调用 / 确认为 0 / 未知）', () => {
    const src = strip(read(`${DIR}/UsageHeatmap.tsx`))
    expect(src).toContain('dayStateOf')
    /* 未知用量不能画成和「没调用」一样的浅色 —— 必须有独立样式 */
    expect(src).toContain('unknownStyle')
    expect(src).toContain("state === 'partial'")
    /* 图例要能区分四类 */
    expect(src).toContain('没调用')
    expect(src).toContain('有调用但用量未知')
    expect(src).toContain('有调用但确认为 0')
  })

  it('★★ 明细：未知的那行不许显示成 0', () => {
    const src = strip(read(`${DIR}/UsageDetails.tsx`))
    expect(src).toContain('用量未知（未上报）')
    /* 判据读的是 known === false，不是「total 为 0」 */
    expect(src).toContain('row.known === false')
  })
})

describe('第五阶段 / ③ 缓存与思考不重复累加', () => {
  it('★★★ 概览把「已包含」写死（用户会想相加）', () => {
    const src = strip(read(`${DIR}/UsageOverview.tsx`))
    expect(src).toContain('已包含')
    expect(src).toContain('再加一遍会重复')
  })

  it('★★ 多维分析把缓存/思考单列并标注「不额外相加」', () => {
    const src = strip(read(`${DIR}/UsageBreakdown.tsx`))
    expect(src).toContain('含在输入 / 输出里，不额外相加')
  })
})

describe('第五阶段 / ④ 可信度：不编分数、不自我验证', () => {
  it('★★★ 请求记录完整率如实说「无法验证」', () => {
    const src = read(`${DIR}/UsageTrust.tsx`)
    expect(src).toContain('请求记录完整率')
    expect(src).toContain('无法验证')
    /* 理由必须写出来：拿账本自己当分母是自我验证 */
    expect(src).toContain('自我验证')
  })

  it('★★★ 没有综合可信度评分的字样', () => {
    const src = strip(read(`${DIR}/UsageTrust.tsx`))
    expect(src).not.toMatch(/可信度\s*\d+\s*分/)
    expect(src).not.toContain('综合评分')
  })

  it('★★ 异常按「真跑过哪几项」显示，没跑过不许说 0', () => {
    const src = strip(read(`${DIR}/UsageTrust.tsx`))
    expect(src).toContain('checked.length')
    expect(src).toContain('不代表「0 个异常」')
  })

  it('★★ 内核体检只声明四类检查（多一类就要在此同步）', () => {
    const core = read('electron/core/usage-anomalies.cjs')
    const checked = /const CHECKED = \[([^\]]+)\]/.exec(core)?.[1] ?? ''
    const names = checked
      .split(',')
      .map((s) => s.replace(/['"\s]/g, ''))
      .filter(Boolean)
    expect(names.sort()).toEqual(
      ['badValues', 'cacheOverflow', 'duplicates', 'missingOutcome'].sort(),
    )
  })
})

describe('第五阶段 / ⑤ 费用三分，不混成「花了多少钱」', () => {
  it('★★★ 实际账单没来源时显示「没有」，不编金额', () => {
    const src = strip(read(`${DIR}/UsageCost.tsx`))
    expect(src).toContain('服务商实际账单金额')
    expect(src).toContain('没有')
    expect(src).toContain('不会用单价表推算冒充')
  })

  it('★★ 本地折算明确标「估算」且说明不是账单', () => {
    const src = strip(read(`${DIR}/UsageCost.tsx`))
    expect(src).toContain('估算')
    expect(src).toContain('不是账单')
  })

  it('★★ 余额与消费分开说明（方向相反，不能混）', () => {
    const src = strip(read(`${DIR}/UsageCost.tsx`))
    expect(src).toContain('剩余额度，不是已消费金额')
  })
})

describe('第五阶段 / ⑥ 可信度接口真的接到界面上', () => {
  it('★★★ usage:query 返回 anomalies，且桥三层都通', () => {
    expect(read('electron/core/usage-query.cjs')).toContain('anomalies.checkRows')
    expect(read('electron/handlers/usage.cjs')).toContain('usage:query')
    expect(read('electron/preload.cjs')).toContain("call('usage:query'")
    expect(read('src/types/backend.ts')).toContain('usageQuery')
    expect(read('src/lib/usageApi.ts')).toContain('usageQuery')
  })
})

describe('第五阶段 / ⑦ 分页与性能约束', () => {
  it('★★★ 明细必须分页（不许一次渲染全部历史）', () => {
    const src = strip(read(`${DIR}/UsageDetails.tsx`))
    expect(src).toContain('PAGE_SIZE')
    expect(src).toContain('slice(')
    /* 翻页不重查：只在筛选变化时 load */
    const deps = /useEffect\(\(\) => \{\s*void load\(\)[^}]*\}, \[([^\]]+)\]\)/.exec(src)?.[1] ?? ''
    expect(deps).not.toContain('page')
  })

  it('★★ 明细查询才带 withRows（聚合不传大数据）', () => {
    const panel = strip(read(`${DIR}/UsagePanel.tsx`))
    expect(panel).not.toContain('withRows')
    expect(strip(read(`${DIR}/UsageDetails.tsx`))).toContain('withRows: true')
  })

  it('★★ 日期范围每次现算，不存死时间戳', () => {
    const store = strip(read('src/stores/useUsageTabStore.ts'))
    expect(store).toContain('rangeDays')
    expect(store).not.toContain('from:')
  })
})

describe('第五阶段 / ⑧ 失败与空态分得开', () => {
  it('★★★ 查询失败时不说「没有记录」', () => {
    const panel = strip(read(`${DIR}/UsagePanel.tsx`))
    expect(panel).toContain('用量查询失败')
    expect(panel).toContain('不是')
  })

  it('★★ 明细自己也有失败态', () => {
    const src = strip(read(`${DIR}/UsageDetails.tsx`))
    expect(src).toContain('明细读取失败')
    expect(src).toContain('没有记录')
    /* 说清「查询出问题」而不是「你确实没消耗」 */
    expect(src).toContain('查询本身出了问题')
  })
})

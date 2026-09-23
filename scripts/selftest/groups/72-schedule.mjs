/**
 * 自检 / 定时任务（组入口）
 *
 * 这一组钉的是**授权边界**，不是调度功能本身。定时任务最大的风险是
 * 「用户不在场，应用自己跑命令、自己改文件」，所以下面几条是防回归的钉子：
 *
 *   · 三档的 `shellPolicy.high` / `.critical` **必须**是 block（写死断言）
 *   · `configFor` 不许改传进来的 baseConfig（跑一次不能污染用户配置）
 *   · 执行器给 loop 的 `confirm` **永远是 false**（没人在场 = 没人能批准）
 *   · 同一条不许并发跑
 *
 * 十段、62 条断言，按职责拆成三个文件（全塞这里会顶破 300 行红线）：
 *   · 72-schedule-core-parts.mjs  时间计算 + 台账（纯函数与落盘）
 *   · 72-schedule-run-parts.mjs   授权上限 + 执行器（要反复审的那两块）
 *   · 这个文件                    接线：路径、隔离、调用顺序、收尾
 *
 * 不碰真实数据：台账路径用 `setFilePathForTest` 指到 data/selftest-workspace/；
 * 模型一律是纯函数桩（**不联网、不 require 主进程模块**）。
 *
 * 注意：这一组**还没有**注册进 `scripts/selftest.mjs`（那个文件不让改）。
 * 单独跑：
 *   node -e "import('./scripts/selftest/groups/72-schedule.mjs').then(m=>m.run())"
 */

import { join, mkdirSync, readFileSync, rmSync, SANDBOX, require, ROOT, riskCore } from '../env.mjs'
import { runTimeChecks, runLedgerChecks } from './72-schedule-core-parts.mjs'
import { runGrantChecks, runRunnerChecks, runKernelChecks } from './72-schedule-run-parts.mjs'

const next = require(join(ROOT, 'electron/core/schedule-next.cjs'))
const grant = require(join(ROOT, 'electron/core/schedule-grant.cjs'))
const store = require(join(ROOT, 'electron/core/schedule-store.cjs'))
const runner = require(join(ROOT, 'electron/core/schedule-run.cjs'))

/** 自检用的台账文件，建在沙箱里（**绝不许**落在 data/schedules.json 上） */
const LEDGER = join(SANDBOX, 'schedules-selftest.json')

/** 用户配置的样子（策略全是宽的那一档 —— 用来证明定时任务不会继承它） */
const BASE_CONFIG = {
  tools: {
    permission: 'ask',
    fileScope: 'workspace',
    shellPolicy: { medium: 'allow', high: 'allow', critical: 'allow' },
  },
}

/** 假的配置读取口：永远返回上面那份「宽」配置 —— 模拟最坏情况的用户设置 */
const configStub = { get: () => BASE_CONFIG }

export async function run() {
  mkdirSync(SANDBOX, { recursive: true })
  store.setFilePathForTest(LEDGER)

  try {
    runTimeChecks({ next })
    runGrantChecks({ grant, riskCore, BASE_CONFIG })
    runLedgerChecks({ store, join, readFileSync, SANDBOX })
    await runRunnerChecks({ runner, configStub })
    runKernelChecks({ readFileSync, join, ROOT })
  } finally {
    /* 收尾必须在 finally 里：中途炸了也要把台账路径还回去，
       不然后面的组会继续往沙箱写，而真实台账看着像「没配好」 */
    store.setFilePathForTest('')
    rmSync(LEDGER, { force: true })
  }
}

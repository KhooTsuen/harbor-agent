import { UsageTab } from '../tabs/UsageTab'
import { DataTab } from '../tabs/DataTab'

/* ══════════════════════════════════════════════════════════════
   数据与用量 = 我花了多少 + 我的数据在哪

   用量（含预算闸）和备份/导出/诊断本质是同一件事的两面：
   「消耗」和「资产」。放一页，用户想看「我这个月用了多少、
   数据存哪、怎么带走」的时候不用换标签。
   ══════════════════════════════════════════════════════════════ */

export function DataUsagePanel(): React.ReactElement {
  return (
    <>
      <UsageTab />
      <div>
        <DataTab />
      </div>
    </>
  )
}

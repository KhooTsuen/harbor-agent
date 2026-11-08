import type { AppConfig } from '@/types/models'
import { useConfigStore } from '@/stores/useConfigStore'
import { Row, SectionTitle } from '../parts'
import { SearchPanel } from '../tabs/SearchPanel'
import { NetworkPolicyPanel } from '../panels/NetworkPolicyPanel'
import { SCOPE_OPTIONS } from './meta'
import { PolicySelect, fullPolicy } from './SecurityParts'
import { PermissionLevelSummary } from './PermissionLevelSummary'

/* ══════════════════════════════════════════════════════════════
   权限策略 —— 「我允许它做什么」

   ── 这一组回答的问题 ──────────────────────────────────────────
   四条轴，从上到下就是「它能碰什么」的四个方向：
     ① 工具权限档   要不要问你（ask / read / full）
     ② 文件         能碰哪些路径
     ③ 命令         Shell 三类风险各自怎么办
     ④ 网络         能不能联网、能连哪些地址

   ── 为什么先摆「当前状态」再摆控件 ────────────────────────────
   用户来这一页第一句问的是「现在到底允许什么」，不是「怎么改」。
   所以 `PermissionLevelSummary` 把三档的实际含义摆最上面 ——
   原来只有一排按钮，选完不知道变成了什么。

   ── 档位与策略是两层，必须说清 ────────────────────────────────
   档位说「要不要问你」；策略说「这类命令要不要拦」。
   选「完全访问」= 不问；想拦住某类命令得把策略设成「拦住」。
   这个关系写在这里，也写在那个档位的说明里（两处一致）。
   ══════════════════════════════════════════════════════════════ */

export function AccessPolicyGroup(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const patchTools = useConfigStore((s) => s.patchTools)
  const tools = config?.tools

  return (
    <>
      <SectionTitle hint="当前生效的档位，以及三档各自允许什么">当前权限状态</SectionTitle>
      <PermissionLevelSummary />

      <SectionTitle hint="决定要不要问你；下面几条决定「问也问不到的那类命令」怎么办">
        Shell 风险策略
      </SectionTitle>
      <p className="px-3 pb-1.5 text-dense leading-relaxed text-fg-tertiary">
        这三行说「这一类命令怎么办」，和上面的「工具权限」是两层：策略说要不要拦，
        权限档说要不要问你 —— 选「完全访问」就是不问；想拦住某类命令，把它设成「拦住」。
      </p>
      <Row label="中风险" hint="装依赖、构建、改 Git 状态、网络请求">
        <PolicySelect
          value={tools?.shellPolicy?.medium ?? 'ask'}
          onChange={(value) =>
            void patchTools({ shellPolicy: { ...fullPolicy(tools?.shellPolicy), medium: value } })
          }
        />
      </Row>
      <Row label="高风险" hint="递归删除、改注册表、提权、下载后执行">
        <PolicySelect
          value={tools?.shellPolicy?.high ?? 'ask'}
          onChange={(value) =>
            void patchTools({ shellPolicy: { ...fullPolicy(tools?.shellPolicy), high: value } })
          }
        />
      </Row>
      <Row
        label="危急"
        hint="格式化磁盘、破坏系统、抓凭据、关杀软。默认就是「拦住」（连问都不问），要放行得自己改成「直接执行」"
      >
        <PolicySelect
          value={tools?.shellPolicy?.critical ?? 'block'}
          onChange={(value) =>
            void patchTools({ shellPolicy: { ...fullPolicy(tools?.shellPolicy), critical: value } })
          }
        />
      </Row>

      <SectionTitle>文件访问范围</SectionTitle>
      <Row
        label="Agent 能碰哪些文件"
        hint="默认只允许工作目录。要动外面时会在对话里弹窗问一次，批准后本次会话有效。（选了「完全访问」就不再问，只留一条记录）"
      >
        <div className="flex flex-col gap-1">
          {SCOPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-2 py-0.5">
              <input
                type="radio"
                name="fileScope"
                className="mt-1"
                checked={tools?.fileScope === option.value}
                onChange={() =>
                  void patchTools({ fileScope: option.value as AppConfig['tools']['fileScope'] })
                }
              />
              <span>
                <span className="text-dense text-fg-primary">{option.label}</span>
                <span className="ml-1.5 text-dense text-fg-tertiary">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Row>

      <SectionTitle hint="能不能联网、能连哪些地址">网络</SectionTitle>
      <NetworkPolicyPanel />

      <SectionTitle hint="联网搜索用哪个后端">联网搜索</SectionTitle>
      <SearchPanel />
    </>
  )
}

import { Select } from '@/components/ui/Field'
import { useConfigStore } from '@/stores/useConfigStore'
import { Row, SectionTitle } from '../parts'
import { BrowserExtCard } from '../tabs/BrowserExtCard'

/* ══════════════════════════════════════════════════════════════
   工具与扩展 → 浏览器扩展

   ── 这一区放什么 ──────────────────────────────────────────────
     ① 「网页里的链接」—— Agent 打开地址时的放行策略
        （**这是权限**，不是插件，但它只影响浏览器这一条路径，
          所以留在这而不是搬到权限页 —— 用户找它时会想到浏览器）
     ② 扩展安装与连接状态（Edge 侧边栏 + Native Host 诊断）

   ★ 第二阶段它从「通用与快捷键」搬到这里；配置键一直是
     `config.general.browserNavigation`，没动过。
   ══════════════════════════════════════════════════════════════ */

export function BrowserGroup(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)

  return (
    <>
      <SectionTitle hint="Agent 在网页里点链接时怎么处理">链接放行策略</SectionTitle>
      <Row label="网页里的链接" hint="每次先问你 / 直接放行 http(s) / 只允许打开空白页">
        <Select
          value={config?.general.browserNavigation ?? 'ask'}
          onChange={(v) => void patchGeneral({ browserNavigation: v as 'ask' | 'allow' | 'block' })}
          options={[
            { value: 'ask', label: '每次先问我' },
            { value: 'allow', label: '直接放行' },
            { value: 'block', label: '不允许打开网页' },
          ]}
        />
      </Row>
      <p className="px-3 pb-1 text-2xs leading-relaxed text-fg-tertiary">
        这条只影响「内置网页里点链接、打开新地址」。全局的网络能力（能不能联网、
        白名单域名）在「权限与安全 → 权限策略」里。
      </p>

      <BrowserExtCard />
    </>
  )
}

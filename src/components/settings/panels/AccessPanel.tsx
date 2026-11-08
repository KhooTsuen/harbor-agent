import { useAccessTabStore } from '@/stores/useAccessTabStore'
import { AccessTabs } from '../security/AccessTabs'
import { AccessPolicyGroup } from '../security/AccessPolicyGroup'
import { AccessProtectionGroup } from '../security/AccessProtectionGroup'
import { AccessAuditGroup } from '../security/AccessAuditGroup'
import { AccessAdvancedGroup } from '../security/AccessAdvancedGroup'

/* ══════════════════════════════════════════════════════════════
   权限与安全 = Agent 能碰什么、它做过什么、我还能收回什么

   ── 从「一个长页面」改成「四个分组」──────────────────────────
   原来这一页把九块纵向平铺：权限档 / 文件范围 / Shell 三档 / 网络策略 /
   会话加密 / 当前授权 / 审批记录 / 审计日志 / 密钥。真机要滚五六屏，
   而且「撤销某个授权」这件最急的事排在第五块之后。

   四组的读者和时刻都不同（配一次 / 偶尔看 / 出事才来 / 平时不看），
   所以按「什么时候会发生」排，而不是按「配置属于哪个模块」排。

   ── 装配只在这里做一次 ────────────────────────────────────────
   和 13 页装配表同一个道理：分组内容集中在一处 switch 里，
   加一个分组只改这里。任何子组件都不许自己再挂同一块内容 ——
   `settingsP4.test` 会逐个数渲染次数。
   ══════════════════════════════════════════════════════════════ */

export function AccessPanel(): React.ReactElement {
  const tab = useAccessTabStore((s) => s.tab)

  return (
    <>
      <AccessTabs />
      {tab === 'policy' ? <AccessPolicyGroup /> : null}
      {tab === 'protection' ? <AccessProtectionGroup /> : null}
      {tab === 'audit' ? <AccessAuditGroup /> : null}
      {tab === 'advanced' ? <AccessAdvancedGroup /> : null}
    </>
  )
}

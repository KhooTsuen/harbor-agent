/**
 * M02-C：**设置抽屉**（与会话抽屉同款，从左侧滑出）
 *
 * ── 三块内容，各自有一条「为什么这么写」────────────────────────
 *
 * ① **连接信息**：host 名 / 连接状态 / 重试。
 *    host 名 `com.harbor.agent` 是 `install-host.cmd` 写进注册表的那个（唯一真相源在
 *    `electron/core/ext-protocol.cjs` 的 `HOST_NAME` 与扩展 `native.js`），这里**只显示**
 *    不另立一份常量 —— 显示错了比不显示更糟。
 *
 * ② **能力清单（从 manifest 现算）**：设计文档明确要求「不手写」。
 *    手写的清单会在改 manifest 时偷偷过期（改了权限、清单还写着旧的），
 *    而用户是拿它判断「这个扩展能干什么」的。所以这里读 `chrome.runtime.getManifest()`
 *    → 查 `permissions` → 按一张**名字 → 人话**的映射翻出来；不认识的权限**如实列原名**，
 *    不猜、也不隐藏（隐藏等于骗）。
 *
 * ③ 站点权限直接调用 Harbor 主进程的同一份策略，可临时拒绝并撤销。
 *
 * ── 为什么单列一个文件 ─────────────────────────────────────────
 *
 * `App.tsx` 279 行、`ChatPanel.tsx` 224 行都不该再塞抽屉；而且这块是**纯展示**
 * （除了「重试连接」一个动作），与对话链路无关。
 */

/* global chrome */

import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
/* 纯逻辑在 settings-info.ts（自检能直接跑；本文件只负责画） */
import { HOST_NAME, OPTIONAL_TEXT, SITES_POINTER, capabilitiesOf } from './settings-info'
import { SitePolicyPanel } from './SitePolicyPanel'
import { SiteAccessPanel } from './SiteAccessPanel'

export interface SettingsDrawerProps {
  onClose: () => void
  connected: boolean
  /** 连接状态的人话（沿用顶栏那条，不另编一套） */
  lastError?: string | null
  onRetry: () => void
}

/** 现读 manifest（读不到返回 null —— 抽屉不能因此白屏） */
function readManifest() {
  try {
    return chrome.runtime.getManifest()
  } catch {
    return null
  }
}

export function SettingsDrawer({ onClose, connected, lastError, onRetry }: SettingsDrawerProps) {
  const { capabilities, hostPermissions, optionalHostPermissions } = capabilitiesOf(readManifest())

  return (
    /* 背板：点它 = 点抽屉外面 → 收起（与会话抽屉同一套收起路径） */
    <div className="absolute inset-0 z-20" onClick={onClose}>
      <div
        role="dialog"
        aria-label="设置抽屉"
        onClick={(e) => e.stopPropagation()}
        className="drawer-in absolute inset-y-0 left-0 flex w-[85%] max-w-[320px] flex-col border-r border-line-hairline bg-canvas shadow-lg"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line-hairline px-3 py-2">
          <span className="text-dense font-medium">设置</span>
          <span className="flex-1" />
          <IconButton label="收起设置" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-2xs">
          {/*
           * 分区标题统一口径（2026-10-21）：`text-dense + font-semibold + fg-secondary`。
           * 原来是 2xs + fg-tertiary —— 和正文同样大小同样灰，用户扫不出来有哪几块
           * （截图复查时指出「层级不够明显」）。正文才用 2xs。
           */}
          {/* ① 连接信息 */}
          <section aria-label="连接信息" className="mb-4">
            <div className="mb-1.5 text-dense font-semibold text-fg-secondary">连接</div>
            <div aria-label="连接状态详情" className="text-fg-secondary">
              {connected ? '已连上 Harbor' : '未连上 Harbor'}
            </div>
            <div aria-label="host 名" className="mt-0.5 break-all text-fg-tertiary">
              {HOST_NAME}
            </div>
            {!connected && lastError ? (
              <div role="alert" className="mt-1 text-danger">
                {lastError}
              </div>
            ) : null}
            <Button size="sm" variant="ghost" aria-label="重试连接" className="mt-1" onClick={onRetry}>
              重试连接
            </Button>
          </section>

          {/* ② 能力清单（从 manifest 现算） */}
          <section aria-label="能力清单" className="mb-4">
            <div className="mb-1.5 text-dense font-semibold text-fg-secondary">这个扩展能做什么</div>
            <div className="mb-1 text-fg-tertiary">（按实际权限列出，不手写）</div>
            {capabilities.length === 0 ? (
              <div className="text-fg-secondary">读不到权限清单（manifest 不可用）</div>
            ) : (
              <ul aria-label="权限列表" className="space-y-1.5">
                {capabilities.map((c) => (
                  <li key={c.name} className="leading-relaxed text-fg-secondary">
                    <span className="text-fg-primary">{c.text}</span>
                    {c.known ? null : <span className="text-fg-tertiary">（未收录的权限：{c.name}）</span>}
                  </li>
                ))}
              </ul>
            )}
            {hostPermissions.length > 0 ? (
              <div aria-label="额外站点权限" className="mt-1 text-warning">
                另外还申请了站点权限：{hostPermissions.join(', ')}（产品版没有这一项）
              </div>
            ) : null}
            {optionalHostPermissions.length > 0 ? (
              <div aria-label="可选站点权限" className="mt-1 text-fg-tertiary">
                {OPTIONAL_TEXT}
              </div>
            ) : null}
          </section>

          {/* ③ 整站读取（浏览器层面够不够得着 —— 与下面的黑名单正交） */}
          <SiteAccessPanel connected={connected} />

          {/* ④ 站点权限：主进程统一判定 */}
          <section aria-label="站点权限指路">
            <div className="mb-1.5 text-dense font-semibold text-fg-secondary">站点权限</div>
            <p aria-label="站点权限说明" className="whitespace-pre-line text-fg-secondary">
              {SITES_POINTER}
            </p>
            <SitePolicyPanel connected={connected} />
          </section>
        </div>
      </div>
    </div>
  )
}

import type { McpServerConfig, McpServerStatus } from '@/types/mcp'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   单个 MCP 服务器的隔离设置

   MCP 服务器是**第三方进程**，默认不该拿到主进程的环境变量
   —— 那里面有所有 API Key。所以默认 inheritEnvironment = false，
   白名单只留「让进程能跑起来」的最小集（少了 SystemRoot 之类很多程序起不来）。

   从 McpTab 拆出来的：那边加完这些字段就过 300 行了。
   ══════════════════════════════════════════════════════════════ */

export function ServerIsolation({
  server,
  status,
  onChange,
  onRestart,
}: {
  server: McpServerConfig
  /** 内核报的运行时状态；没有（还没查过 / 假数据）就不显示那一块 */
  status?: McpServerStatus
  onChange: (id: string, patch: Partial<McpServerConfig>) => void
  /** 重起连接池（由 McpTab 提供）。一键放行时要用 */
  onRestart?: () => void
}) {
  /*
   * 被网络策略拦下时给一条**出路**。
   *
   * 为什么需要它：`network: 'ask'` 在**启动阶段没法问**（那里没有确认界面），
   * 所以内核默认**放行**并如实标 `uncontrolled`；只有声明写成 `deny`
   * （或全局策略是「禁止」）才会真的不启动。用户看到「未连接」和一句理由，
   * 却不知道该去哪儿改 —— 这个按钮就是那句话的下一步。
   */
  const blocked = status?.networkStatus === 'blocked' || Boolean(status?.blockedReason)

  return (
    <div className="mt-2 border-t border-line-hairline pt-2">
      {blocked ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-2xs" style={{ color: colorOf('warning') }}>
            它需要联网，但声明或全局策略把它挡在启动之前了
          </span>
          {onRestart ? (
            <button
              type="button"
              /* 只改 network 这一项，其余设置一个字不动；改完重启才生效 */
              onClick={() => {
                onChange(server.id, { network: 'allow' })
                onRestart()
              }}
              className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-0.5 text-2xs text-fg-primary hover:border-line-strong"
            >
              把这个服务器改成「允许联网」并重启
            </button>
          ) : null}
        </div>
      ) : null}

      {status?.networkNote ? (
        <p className="mb-2 text-2xs leading-relaxed text-fg-tertiary">{status.networkNote}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
          <input
            type="checkbox"
            checked={server.inheritEnvironment === true}
            onChange={(e) => onChange(server.id, { inheritEnvironment: e.target.checked })}
          />
          继承环境变量
          <span className="text-fg-tertiary">（密钥类变量始终不给）</span>
        </label>

        <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
          网络
          <select
            value={server.network ?? 'ask'}
            onChange={(e) =>
              onChange(server.id, {
                network: e.target.value as McpServerConfig['network'],
              })
            }
            className="rounded-sm border border-line-subtle bg-bg-raised px-1.5 py-0.5 text-2xs text-fg-primary focus:outline-none"
          >
            <option value="deny">不允许</option>
            <option value="ask">用之前问</option>
            <option value="allow">允许</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
          超时
          <input
            type="number"
            min={1000}
            step={1000}
            value={server.timeoutMs ?? 30_000}
            onChange={(e) => onChange(server.id, { timeoutMs: Number(e.target.value) || 30_000 })}
            className="w-20 rounded-sm border border-line-subtle bg-bg-raised px-1.5 py-0.5 font-mono text-2xs text-fg-primary focus:outline-none"
          />
          ms
        </label>

        <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
          工具权限
          <select
            value={server.permission ?? 'ask'}
            onChange={(e) =>
              onChange(server.id, {
                permission: e.target.value as McpServerConfig['permission'],
              })
            }
            className="rounded-sm border border-line-subtle bg-bg-raised px-1.5 py-0.5 text-2xs text-fg-primary focus:outline-none"
          >
            <option value="readonly">只读</option>
            <option value="ask">每次问</option>
            <option value="full">完全访问</option>
          </select>
        </label>
      </div>
    </div>
  )
}

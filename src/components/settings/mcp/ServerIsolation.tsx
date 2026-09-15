import type { McpServerConfig } from '@/types/models'

/* ══════════════════════════════════════════════════════════════
   单个 MCP 服务器的隔离设置

   MCP 服务器是**第三方进程**，默认不该拿到主进程的环境变量
   —— 那里面有所有 API Key。所以默认 inheritEnvironment = false，
   白名单只留「让进程能跑起来」的最小集（少了 SystemRoot 之类很多程序起不来）。

   从 McpTab 拆出来的：那边加完这些字段就过 300 行了。
   ══════════════════════════════════════════════════════════════ */

export function ServerIsolation({
  server,
  onChange,
}: {
  server: McpServerConfig
  onChange: (id: string, patch: Partial<McpServerConfig>) => void
}) {
  /*
   * 隔离设置。MCP 服务器是第三方进程，默认不该拿到主进程的环境变量
   * —— 那里面有所有 API Key。白名单默认只留「让进程能跑起来」的最小集。
   */
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line-hairline pt-2">
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
  )
}

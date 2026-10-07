import { Check, Plug, Trash2, X } from 'lucide-react'
import type { McpServerStatus } from '@/types/backend'
import type { McpServerConfig } from '@/types/models'
import { IconButton } from '@/components/ui/IconButton'
import { colorOf } from '@/lib/statusLanguage'
import { ServerIsolation } from '../mcp/ServerIsolation'

/* ══════════════════════════════════════════════════════════════
   设置 → 扩展（MCP）：服务器列表

   从 McpTab.tsx 拆出来的（那边贴到 300 行红线）。
   只负责「把每个服务器画成一行」—— 配置怎么改由 props 传进来的回调决定，
   所以这个文件不认识 store，也不认识内核 API。
   ══════════════════════════════════════════════════════════════ */

export function ServerList({
  servers,
  status,
  onChange,
  onPatch,
  onRestart,
}: {
  servers: McpServerConfig[]
  status: McpServerStatus[]
  onChange: (next: McpServerConfig[]) => void
  onPatch: (id: string, patch: Partial<McpServerConfig>) => void
  onRestart: () => void
}) {
  return (
    <ul className="flex flex-col gap-2 py-2">
      {servers.map((server) => {
        const st = status.find((s) => s.id === server.id)
        return (
          <li
            key={server.id}
            className="rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2"
          >
            <div className="flex items-start gap-2">
              <Plug size={14} className="mt-0.5 shrink-0 text-fg-tertiary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-dense text-fg-primary">{server.name}</span>
                  {st ? (
                    st.alive ? (
                      <span
                        className="flex items-center gap-1 text-2xs"
                        style={{ color: colorOf('completed') }}
                      >
                        <Check size={11} />
                        已连接 · {st.toolCount} 个工具
                      </span>
                    ) : (
                      <span
                        className="flex items-center gap-1 text-2xs"
                        style={{ color: 'var(--error)' }}
                      >
                        <X size={11} />
                        未连接
                      </span>
                    )
                  ) : null}
                </div>
                <p className="mt-0.5 truncate font-mono text-2xs text-fg-tertiary">
                  {server.command} {server.args.join(' ')}
                </p>
                {st?.error ? (
                  <p className="mt-1 break-words text-dense" style={{ color: 'var(--error)' }}>
                    {st.error}
                  </p>
                ) : null}
                {st && st.tools.length > 0 ? (
                  <p className="mt-1 font-mono text-2xs text-fg-tertiary">
                    {st.tools.map((t) => t.name).join(', ')}
                  </p>
                ) : null}

                <ServerIsolation
                  server={server}
                  status={st}
                  onChange={onPatch}
                  onRestart={onRestart}
                />
              </div>
              <IconButton
                label={server.enabled ? '停用' : '启用'}
                size={28}
                onClick={() =>
                  void onChange(
                    servers.map((s) => (s.id === server.id ? { ...s, enabled: !s.enabled } : s)),
                  )
                }
              >
                <span className="text-2xs">{server.enabled ? '启用中' : '已停用'}</span>
              </IconButton>
              <IconButton
                label="删除这个服务器"
                size={28}
                onClick={() => void onChange(servers.filter((s) => s.id !== server.id))}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

import { useEffect, useState } from 'react'
import { Check, Plug, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { McpPreset, McpServerStatus } from '@/types/backend'
import { mcpPresets, mcpRestart, mcpStatus } from '@/lib/extrasApi'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import type { McpServerConfig } from '@/types/models'
import { ServerIsolation } from '../mcp/ServerIsolation'
import { IconButton } from '@/components/ui/IconButton'
import { Row, SectionTitle } from '../parts'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   设置 → 扩展（MCP）

   MCP 服务器是外部进程，通过 stdio 用 JSON-RPC 通信。
   启动时（后台）会把所有启用的服务器拉起来，把它们的工具并进工具清单，
   名字长这样：`mcp__<服务器 id>__<工具名>`。

   命令行用「一行」输入（空格分隔 args）—— 对用户来说比拆成 command + args 数组直观。
   ══════════════════════════════════════════════════════════════ */

export function McpTab() {
  const config = useConfigStore((s) => s.config)
  const patchMcp = useConfigStore((s) => s.patchMcp)
  const showToast = useUIStore((s) => s.showToast)

  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [presets, setPresets] = useState<McpPreset[]>([])
  /* 点预设时记住它要不要用内置 Node —— 添加的时候得写进服务器配置里 */
  const [draftBundledNode, setDraftBundledNode] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftCommand, setDraftCommand] = useState('')

  const servers = config?.mcp.servers ?? []

  async function refreshStatus(): Promise<void> {
    setStatus(await mcpStatus())
  }

  useEffect(() => {
    void refreshStatus()
  }, [])

  /* 预设由内核给（命令行模板唯一真相源在 mcp-presets.cjs，占位符也已填好） */
  useEffect(() => {
    void mcpPresets().then(setPresets)
  }, [])

  function statusOf(id: string): McpServerStatus | undefined {
    return status.find((s) => s.id === id)
  }

  async function restart(): Promise<void> {
    setRestarting(true)
    const next = await mcpRestart()
    setStatus(next)
    setRestarting(false)
    const alive = next.filter((s) => s.alive).length
    showToast(alive > 0 ? 'success' : 'warning', '已重启', `${alive}/${next.length} 个服务器连上了`)
  }

  /*
   * 预设只是把命令行填进草稿 —— 用户还能改，改完照常点「添加」。
   * 名字里的括号说明（「（官方参考服务器）」）去掉，留着当服务器名太长。
   */
  function applyPreset(preset: McpPreset): void {
    setDraftName(preset.name.replace(/（[^）]*）/g, '').trim() || preset.name)
    setDraftCommand(preset.command)
    /* ★ 这条不加就白点了：命令是 `node xxx.js`，但没有这个标志内核不会换成自带的 Node */
    setDraftBundledNode(preset.needs === 'bundled-node')
    setAdding(true)
  }

  async function addServer(): Promise<void> {
    const name = draftName.trim()
    const raw = draftCommand.trim()
    if (!name || !raw) return

    /* 第一个词是命令，后面按空格拆成 args。带空格的参数用引号包起来即可 */
    const parts = raw.match(/"[^"]*"|\S+/g) ?? []
    const command = (parts[0] ?? '').replace(/^"|"$/g, '')
    const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''))

    const id =
      name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 30) || `mcp-${Date.now().toString(36)}`

    await patchMcp([
      ...servers,
      {
        id,
        name,
        command,
        args,
        env: {},
        enabled: true,
        /* 预设是「用内置 Node」那一条时才为 true */
        useBundledNode: draftBundledNode,
        /* 隔离默认值：不继承环境变量、不给网络、工具按写操作对待 */
        inheritEnvironment: false,
        envAllowlist: [],
        cwd: '',
        network: 'ask',
        timeoutMs: 30_000,
        permission: 'ask',
      },
    ])
    setAdding(false)
    setDraftName('')
    setDraftCommand('')
    setDraftBundledNode(false)
    showToast('success', '已添加', '点「重启」让它连上')
  }

  /** 改某个服务器的某个字段 */
  function patchServer(id: string, patch: Partial<McpServerConfig>): void {
    void patchMcp(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  return (
    <div className="py-1">
      <SectionTitle>MCP 服务器</SectionTitle>

      <p className="py-2 text-dense leading-relaxed text-fg-secondary">
        MCP 是外部工具协议。配好之后，这些服务器提供的工具会和内置工具一起给模型用。
        改完配置记得点「重启」。
      </p>

      {servers.length === 0 ? (
        <p className="py-3 text-dense leading-relaxed text-fg-secondary">
          还没有配置服务器。常见的比如文件系统、数据库、浏览器自动化 —— 具体要填什么命令，看那个 MCP
          服务器自己的说明。
        </p>
      ) : (
        <ul className="flex flex-col gap-2 py-2">
          {servers.map((server) => {
            const st = statusOf(server.id)
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
                      <p className="mt-1 break-words text-2xs" style={{ color: 'var(--error)' }}>
                        {st.error}
                      </p>
                    ) : null}
                    {st && st.tools.length > 0 ? (
                      <p className="mt-1 font-mono text-2xs text-fg-tertiary">
                        {st.tools.map((t) => t.name).join(', ')}
                      </p>
                    ) : null}

                    <ServerIsolation server={server} onChange={patchServer} />
                  </div>
                  <IconButton
                    label={server.enabled ? '停用' : '启用'}
                    size={28}
                    onClick={() =>
                      void patchMcp(
                        servers.map((s) =>
                          s.id === server.id ? { ...s, enabled: !s.enabled } : s,
                        ),
                      )
                    }
                  >
                    <span className="text-2xs">{server.enabled ? '启用中' : '已停用'}</span>
                  </IconButton>
                  <IconButton
                    label="删除这个服务器"
                    size={28}
                    onClick={() => void patchMcp(servers.filter((s) => s.id !== server.id))}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {presets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionTitle>内置预设（省得记命令行）</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {presets.map((preset) => (
              <li key={preset.id} className="acrylic-card flex items-start gap-2 p-2">
                <div className="min-w-0 flex-1">
                  <span className="text-dense text-fg-primary">{preset.name}</span>
                  <p className="mt-0.5 text-2xs text-fg-secondary">{preset.description}</p>
                  <p className="mt-1 truncate font-mono text-2xs text-fg-tertiary">
                    {preset.command}
                  </p>
                  <p className="mt-0.5 text-2xs text-fg-tertiary">
                    {preset.needs === 'bundled-node'
                      ? '用应用自带的 Node 跑，不必先装 Node'
                      : '需要系统装了 Node（走 npx）'}
                  </p>
                </div>
                <IconButton
                  label={`用这个预设：${preset.name}`}
                  size={28}
                  onClick={() => applyPreset(preset)}
                >
                  <Plus size={13} />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Row
        label="添加服务器"
        hint="填一行启动命令，比如 npx @modelcontextprotocol/server-filesystem D:\\data"
      >
        {adding ? (
          <div className="flex flex-col gap-2">
            <Field value={draftName} onChange={setDraftName} placeholder="名字，比如：文件系统" />
            <Field
              value={draftCommand}
              onChange={setDraftCommand}
              placeholder="npx -y @modelcontextprotocol/server-filesystem D:\data"
            />
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={() => void addServer()}>
                添加
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => setAdding(true)}
            >
              添加
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={13} />}
              loading={restarting}
              onClick={() => void restart()}
            >
              重启
            </Button>
          </div>
        )}
      </Row>
    </div>
  )
}

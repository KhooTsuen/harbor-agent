import {
  ArrowRightLeft,
  CircleHelp,
  FileImage,
  ImagePlus,
  MessageSquare,
  Minimize2,
  Sparkles,
  Tag,
} from 'lucide-react'
import type { SceneId } from '@/types/backend'
import { SCENES } from '@/constants'
import { useConfigStore } from '@/stores/useConfigStore'
import { Row, SectionTitle } from '../parts'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
    模型与场景 —— 八个场景各挑模型 + 自动路由 + 失败处理

    ── 第三阶段：从「对话与任务」页搬进来 ────────────────────────
    场景模型、路由、重试/回退说的都是**用哪个模型**，原来却和
    「回车发送」「生图存哪」挤在一页。搬到这里之后，模型相关的
    配置只有「模型与服务商」这一个入口。

    ── 上下文压缩阈值搬走了 ──────────────────────────────────────
    原来这一页末尾还有「压缩阈值（提示 / 自动）」—— 那是**上下文**
    的事，搬去了「上下文与项目 → 压缩」（见 CompactThresholdRow）。

    ── 四个概念必须分得开 ────────────────────────────────────────
      · 手动选择   上面「当前使用」里选的那个模型（默认路径）
      · 场景指定   这里八格，留空 = 用默认聊天模型
      · 自动路由   按任务类型换模型（默认关）
      · 失败回退   这家挂了换另一家（默认关）
    后两个都要用户主动打开才生效 —— 界面重构不动这个默认值。
    ══════════════════════════════════════════════════════════════ */

const ICONS: Record<SceneId, typeof MessageSquare> = {
  chat: MessageSquare,
  title: Tag,
  prompt: Sparkles,
  translate: ArrowRightLeft,
  suggest: CircleHelp,
  compact: Minimize2,
  ocr: FileImage,
  image: ImagePlus,
}

export function ScenesPanel(): React.ReactElement {
  const config = useConfigStore((s) => s.config)
  const patchRouter = useConfigStore((s) => s.patchRouter)
  const patchFallback = useConfigStore((s) => s.patchFallback)
  const patchScene = useConfigStore((s) => s.patchScene)

  if (!config) {
    return (
      <p className="py-3 text-dense leading-relaxed text-fg-tertiary">
        当前运行在浏览器预览环境；场景模型与路由配置请在桌面版中使用。
      </p>
    )
  }

  const providers = config.providers.filter((p) => p.models.length > 0)
  const fallbackModel = config.assistant.model

  return (
    <div className="flex flex-col gap-2 py-1">
      <SectionTitle hint="每个场景可以单独指定模型；留空就用上面的默认聊天模型">
        场景模型
      </SectionTitle>
      <p className="px-1 text-dense leading-relaxed text-fg-tertiary">
        值得分的原因：起标题、翻译这种活，用主力大模型是纯浪费；而 OCR 必须要能读图的模型。
      </p>

      <div className="grid grid-cols-1 gap-3 pt-1 xl:grid-cols-2">
        {SCENES.map((scene) => {
          const Icon = ICONS[scene.id]
          const chosen = config.scenes[scene.id]
          const value =
            chosen.providerId && chosen.model ? `${chosen.providerId}|${chosen.model}` : ''

          return (
            <div key={scene.id} className="acrylic-card flex flex-col">
              <div className="flex items-start gap-2">
                <Icon size={14} className="mt-0.5 shrink-0 text-fg-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-dense text-fg-primary">{scene.label}</p>
                  <p className="mt-0.5 text-dense leading-relaxed text-fg-tertiary">{scene.hint}</p>
                </div>
              </div>

              <select
                value={value}
                onChange={(e) => {
                  const [providerId, model] = e.target.value.split('|')
                  void patchScene(scene.id, { providerId: providerId ?? '', model: model ?? '' })
                }}
                aria-label={`${scene.label}用哪个模型`}
                className="mt-2.5 w-full rounded-base border border-line-hairline bg-bg-input px-2.5 py-1.5 font-mono text-2xs text-fg-primary focus:border-line-focus focus:outline-none"
              >
                <option value="">
                  {scene.id === 'image'
                    ? '未设置（图像生成必须单独配）'
                    : `用默认（${fallbackModel}）`}
                </option>
                {providers.map((provider) => (
                  <optgroup
                    key={provider.id}
                    label={provider.enabled ? provider.name : `${provider.name}（已停用）`}
                  >
                    {provider.models.map((model) => (
                      <option key={model} value={`${provider.id}|${model}`}>
                        {model}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <p className="mt-1.5 text-dense text-fg-tertiary">
                {scene.requirement ? (
                  <span style={{ color: colorOf('warning') }}>⚠ {scene.requirement}</span>
                ) : chosen.providerId && chosen.model ? (
                  '已单独指定'
                ) : (
                  scene.fallbackHint
                )}
              </p>
            </div>
          )
        })}
      </div>

      {/* ══════════════════════════════════════════════════════
          高级：自动路由 / 失败处理
          默认都关，所以放最后 —— 不配也能正常用。
         ══════════════════════════════════════════════════════ */}

      <SectionTitle hint="默认关闭：不打开就永远用你手动选的那个模型">自动路由</SectionTitle>
      <Row
        label="按任务类型换模型"
        hint="起标题、翻译走便宜模型；规划和改代码走强模型。默认关 —— 自动换模型如果不透明，用户会觉得「回答风格怎么变了」。开了之后每轮会在状态栏标出用了谁。"
      >
        <label className="flex items-center gap-2 text-dense text-fg-primary">
          <input
            type="checkbox"
            checked={config.router?.enabled === true}
            onChange={(e) => void patchRouter({ enabled: e.target.checked })}
            aria-label="按任务类型换模型"
          />
          {config.router?.enabled === true ? '已开启（会自动换）' : '已关闭（只用你选的）'}
        </label>
      </Row>

      {config.router?.enabled ? (
        <div className="flex flex-col gap-2 pb-2">
          {(
            [
              ['fast', '快模型', '日常问答'],
              ['reasoning', '推理模型', '规划、分析、为什么'],
              ['coding', '代码模型', '改代码、修 bug'],
              ['vision', '视觉模型', '读图、OCR'],
              ['cheap', '便宜模型', '标题、翻译、摘要'],
            ] as const
          ).map(([role, label, hint]) => (
            <Row key={role} label={label} hint={hint}>
              <input
                value={config.router.roles?.[role] ?? ''}
                onChange={(e) =>
                  void patchRouter({ roles: { ...config.router.roles, [role]: e.target.value } })
                }
                placeholder="模型名，或 providerId/模型名（留空 = 用默认）"
                spellCheck={false}
                aria-label={`${label}用哪个`}
                className="w-full rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
              />
            </Row>
          ))}
        </div>
      ) : null}

      <SectionTitle hint="默认关闭：不打开就绝不偷偷换供应商">失败处理</SectionTitle>
      <Row
        label="同一家内自动重试次数"
        hint="只对「值得重试」的错误生效：网络抖动、超时、限流、对方 5xx。认证失败（401）和上下文超限不重试 —— 重试一万次也不会变好。"
      >
        <input
          type="number"
          min={0}
          max={5}
          value={config.fallback?.attempts ?? 2}
          onChange={(e) => void patchFallback({ attempts: Number(e.target.value) || 0 })}
          aria-label="自动重试次数"
          className="w-20 rounded-sm border border-line-subtle bg-bg-input px-2 py-1 font-mono text-dense text-fg-primary focus:outline-none"
        />
      </Row>
      {/*
        跨供应商降级（默认关）。以前它默认开着而且这里没有开关 —— 用户选 DeepSeek 却
        可能收到别家的回复，界面上只弹一句「已换用一个供应商」，事后也无从查起。
      */}
      <Row
        label="失败后换用其他供应商"
        hint="关着时：这家失败了就一直报错，绝不偷偷换人。开着时：这家彻底不行了才换成你配置里的另一家（要它真的提供同一个模型）。认证失败和请求参数错误不会触发切换 —— 换一家也一样错，只会把真问题盖住。"
      >
        <label className="flex items-center gap-2 text-dense text-fg-primary">
          <input
            type="checkbox"
            checked={config.fallback?.enabled === true}
            onChange={(e) => void patchFallback({ enabled: e.target.checked })}
            aria-label="失败后换用其他供应商"
          />
          {config.fallback?.enabled === true ? '已开启（会换人）' : '已关闭（只用你选的那家）'}
        </label>
      </Row>
    </div>
  )
}

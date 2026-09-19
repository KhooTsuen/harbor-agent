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
   设置 → 默认模型与提示词

   八个场景，每个可以单独挑模型。
   留空就用默认聊天模型 —— 所以这一页可以完全不管，功能照样跑。

   为什么值得分：起标题、翻译这种活儿，用主力大模型是纯浪费；
   而 OCR 必须要能读图的模型，普通模型给它图也白给。
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

export function ScenesTab() {
  const config = useConfigStore((s) => s.config)
  const patchRouter = useConfigStore((s) => s.patchRouter)
  const patchFallback = useConfigStore((s) => s.patchFallback)
  const patchContext = useConfigStore((s) => s.patchContext)
  const patchScene = useConfigStore((s) => s.patchScene)

  if (!config) {
    return (
      <p className="py-3 text-2xs leading-relaxed text-fg-tertiary">
        当前运行在浏览器预览环境；场景模型与路由配置请在桌面版中使用。
      </p>
    )
  }

  const providers = config.providers.filter((p) => p.models.length > 0)
  const fallbackModel = config.assistant.model

  return (
    <div className="py-1">
      <SectionTitle>默认模型与提示词</SectionTitle>
      <p className="py-2 text-dense leading-relaxed text-fg-secondary">
        每个场景可以单独指定模型。**留空就用默认聊天模型** —— 所以这一页不管也能用，只是没得省。
      </p>

      <div className="grid grid-cols-1 gap-3 pt-1 xl:grid-cols-2">
        {SCENES.map((scene) => {
          const Icon = ICONS[scene.id]
          const chosen = config.scenes[scene.id]
          const value =
            chosen.providerId && chosen.model ? `${chosen.providerId}|${chosen.model}` : ''

          return (
            <div key={scene.id} className="acrylic-card rounded-base flex flex-col p-3">
              <div className="flex items-start gap-2">
                <Icon size={14} className="mt-0.5 shrink-0 text-fg-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-dense text-fg-primary">{scene.label}</p>
                  <p className="mt-0.5 text-2xs leading-relaxed text-fg-tertiary">{scene.hint}</p>
                </div>
              </div>

              <select
                value={value}
                onChange={(e) => {
                  const [providerId, model] = e.target.value.split('|')
                  void patchScene(scene.id, { providerId: providerId ?? '', model: model ?? '' })
                }}
                aria-label={`${scene.label}用哪个模型`}
                className="mt-2.5 w-full rounded-base border border-line-hairline bg-bg-surface px-2.5 py-1.5 font-mono text-2xs text-fg-primary focus:border-line-focus focus:outline-none"
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

              <p className="mt-1.5 text-2xs text-fg-tertiary">
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
          高级：路由 / 重试 / 上下文预算
          默认值都能用，所以放在最后 —— 不配也行。
         ══════════════════════════════════════════════════════ */}

      <SectionTitle>模型路由</SectionTitle>
      <Row
        label="按任务类型换模型"
        hint="起标题、翻译走便宜模型；规划和改代码走强模型。默认关闭 —— 自动换模型如果不透明，用户会觉得「回答风格怎么变了」。开了之后每轮会在上面那条状态栏标出用了谁。"
      >
        <label className="flex items-center gap-2 text-dense text-fg-primary">
          <input
            type="checkbox"
            checked={config?.router?.enabled === true}
            onChange={(e) => void patchRouter({ enabled: e.target.checked })}
          />
          启用路由
        </label>
      </Row>

      {config?.router?.enabled ? (
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
                className="w-full rounded-sm border border-line-subtle bg-bg-raised px-2 py-1.5 font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
              />
            </Row>
          ))}
        </div>
      ) : null}

      <SectionTitle>失败处理</SectionTitle>
      <Row
        label="自动重试次数"
        hint="只对「值得重试」的错误生效：网络抖动、超时、限流、对方 5xx。认证失败（401）和上下文超限不重试 —— 重试一万次也不会变好。"
      >
        <input
          type="number"
          min={0}
          max={5}
          value={config?.fallback?.attempts ?? 2}
          onChange={(e) => void patchFallback({ attempts: Number(e.target.value) || 0 })}
          className="w-20 rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 font-mono text-dense text-fg-primary focus:outline-none"
        />
      </Row>

      <SectionTitle>上下文预算</SectionTitle>
      <Row
        label="压缩阈值"
        hint="用到上下文窗口的多少比例时压缩。到「提示」会提醒你手动 /compact；到「自动」会后台压一次，不打断当前对话。"
      >
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
            提示
            <input
              type="number"
              min={10}
              max={90}
              value={Math.round((config?.context?.compactAt ?? 0.4) * 100)}
              onChange={(e) =>
                void patchContext({ compactAt: (Number(e.target.value) || 40) / 100 })
              }
              className="w-16 rounded-sm border border-line-subtle bg-bg-raised px-1.5 py-0.5 font-mono text-2xs text-fg-primary focus:outline-none"
            />
            %
          </label>
          <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
            自动
            <input
              type="number"
              min={20}
              max={95}
              value={Math.round((config?.context?.autoCompactAt ?? 0.6) * 100)}
              onChange={(e) =>
                void patchContext({ autoCompactAt: (Number(e.target.value) || 60) / 100 })
              }
              className="w-16 rounded-sm border border-line-subtle bg-bg-raised px-1.5 py-0.5 font-mono text-2xs text-fg-primary focus:outline-none"
            />
            %
          </label>
        </div>
      </Row>
    </div>
  )
}

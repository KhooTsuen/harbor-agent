import { useState } from 'react'
import { ArrowRight, Check, FolderOpen, KeyRound, Sparkles, X } from 'lucide-react'
import type { AppConfig } from '@/types/backend'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { Button } from '@/components/ui/Button'
import { DoneStep } from './DoneStep'
import { Field } from '@/components/ui/Field'
import { DEFAULT_PRESET, PRESETS } from './presets'
import { StepDots, type Step } from './StepDots'
import { colorOf, statusOfTool } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   首次启动引导

   为什么需要：软件打开是个空壳，不配 API Key 什么都干不了。老用户知道
   去哪填，新用户会卡在「输入框发不出去消息」这一步。

   四个步骤，但可以在第二步就跳出去 —— 有人就是想自己翻设置。
   跳过也算走完（写 onboarded），不然每次开机都弹。
   ══════════════════════════════════════════════════════════════ */

export function Onboarding({ config }: { config: AppConfig }) {
  const [step, setStep] = useState<Step>('welcome')
  const [presetId, setPresetId] = useState('deepseek')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_PRESET.baseUrl)
  const [model, setModel] = useState(DEFAULT_PRESET.model)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)
  const [workdir, setWorkdir] = useState('')
  const [saving, setSaving] = useState(false)

  const updateProvider = useConfigStore((s) => s.updateProvider)
  const patchGeneral = useConfigStore((s) => s.patchGeneral)
  const testProvider = useConfigStore((s) => s.testProvider)
  const chooseWorkdirFromStore = useConfigStore((s) => s.chooseWorkdir)
  const showToast = useUIStore((s) => s.showToast)
  const setInput = useThreadStore((s) => s.setInput)

  const preset = PRESETS.find((p) => p.id === presetId) ?? DEFAULT_PRESET
  const isCustom = presetId === 'custom'

  function choosePreset(id: string): void {
    const next = PRESETS.find((p) => p.id === id)
    if (!next) return
    setPresetId(id)
    setBaseUrl(next.baseUrl)
    setModel(next.model)
    setTested(null)
  }

  /** 第一个供应商就是引导要填的那个（默认配置里本来就有 DeepSeek 一条） */
  const target = config.providers[0]

  /** 把当前填的东西写进配置 —— 「测试连接」和「下一步」都要用到 */
  async function saveProvider(): Promise<void> {
    if (!target) return
    /* 不改 id：会话和助手里都引用了它，改了会连不上 */
    await updateProvider(target.id, {
      name: preset.name,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      models: model.trim() ? [model.trim()] : target.models,
    })
  }

  async function test(): Promise<void> {
    if (!apiKey.trim() || !baseUrl.trim()) {
      setTested({ ok: false, text: '地址和 Key 都要填' })
      return
    }
    setTesting(true)
    setTested(null)
    await saveProvider()
    const result = await testProvider(target?.id)
    setTesting(false)
    setTested(
      result.ok
        ? { ok: true, text: `通了，模型回话：${result.model ?? '（空）'}` }
        : { ok: false, text: result.error ?? '连不上' },
    )
  }

  async function chooseWorkdir(): Promise<void> {
    const ok = await chooseWorkdirFromStore()
    if (ok) setWorkdir(useConfigStore.getState().workdir)
  }

  async function finish(): Promise<void> {
    setSaving(true)
    await patchGeneral({
      workdir: workdir || config.general.workdir,
      onboarded: true,
      onboardingDismissed: true,
    })
    setSaving(false)
    showToast('success', '设置好了', '开始用吧')
  }

  async function startSafeExample(): Promise<void> {
    await finish()
    setInput('请只读检查当前工作目录：列出顶层文件，并告诉我你建议先从哪里开始。不要修改任何文件。')
  }

  async function skip(): Promise<void> {
    await patchGeneral({ onboarded: true, onboardingDismissed: true })
    showToast('info', '已跳过', '之后可以在设置里配')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="首次启动引导"
    >
      <div className="w-[min(560px,92vw)] rounded-lg border border-line-subtle bg-bg-raised p-6 shadow-xl">
        {/* 顶部：步骤点 + 跳过 */}
        <div className="mb-5 flex items-center justify-between">
          <StepDots current={step} />
          <button
            type="button"
            onClick={() => void skip()}
            className="flex items-center gap-1 text-2xs text-fg-tertiary transition-colors hover:text-fg-primary"
          >
            <X size={12} />
            跳过，我自己配
          </button>
        </div>

        {step === 'welcome' ? (
          <>
            <Sparkles size={26} className="mb-3 text-fg-secondary" />
            <h1 className="text-lg text-fg-primary">先配一下模型</h1>
            <p className="mt-2 text-dense leading-relaxed text-fg-secondary">
              这个软件自己不会思考，它要连一个模型服务。接下来会完成三件事：连接模型、选择工作目录、用一条只读示例任务确认一切正常。所有东西都存在软件自己的文件夹里，密钥会交给系统凭证库保存。
            </p>
            <div className="mt-5 flex justify-end">
              <Button
                variant="primary"
                icon={<ArrowRight size={14} />}
                onClick={() => setStep('provider')}
              >
                开始
              </Button>
            </div>
          </>
        ) : null}

        {step === 'provider' ? (
          <>
            <h1 className="text-lg text-fg-primary">选模型服务</h1>
            <p className="mt-1.5 text-dense leading-relaxed text-fg-secondary">
              挑一家，把它的 API Key 粘进来。Key
              会交给系统凭证库保存，不会发给除这家服务之外的任何人。
            </p>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choosePreset(p.id)}
                  className="rounded-base border px-2.5 py-1 text-2xs transition-colors"
                  style={{
                    borderColor:
                      presetId === p.id ? 'var(--border-focus)' : 'var(--border-hairline)',
                    color: presetId === p.id ? 'var(--border-focus)' : 'var(--text-secondary)',
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-3">
              {isCustom ? (
                <label className="block">
                  <span className="mb-1 block text-2xs text-fg-tertiary">接口地址（baseUrl）</span>
                  <Field
                    value={baseUrl}
                    onChange={setBaseUrl}
                    placeholder="https://example.com/v1"
                  />
                </label>
              ) : null}

              <label className="block">
                <span className="mb-1 block text-2xs text-fg-tertiary">API Key</span>
                <Field type="password" value={apiKey} onChange={setApiKey} placeholder="sk-..." />
              </label>

              <label className="block">
                <span className="mb-1 block text-2xs text-fg-tertiary">模型名</span>
                <Field value={model} onChange={setModel} placeholder={preset.model || 'gpt-4o'} />
                <span className="mt-1 block text-2xs text-fg-tertiary">
                  填错了也能改，之后在「设置 → 模型」里。
                </span>
              </label>
            </div>

            {tested ? (
              <p
                className="mt-3 flex items-start gap-1.5 text-2xs"
                style={{ color: colorOf(statusOfTool(tested.ok)) }}
                role="status"
              >
                {tested.ok ? <Check size={12} className="mt-0.5 shrink-0" /> : null}
                <span className="break-words">{tested.text}</span>
              </p>
            ) : null}

            <div className="mt-5 flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                icon={<KeyRound size={13} />}
                loading={testing}
                onClick={() => void test()}
              >
                测试连接
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStep('welcome')}>
                  上一步
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<ArrowRight size={13} />}
                  onClick={() =>
                    void (async () => {
                      await saveProvider()
                      setStep('workdir')
                    })()
                  }
                >
                  下一步
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {step === 'workdir' ? (
          <>
            <h1 className="text-lg text-fg-primary">选个工作目录</h1>
            <p className="mt-1.5 text-dense leading-relaxed text-fg-secondary">
              模型的读写操作都限制在这个目录里。不选也行，会用软件自带的 workspace。
            </p>

            <div className="mt-4 flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate rounded-base border border-line-hairline bg-bg-surface px-3 py-2 font-mono text-2xs text-fg-secondary">
                {workdir || '（用默认 workspace）'}
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<FolderOpen size={13} />}
                onClick={() => void chooseWorkdir()}
              >
                选目录
              </Button>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep('provider')}>
                上一步
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<ArrowRight size={13} />}
                onClick={() => setStep('done')}
              >
                下一步
              </Button>
            </div>
          </>
        ) : null}

        {step === 'done' ? (
          <DoneStep
            saving={saving}
            onFinish={() => void finish()}
            onSafeExample={() => void startSafeExample()}
          />
        ) : null}
      </div>
    </div>
  )
}

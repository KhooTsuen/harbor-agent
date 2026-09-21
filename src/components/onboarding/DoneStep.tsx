import type { ReactElement } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { colorOf } from '@/lib/statusLanguage'

/**
 * 首次引导的最后一步。
 *
 * 从 Onboarding.tsx 抽出来的（那边贴到 300 行上限了）：
 * 这一步是自成一体的「收尾」——两个出口（直接开始 / 先跑一条只读示例），
 * 不碰配置，只把回调抛回去。
 */
export function DoneStep({
  saving,
  onFinish,
  onSafeExample,
}: {
  saving: boolean
  onFinish: () => void
  onSafeExample: () => void
}): ReactElement {
  return (
    <>
      <Check size={26} className="mb-3" style={{ color: colorOf('completed') }} />
      <h1 className="text-lg text-fg-primary">可以开始了</h1>
      <p className="mt-2 text-dense leading-relaxed text-fg-secondary">
        配置已经完成。建议先发送一条只读示例，让 Agent 列出工作目录并给出建议；
        它不会修改文件，后续需要写入时仍会先征求你的确认。
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" loading={saving} onClick={onFinish}>
          直接开始
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<ArrowRight size={13} />}
          loading={saving}
          onClick={onSafeExample}
        >
          填入安全示例
        </Button>
      </div>
    </>
  )
}

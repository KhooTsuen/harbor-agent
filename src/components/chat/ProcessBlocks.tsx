import { useSmoothText } from '@/hooks/useSmoothText'
import { ReasoningBlock } from './message/ReasoningBlock'

/** Historical rounds share the same reasoning surface as native ordered records. */
export function ThinkBlock({
  text,
  streaming = false,
  hideCount = false,
}: {
  text: string
  streaming?: boolean
  hideCount?: boolean
}) {
  const smooth = useSmoothText(text, streaming)
  return (
    <ReasoningBlock
      text={smooth}
      active={streaming}
      count={hideCount ? undefined : smooth.length}
    />
  )
}

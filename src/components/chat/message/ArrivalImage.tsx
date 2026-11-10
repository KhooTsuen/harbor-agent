import { useState } from 'react'
import { useAnswerMotion } from './AnswerSurface'

const dimensions = new Map<string, { width: number; height: number }>()

export function ArrivalImage({
  src,
  alt,
  className = '',
  onOpen,
}: {
  src: string
  alt: string
  className?: string
  onOpen?: () => void
}) {
  const known = dimensions.get(src)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [size, setSize] = useState(known)
  const motion = useAnswerMotion()
  return (
    <span
      className="flow-image-arrival"
      data-image-state={state}
      data-live-arrival={motion && state === 'ready' ? 'true' : undefined}
      style={size ? { aspectRatio: `${size.width} / ${size.height}` } : undefined}
    >
      {state === 'loading' ? <span className="flow-image-note">正在载入图片</span> : null}
      {state === 'failed' ? <span className="flow-image-note">图片未能加载</span> : null}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        data-chat-image="true"
        className={className}
        width={size?.width}
        height={size?.height}
        onClick={onOpen}
        onLoad={(event) => {
          const image = event.currentTarget
          const next = { width: image.naturalWidth, height: image.naturalHeight }
          if (dimensions.size >= 32) dimensions.clear()
          dimensions.set(src, next)
          setSize(next)
          setState('ready')
        }}
        onError={() => setState('failed')}
      />
    </span>
  )
}

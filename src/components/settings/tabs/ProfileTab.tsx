import { Row, SectionTitle } from '../parts'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { useProfileStore, initialOf } from '@/stores/useProfileStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   个人资料（名字 + 头像）

   侧栏左下角那个圆显示的就是这里设的东西。原来它是**写死的装饰**
   （一个圆里一个「我」字，点了没反应），这是那个功能的接口。

   头像走系统选图框 → 主进程存 `data/avatars/avatar.<ext>`（不塞进 config，
   也不上传）；名字直接进配置。

   ── 第二阶段：加一块「实际长这样」的预览 ──────────────────────
   以前改名字/头像要盯着右上角那个小圆才能确认效果，眼睛得来回跳。
   现在头像那块直接按侧栏的真实排布画一遍（同样的圆、同样的字号、
   同样的省略规则）—— 这就是所见即所得，不是另做一套视觉。
   ══════════════════════════════════════════════════════════════ */

export function ProfileTab(): React.ReactElement {
  const name = useProfileStore((s) => s.name)
  const avatar = useProfileStore((s) => s.avatar)
  const setName = useProfileStore((s) => s.setName)
  const pickAvatar = useProfileStore((s) => s.pickAvatar)
  const clearAvatar = useProfileStore((s) => s.clearAvatar)
  const showToast = useUIStore((s) => s.showToast)

  const display = name.trim() || '我'

  return (
    <>
      <SectionTitle hint="只影响显示，不参与对话，也不会上传任何东西">这是你自己</SectionTitle>

      <Row
        label="头像"
        hint="选一张图（最大 4 MB）。存在本机 data/avatars/，不会上传；不设就用名字首字"
      >
        <div className="flex items-center gap-3">
          {/* 预览就是用侧栏那个圆的样式 —— 所见即所得 */}
          <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-pill bg-bg-raised text-sm font-semibold text-fg-secondary">
            {avatar ? (
              <img src={avatar} alt="当前头像" className="size-full object-cover" />
            ) : (
              initialOf(name)
            )}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void (async () => {
                const error = await pickAvatar()
                if (error) showToast('error', '没能设置头像', error)
              })()
            }}
          >
            {avatar ? '换一张' : '选择图片'}
          </Button>
          {avatar ? (
            <Button variant="ghost" size="sm" onClick={clearAvatar}>
              移除
            </Button>
          ) : null}
        </div>
      </Row>

      <Row label="名字" hint="显示在侧栏左下角；留空就显示「我」">
        <Field
          value={name}
          onChange={setName}
          placeholder="比如：小王"
          maxLength={40}
          aria-label="你的名字"
        />
      </Row>

      <SectionTitle hint="侧栏左下角就是这个样子；名字太长会截断">侧栏里长这样</SectionTitle>

      {/* 按侧栏的真实排布画一遍：圆 + 名字 + 右上角状态点 */}
      <div className="acrylic-card flex items-center gap-2.5">
        <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-pill bg-bg-raised text-xs font-semibold text-fg-secondary">
          {avatar ? (
            <img src={avatar} alt="" className="size-full object-cover" />
          ) : (
            initialOf(name)
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-dense text-fg-primary">{display}</span>
        <span className="shrink-0 text-2xs text-fg-secondary">本机</span>
      </div>
    </>
  )
}

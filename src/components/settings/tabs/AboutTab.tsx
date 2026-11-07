import { APP_VERSION } from '@/lib/backend'
import { BRAND_NAME } from '@/constants'
import { Button } from '@/components/ui/Button'
import { useUIStore } from '@/stores/useUIStore'
import { Row, SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   设置 → 关于 Harbor

   ── 第二阶段：从「一段散文」改成「能查、能抄的信息」────────────
   以前是四段说明文字堆在一起，想知道版本号要在一堆话里找，想报
   问题也没法把环境信息一次拷出来。现在分成两块：

     · 版本与环境   版本号 + 运行形态 + 一句话介绍，带「复制」按钮
     · 数据与许可   数据放哪、依赖许可清单

   ★ 只放**真实存在**的信息。不显示构建号（渲染层拿不到，写了就是
     硬编码的假值）、不显示「已是最新版本」（没有更新检查就别暗示有）。
   ══════════════════════════════════════════════════════════════ */

const DEPENDENCIES = [
  'React · MIT',
  'Vite · MIT',
  'Tailwind CSS · MIT',
  'Zustand · MIT',
  'Framer Motion · MIT',
  'Lucide · ISC',
  'Electron · MIT',
]

export function AboutTab() {
  const showToast = useUIStore((s) => s.showToast)

  /* 报问题时一次拷全，省得反复问「你什么版本、什么形态」 */
  const copyVersion = (): void => {
    const text = `${BRAND_NAME} ${APP_VERSION}`
    void (async () => {
      try {
        await navigator.clipboard.writeText(text)
        showToast('success', '已复制', text)
      } catch {
        showToast('error', '复制失败', '可以直接手动选中上面的版本号')
      }
    })()
  }

  return (
    <>
      <SectionTitle hint="报问题时请带上这个版本号">版本</SectionTitle>

      <Row label={BRAND_NAME} hint="本地优先的个人 AI Agent 工作台">
        <div className="flex items-center gap-3">
          <span className="font-mono text-dense text-fg-primary">{APP_VERSION}</span>
          <Button variant="secondary" size="sm" onClick={copyVersion}>
            复制版本信息
          </Button>
        </div>
      </Row>

      <Row label="它是怎么工作的" hint="这一句决定了「你的数据为什么安全」">
        <p className="text-dense leading-relaxed text-fg-secondary">
          文件、命令和模型请求都走本机主进程；界面是 React，两边通过白名单桥通信。
          对话、记忆、配置全部存在本机文件夹里，不经过任何中转服务器。
        </p>
      </Row>

      <SectionTitle hint="删掉整个文件夹就等于卸载">数据放在哪</SectionTitle>

      <Row label="数据目录" hint="全部在软件目录下的 data/ 里">
        <div className="flex flex-col gap-1 text-dense leading-relaxed text-fg-secondary">
          <span>
            <code className="font-mono text-fg-primary">config.json</code> —— 设置
          </span>
          <span>
            <code className="font-mono text-fg-primary">sessions/</code> —— 会话（每会话一个文件）
          </span>
          <span>
            <code className="font-mono text-fg-primary">logs/</code> —— 运行日志
          </span>
          <span className="text-fg-secondary">想换到别的盘，在「数据与存储」页改数据目录。</span>
        </div>
      </Row>

      <SectionTitle hint="完整改动记录在仓库根目录的 CHANGELOG.md">更新日志</SectionTitle>

      <Row label="每个版本改了什么" hint="包括「为什么改」——不只是功能列表">
        <p className="text-dense leading-relaxed text-fg-secondary">
          每一项都写清了来由。这里不再重复列条目：以前那版只写「0.1.0 首个版本」，
          改了三十个版本也没动过，比不写更误导。
        </p>
      </Row>

      <SectionTitle hint="都能在各自仓库里核对">开源许可</SectionTitle>

      <div className="acrylic-card">
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-dense text-fg-secondary">
          {DEPENDENCIES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </>
  )
}

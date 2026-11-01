import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, XCircle } from 'lucide-react'
import { formatDuration, processEntry, type ProcessHeaderInput } from '@/lib/processSummary'
import { colorOf } from '@/lib/statusLanguage'
import { useScrollStore } from '@/stores/useScrollStore'
import { useScrollGuard } from './scrollGuard'
import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   过程折叠区

   ── 它解决什么 ────────────────────────────────────────────────

   以前思考块、工具行、正文是**按时间顺序全部平铺**的（见 MessageRounds）。
   长任务跑 24 步时，用户要滚过几十行工具摘要才能看到结论 ——「最终回答是阅读主体」
   这条根本不成立。

   现在：**回复默认只给一行入口**，思考与工具都收在里面；展开按真实发生顺序看，
   原始输出还能再逐项展开。

   ── 四条不许省的东西 ──────────────────────────────────────────

    ① **失败要露在入口上**（图2 验收表分两档，别混成一档）：
       整轮没成（status=error / 每一步都失败）→「失败 · N 个步骤」+ 红叉；
       任务成了、中间失手过 →「N 个步骤 · 含 M 项失败」，**不给红叉** ——
       答案已经出来了，把入口画成失败等于谎报没完成。
   ② **中断要露出来**：`interrupted` 时入口写「已中断」，且不显示用时。
   ③ **跑的时候入口恒定是「实时任务」**（2026-10-21 用户拍板，第二版）：
      步骤数、思考字数、用时**跑的时候一概不报** —— 它们每来一个事件就变一次字，
      整行入口跟着跳。用户在展开区里看实时活动，步骤数等跑完再一次性算。
      展开区末尾那行「正在读取 3 个文件」才是「现在在干什么」。
   ④ **没有过程就不显示入口**：纯问答不出现空的入口（由调用方保证）。

   ⑤ **「实时任务」上有一道流光**（2026-10-21 用户给的视觉口径）：
      只在 `running` 时挂 `.process-live`（见 index.css）—— 一段窄高光
      每隔 2.4 秒横向扫过一次；文字**不拆字、不变透明度**，所以既不逐字跳
      也不忽明忽暗。跑完 / 中断 / 失败 / 重开历史时这个类不在，入口就是静态文字
      （动画随 class 一起消失，不需要收尾）；关动效或系统「减少动态」时
      CSS 直接撤掉渐变，回到普通静态文字。

   ── 展开区里有什么 ────────────────────────────────────────────

     · 完成态第一行：`用时 31 秒`（入口不再承担这个信息，但也不该丢）
     · `children`：思考 + 工具明细，按真实发生顺序
     · `activity`：运行中那一行「正在等待模型回应…」/「正在读取 main.ts」

   ── 默认展开 ──────────────────────────────────────────────────
   失败与中断**默认是展开的**（`defaultOpen`）：入口文案说明状态，过程仍然一眼可见 ——
   「需要用户注意的状态不能被默认折叠」这条从没松开过。
   用户点过之后就听用户的（`manual` 优先）。
   ══════════════════════════════════════════════════════════════ */

/*
 * 入口文案的实现在 `@/lib/processSummary`（导出与复制完整记录也用同一份）；
 * 这里转出去，是为了让 `processPanel.test.ts` 继续直接测它。
 */
export { formatDuration, processHeaderText, PROCESS_RUNNING_LABEL } from '@/lib/processSummary'

export function ProcessPanel({
  message,
  runs,
  children,
  activity,
  defaultOpen = false,
  threadId,
  messageId,
}: {
  message: ProcessHeaderInput
  runs: readonly ToolRunRecord[]
  /** 展开后的内容（思考块 + 工具明细，按真实发生顺序） */
  children: React.ReactNode
  /** 运行中的「现在在干什么」那一行 —— 排在最末（最新发生） */
  activity?: React.ReactNode
  /** 失败 / 中断时传 true：过程默认可见，入口仍然在 */
  defaultOpen?: boolean
  /**
   * 这条过程属于哪条对话的哪条消息。给了就按它把**用户手动展开 / 折叠**记进
   * `useScrollStore`：切到别的对话时整棵树卸载，组件本地 state 必然丢 ——
   * 那正是「切走再回来，展开的过程又收起来了」的原因。没给（单测直接渲染本组件）
   * 就退回本地 state，行为与以前一致。
   */
  threadId?: string
  messageId?: string
}) {
  /*
   * `null` = 用户还没表态 → 听 `defaultOpen`；点过一次之后以点击为准。
   * 不用 useEffect 同步：running → 完成那一刻不改写用户的选择。
   */
  const [localOpen, setLocalOpen] = useState<boolean | null>(null)
  const storeKey = threadId && messageId ? `${threadId}:${messageId}` : ''
  const remembered = useScrollStore((s) => (storeKey ? s.processOpen[storeKey] : undefined))
  const setProcessOpen = useScrollStore((s) => s.setProcessOpen)
  /* 没留痕（含失败 / 中断）→ 一律听 defaultOpen：异常态默认展开这条规矩不动 */
  const open = storeKey ? (remembered ?? defaultOpen) : (localOpen ?? defaultOpen)
  const guard = useScrollGuard()
  /*
   * 状态文案的 id：入口按钮上挂 `aria-describedby` 指过来，
   * 读屏会念「查看过程，实时任务」——**状态读得到，但不靠动画**。
   * 文字本身是常量（`PROCESS_RUNNING_LABEL`），不会随过程增长改写，
   * 所以这里没有 aria-live，也就不会每轮动画重复播报。
   */
  const liveStatusId = useId()
  /*
   * ★ 红叉只在**整轮没成**时出现（图2 验收表）：
   *   中间失手一次、后来重试成功、回答正常 —— 那是「含 N 项失败」，
   *   给红叉等于把完成了的任务画成失败。
   *   运行中也不亮红叉：入口要稳定，红叉出现/消失也是一种跳。
   */
  const entry = processEntry(message, runs)
  const failed = !message.running && entry.taskFailed
  const text = entry.text
  /* 运行中才有流光；结束时这个类直接不在 → 动画停止，回到静态文字 */
  const running = message.running === true
  const elapsedMs = message.durationMs
  const elapsed =
    !running && !message.interrupted && typeof elapsedMs === 'number' && elapsedMs > 0
      ? formatDuration(elapsedMs)
      : null

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => {
          if (storeKey) setProcessOpen(storeKey, !open)
          else setLocalOpen(!open)
          /* 用户自己动布局 → FREE，别替他重新滚回去（与 ThinkBlock / ToolLine 同一规矩） */
          guard?.enterFree()
        }}
        aria-expanded={open}
        aria-label="查看过程"
        aria-describedby={running ? liveStatusId : undefined}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-2xs text-fg-tertiary transition-colors duration-fast hover:text-fg-primary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {failed ? (
          /* 单独包一层 span：`data-*` 挂在 lucide 组件上不保证落到 DOM 里，
             而真机验收正是靠这个属性判断「有没有红叉」——挂在 svg 上会静默读不到。 */
          <span
            className="shrink-0"
            style={{ color: colorOf('failed') }}
            data-process-failed="true"
          >
            <XCircle size={11} />
          </span>
        ) : null}
        {/*
          运行中挂 `.process-live`：整句一个文本节点，一层窄高光在字后面横向滑过
          （`background-clip: text`，见 index.css）。不拆字、不改 opacity、不加光晕。
          文案是常量「实时任务」，切换步骤 / 新一轮都不重挂 —— 动画不会被打断重播。
        */}
        <span id={liveStatusId} className={`min-w-0 truncate${running ? ' process-live' : ''}`}>
          {text}
        </span>
      </button>

      {/*
        展开区用左侧竖线缩进，和工具明细行同一套观感 —— 不新增设计 Token。
        ★ 展开**不重新生成回答**，也不动滚动位置（`enterFree` 已经声明了「别管我」）。
      */}
      {open ? (
        <div
          className="mt-1 border-l-2 pl-3"
          style={{ borderColor: 'var(--border-strong)' }}
          data-process-open="true"
        >
          {elapsed ? (
            <p className="mb-2 text-2xs text-fg-tertiary" data-process-elapsed="true">
              用时 {elapsed}
            </p>
          ) : null}
          {children}
          {activity ? (
            <div className="mt-1" data-process-activity="true">
              {activity}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

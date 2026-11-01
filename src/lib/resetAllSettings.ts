import { useConfigStore } from '@/stores/useConfigStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/* ══════════════════════════════════════════════════════════════
   重置设置（唯一实现）

   ── 为什么要有这个文件（2026-10-31 第二阶段）──────────────────
   原来两处入口各写一套，而且**说的不是一回事**：
     · 设置弹窗底部「恢复默认」→ 只调 `resetSettings()`（localStorage 里的界面偏好）
     · 数据与用量 →「重置设置」→ 先 `resetSettings()`，再调后端 `resetToDefaults()`，
       然后拿 `useConfigSaveStatus` 的一个全局状态判断成败，**无论成败都报成功**
   于是：后端失败时，界面偏好已经重置了、后端配置没动，而提示写着「设置已重置」。
   这正是文档点名的那句「不得在后端失败时只重置一半却提示全部成功」。

   ── 现在的口径 ────────────────────────────────────────────────
   一个函数、一个范围（**本地界面偏好 + 后端配置**）、一个如实的结果：
     · 'ok'       —— 两段都成功
     · 'partial'  —— 本地成功、后端失败（要说清哪一半没成）
     · 'failed'   —— 本地就失败（极罕见：localStorage 不可用）
   调用方只负责把结果翻成人话，不再各自判断。

   注意：**不动对话数据**。会话、记忆、任务台账都不在这个范围内
   （清空数据另有入口，见 lib/dataPortWipe.ts）。
   ══════════════════════════════════════════════════════════════ */

export type ResetOutcome = 'ok' | 'partial' | 'failed'

export interface ResetResult {
  outcome: ResetOutcome
  /** 给用户看的一句话（已含哪一半没成） */
  message: string
  /** 补充说明（可以空） */
  detail: string
}

export async function resetAllSettings(): Promise<ResetResult> {
  /* ① 本地界面偏好（主题 / 宽度 / 开关 …）—— 同步动作，出错就是 localStorage 不可用 */
  let localOk = true
  try {
    useSettingsStore.getState().resetSettings()
  } catch {
    localOk = false
  }

  /* ② 后端配置（工作目录 / 权限 / 供应商 …）—— 只有主进程说了才算 */
  const backendOk = await useConfigStore.getState().resetToDefaults()

  if (localOk && backendOk) {
    return {
      outcome: 'ok',
      message: '设置已重置',
      detail: '界面偏好和后端配置都回到了默认值；对话数据不受影响。',
    }
  }
  if (localOk && !backendOk) {
    return {
      outcome: 'partial',
      message: '只重置了一部分',
      detail:
        '界面偏好（主题、宽度、开关）已经回到默认值；' +
        '后端配置（工作目录、权限、供应商）没有重置成功 —— 请检查数据目录后重试。',
    }
  }
  return {
    outcome: 'failed',
    message: '设置没有重置',
    detail: backendOk
      ? '界面偏好没能写回本地存储（浏览器存储不可用），后端配置已经重置。'
      : '界面偏好和后端配置都没有重置成功。',
  }
}

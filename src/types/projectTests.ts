/**
 * 项目自定义测试的类型（3A）
 *
 * 与主进程 `core/project-tests.cjs` 的形状**一一对应**（硬约束 9：形状只有一处真相源）。
 * 这里只做 TypeScript 侧声明，判据全在主进程。
 */

/** 一条项目测试的配置形状 */
export interface ProjectTestItem {
  id: string
  label: string
  /** 项目根（绝对路径；主进程校验必须真实存在且不是盘符根/系统目录） */
  root: string
  /** 用户亲笔写的命令（不含 & | < > ^ % 引号 换行） */
  command: string
  /** 超时秒数（5 ~ 600） */
  timeoutSec: number
  /**
   * 是否允许 Harbor 在这个项目根里**改文件**（3C-2）。
   *
   * 外部项目默认只有「读 / 跑测试」；要让它参与修复闭环，用户必须在这里显式打开。
   * 隔离区内的根（`<data>` 之下）不需要这个开关 —— 那本来就是受控测试区。
   */
  allowWrite?: boolean
}

/** 配置段（默认全关、零条目） */
export interface ProjectTestsSettings {
  enabled: boolean
  items: ProjectTestItem[]
}

/** 一条条目在界面上额外带的校验结果（主进程算的，前端不自己判断） */
export interface ProjectTestItemStatus extends ProjectTestItem {
  rootValid: boolean
  rootReal: string
  rootError: string
  commandValid: boolean
  commandError: string
  /** 这条根上允许的动作（读/跑测试/改/恢复）—— 主进程算的，前端只显示 */
  actions: string[]
  /** 真正可用 = 总开关开着 + 根合法 + 命令合法 */
  usable: boolean
}

/** 六种执行状态（与 `project-test-status.cjs` 的 STATUS 同值） */
export type ProjectTestStatus = 'PASS' | 'FAIL' | 'TIMEOUT' | 'CANCELLED' | 'DENIED' | 'ERROR'

/** `projectTests:status` 的返回 */
export interface ProjectTestsState {
  enabled: boolean
  items: ProjectTestItemStatus[]
  statuses: Record<string, ProjectTestStatus>
  limits: {
    items: number
    command: number
    root: number
    label: number
    timeoutSec: number
    defaultTimeoutSec: number
  }
}

/* ══════════════════════════════════════════════════════════════
   会话消息还在从磁盘读的时候，中间区显示的东西。

   ★ 别拿它当「空对话」去渲染开屏（launch/LaunchScreen.tsx）：
     开屏一挂上就跑工作区扫描 / 未完成任务 / 凭据检查一串 IPC，还要画灯塔，
     而消息几十~几百毫秒后到了整个丢掉。真机量过：切千条会话那一次
     **65–76ms 长任务**就是这次白干的挂载（CPU Profile 里是 canvas 的
     `fillText` / `fillRect` + 一堆原生 deserialize）。

   判据在 store 上：`loadingThreadId === 当前会话` → 正在读；见 app/diskActions.ts。
   ══════════════════════════════════════════════════════════════ */

export function MessageSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-5"
      aria-busy="true"
      aria-label="正在读取会话"
    >
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex flex-col gap-2">
          <div className="h-3 w-24 animate-pulse rounded bg-bg-hover" />
          <div className="h-3 w-full animate-pulse rounded bg-bg-hover" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-bg-hover" />
        </div>
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
   「工作目录 → 项目标识 / 显示名」

   从 `disk.ts` 拆出来的：读盘的 `disk.ts` 和分组的 `workspaceGroups.ts`
   都要用它，放在任何一个里都会让这两个文件互相 import 成环
   （这个仓库为破环专门拆过 `lib/bridge.ts`，别再来一次）。

   ★ `folderIdFor` **必须与内核 `electron/core/project-paths.cjs` 的 `dirIdFor` 逐字一致**。
     老会话文件里只有 `workdir`、没有 `projectId`，内核读的时候按 workdir 推导归属；
     两边拼法只要差一个字符，升级瞬间老会话就会从原来的项目里「搬家」。
   ══════════════════════════════════════════════════════════════ */

/** 目录 → 显示名（取最后一段；根目录显示成整个路径） */
export function workdirName(workdir: string): string {
  const normalized = String(workdir)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
  const last = normalized.split('/').filter(Boolean).pop()
  return last || workdir || '本地'
}

/** 文件夹的稳定 id：挂在目录上，换机器/换盘符也还是同一个 */
export function folderIdFor(workdir: string): string {
  return `dir:${workdir}`
}

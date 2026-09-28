/* 钩子共用的小工具 —— **只做转发**
 *
 * 实现挪去了 `scripts/lib/run.mjs`：preflight 也要用同一套，
 * 让通用工具住在 hooks/ 下面会变成「通用工具藏在某个具体功能目录下」。
 * 这里保留同名导出，所以 pre-commit.mjs / pre-push.mjs / install.mjs 一行都不用改
 * （和 scripts/check-rules.mjs 的门面一个套路：拆文件不该改调用方）。
 */
export { ROOT, runScript, runNode, step, fail } from '../lib/run.mjs'

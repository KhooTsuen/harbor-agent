/* pre-commit：提交前的**快闸门**（大约 20 秒）
 *
 *   ① 六项规范检查（行数 / 依赖两侧一致 / 明文密钥 / TODO / AGENT.md 在 / 改动文件数）
 *   ② 内核自检（.cjs 不参与 tsc，改内核只跑 typecheck 等于没验 —— 这里兜住）
 *
 * 慢的那套（全量 verify）在 pre-push，见同目录 pre-push.mjs。
 * 装法见 docs/约束机制说明.md；本项目用 `core.hooksPath` 指向 .github/hooks。
 */
import { fail, runNode, runScript, step } from './lib.mjs'

step('提交前快闸门')

if (!runNode(['scripts/check-rules.mjs'])) {
  fail('规范检查没过', '先看上面哪一条报红；不要改检查脚本去迎合代码。')
  process.exit(1)
}

if (!runScript('test')) {
  fail('内核自检没过', '内核自检覆盖 electron/**，tsc 看不到这些文件。')
  process.exit(1)
}

console.log('\n[钩子] ✓ 过闸（记住：测试全绿 ≠ 能用。改了 UI / 会话 / 发送 / 权限，必须真机跑一遍）')

/**
 * 「这次 ask_user 问的是不是规模」的判据
 *
 * 从 `tools/scale-gate.cjs` 拆出来的（那边加完审计问题 7 的收窄就过了 300 行）。
 * 这一段是**纯函数**：给一组问题，说「看着像不像规模确认」——
 * 不碰授权表、不写日志，所以自检和单测都能直接喂它。
 *
 * ── 为什么要判「像不像」（审计问题 7）──
 *
 * 以前只要用户**答过任何一次** `ask_user`，那次规模拦截就顺带解锁了 —— 模型在拦截后
 * 先问一句「要什么风格」，用户一答，扫全盘这类重操作就再也不问了。
 * 而拦截文案（`scale-gate.blockText`）要求的问法是「说清打算做什么、多大范围、
 * 大约多久，选项里写**具体数字**」，所以合规的问法必然同时有「规模词」和「数字」。
 *
 * 两者任一不满足 → 不授权，宁可再问一次（和 scale-gate 的
 * 「范围含糊时宁可下次再问一遍」同调）。
 */

/** 规模词：命中任何一个才算「在说规模」 */
const SCALE_WORD =
  /(规模|范围|多大|多少|几个|几秒|几小时|多久|耗时|全盘|整盘|整个项目|整个仓库|递归|批量|文件数|磁盘)/

const DIGIT = /\d/

/** 把模型问的问题（含选项文案与默认值）拼成一段文本 */
function askText(questions) {
  const parts = []
  for (const item of Array.isArray(questions) ? questions : []) {
    parts.push(String(item?.question ?? ''), String(item?.defaultValue ?? ''))
    for (const option of Array.isArray(item?.options) ? item.options : []) {
      parts.push(String(option?.label ?? ''), String(option?.effect ?? ''))
    }
  }
  return parts.join(' ')
}

/** 这次提问看着像「规模确认」吗 */
function looksLikeScaleAsk(questions) {
  const text = askText(questions)
  return SCALE_WORD.test(text) && DIGIT.test(text)
}

module.exports = { looksLikeScaleAsk, askText, SCALE_WORD, DIGIT }

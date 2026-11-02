/**
 * 经验的三道闸：**作用域对得上 · 修法对得上 · 文本干净**
 *
 * 单独一个文件的原因：这三条判据同时被「建条目 / 记验证 / 记反例 / 落盘」四处要，
 * 而 `experience-store.cjs` 已经贴 300 行红线。判据本身必须只有一处
 * （硬约束 9），所以搬到这里，store / loop 都调它 —— 别在各自的函数里手写一份
 * `item.projectId === ctx.projectId`，那正是会漂的东西。
 *
 * ── 逐条说清它治的是什么（都是 2026-11-02 用户点出来的反例）──
 *
 * ① **作用域**：一个 project 作用域的经验，乙项目的成功不能算它的验证，也不能
 *    把它的验证次数补上一格。没有这条，两个项目各踩一半、合起来就「够三次」了。
 * ② **修法**：`read_file` 失败之后又 `read_file` 成功（文件后来出现了）不算
 *    「修法已验证」；要算，得是**同一种做法被重复采用**（见 schema.recipeOf）。
 * ③ **文本**：脱敏失败 / 打过码还像密钥 —— 整条不记，也不许落盘。
 */

/**
 * 这条经验在这个上下文里能不能被「这次执行」动到。
 *
 * 语义与 `memory-scope.visible` 一致，但**用途不同**：这里判的是**能不能写**
 * （记验证 / 记反例），那边判的是**能不能看见**。两者口径必须一样，
 * 所以 scope 名与项目 / 会话字段都复用同一套（global / project / session）。
 *
 * @param {{ scope?: string, projectId?: string, sessionId?: string }} item
 * @param {{ projectId?: string, sessionId?: string }} ctx
 */
function scopeAllows(item, ctx = {}) {
  const scope = typeof item?.scope === 'string' && item.scope ? item.scope : 'global'
  if (scope === 'project') {
    const want = String(ctx?.projectId ?? '')
    return want !== '' && String(item?.projectId ?? '') === want
  }
  if (scope === 'session') {
    const want = String(ctx?.sessionId ?? '')
    return want !== '' && String(item?.sessionId ?? '') === want
  }
  return true
}

/**
 * 这次成功用的做法，是不是这条经验已经认下的那一种。
 *
 * 条目还没认过修法（`recipe.key` 为空）时返回 `'unset'` —— 那是「第一次成功，
 * 只能算探明做法」，调用方要调 `adoptRecipe`，**不能**直接计验证。
 *
 * @returns {'unset' | 'match' | 'different'}
 */
function recipeState(item, recipeKey) {
  const known = String(item?.recipe?.key ?? '')
  if (!known) return 'unset'
  return known === String(recipeKey ?? '') ? 'match' : 'different'
}

/**
 * 这条观察原文能不能进库。
 *
 * @param {{ textSafe?: boolean, textError?: string, text?: string }} feature
 * @returns {string} 空串 = 可以用；非空 = 放弃原因（**不含原文**，可以直接进日志）
 */
function textDropReason(feature) {
  if (feature?.textSafe === false) return `观察原文脱敏失败，已放弃这条经验（${feature?.textError || '原因不明'}）`
  return ''
}

/**
 * 落盘前最后一道：哪条文本看着还是密钥，就**整条不写**。
 *
 * 为什么在 store 里还要查一次（schema 已经洗过）：经验文件是**长期留在磁盘上**的，
 * 而脱敏规则会变、会有新的密钥形态。一次漏洗就是永久明文 —— 宁可少学一条。
 *
 * @param {Array<object>} items
 * @param {(text: string) => boolean} looksSecret  `redact.looksSecret`
 */
function splitSafe(items, looksSecret) {
  const kept = []
  const dropped = []
  for (const item of Array.isArray(items) ? items : []) {
    let dirty = false
    try {
      dirty = looksSecret(String(item?.triggerText ?? ''))
    } catch {
      dirty = true /* 查不了就当脏 —— fail-closed */
    }
    if (dirty) dropped.push(String(item?.id ?? ''))
    else kept.push(item)
  }
  return { kept, dropped }
}

module.exports = { scopeAllows, recipeState, textDropReason, splitSafe }

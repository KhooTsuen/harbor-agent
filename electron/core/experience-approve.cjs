/**
 * 审批档位：**人**决定一条 candidate 能不能变成规则（蓝图 §7）
 *
 * ── 为什么必须有这一层 ──
 *
 * 自动升级只对「系统能自己核实」的低风险情形开放（`AUTO_PROMOTE_CATEGORIES`）。
 * 剩下三类永远升不上去，此前它们只能停在 candidate 烂在库里：
 *   · `user_correction`：用户说「不对」是最高权威的输入，但「该怎么做才对」只有人能定；
 *   · `permission` / `external_blocked`：边界挡住、验证码登录墙，修法不在我们手里；
 *   · 任何被标成 high risk 的条目。
 * 没有审批档位，这些「人知道的答案」就永远进不了提示 —— 而它们恰恰是最值得记的。
 *
 * ── 三条硬规矩（写在这里，改代码前先读）──
 *
 * ① **只有人能跨过这道门，而且只跨这一步**。`approve` 只把 candidate 抬到 verified，
 *    不改任何分类白名单，也不让「之后碰巧成功几次」去补计数。
 * ② **批准必须有可注入的做法**（`recommendedAction`）。一条「遇到过 X，但不知道怎么办」
 *    的经验批准了也没用 —— 注入进去只会让模型困惑。做法可以是系统记下的那次成功
 *    （自动升级那条路），也可以是人在批准时手写的一句（`actionText`）。
 *    两样都没有就**拒绝批准**并说清原因（`needs_action`），不偷偷批准一条空壳。
 * ③ **留痕**：`history` 记状态迁移的来龙去脉，`audit` 记「谁在什么时候批了哪一条、
 *    当时看到的是什么」。审计写失败不影响批准本身（与 `audit.cjs` 的约定一致）。
 *
 * 状态机本身在 `experience-schema.cjs`（`suspended → verified` 只允许这条路走，见那边的注释）。
 */
const schema = require('./experience-schema.cjs')
const file = require('./experience-store-file.cjs')
const log = require('./log.cjs')

/** 动作名（别在别处写字面量） */
const ACTION = { APPROVE: 'approve', REJECT: 'reject', RESTORE: 'restore', AMEND: 'amend' }

/** 人写的做法最长多少字（进提示，不能长） */
const MAX_ACTION_TEXT = 120

/** 人写的备注最长多少字（只留痕，不进提示） */
const MAX_NOTE = 200

/**
 * 写审计（**不抛**）。审计里不放经验的原文 —— 那可能带着路径 / 命令，
 * 只放 id 与动作（详见 audit.cjs 的脱敏约定）。
 */
function writeAudit(entry) {
  try {
    require('./audit.cjs').record({
      tool: `experience:${entry.action}`,
      ok: true,
      approval: entry.action,
      extras: {
        experienceId: entry.id,
        from: entry.from,
        to: entry.to,
        tool: entry.tool,
        category: entry.category,
      },
    })
  } catch (error) {
    log.warn(`经验审批审计写不进去：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 看一条经验能不能被这个人动。
 *
 * 审批是**管理动作**（设置页是全库视图），所以不按 projectId 过滤 ——
 * 但要按状态过滤：已经 rejected / deprecated 的终点状态不能再动，
 * 否则「驳回可撤销」会让留痕变成笑话。
 *
 * @returns {string} 空串 = 可以；非空 = 不能的原因（给界面直接显示）
 */
function blockReason(item, action) {
  const status = String(item?.status ?? '')
  if (!item) return '经验不存在（可能已被清理）'
  if (status === schema.STATUS.REJECTED) return '这条已经被驳回过了'
  if (status === schema.STATUS.DEPRECATED) return '这条已被废弃（终点状态）'
  if (action === ACTION.APPROVE) {
    if (status === schema.STATUS.VERIFIED) return '这条已经是生效状态，不需要再批'
    if (status === schema.STATUS.SUSPENDED) return '它已被反例打停：要么先看调查记录再恢复，要么驳回'
    return ''
  }
  if (action === ACTION.RESTORE) {
    if (status !== schema.STATUS.SUSPENDED) return '只有被反例打停的经验才需要恢复'
    return ''
  }
  if (action === ACTION.AMEND) {
    /*
     * 改做法**不碰状态机**：它只改「注入时说的那句话」，所以 candidate / verified /
     * suspended 都可以改（给一条还没批的候选先写好措辞、给被停用的那条改清楚，
     * 都是正当的）。终点状态（rejected / deprecated）上面已经拒掉了。
     * 但「一条没有做法的 candidate」不必走这里 —— 它批准时填就行，这里只管「已有一条」。
     */
    if (!String(item.recommendedAction ?? '').trim()) return '这条还没有做法可改：批准时填一句就行'
    return ''
  }
  return ''
}

/**
 * 人做一次审批。
 *
 * @param {string} id
 * @param {{ action?: string, actionText?: string, note?: string, at?: number }} input
 * @returns {{ ok: boolean, item?: object, error?: string, reason?: string }}
 *   `reason` 是机器可读的原因：`needs_action` / `no_such_item` / `blocked`
 */
function review(id, input = {}) {
  const action = String(input.action ?? '')
  const at = Number(input.at) || Date.now()
  const actionText = String(input.actionText ?? '').trim().slice(0, MAX_ACTION_TEXT)
  const note = String(input.note ?? '').trim().slice(0, MAX_NOTE)
  if (![ACTION.APPROVE, ACTION.REJECT, ACTION.RESTORE, ACTION.AMEND].includes(action)) {
    return { ok: false, error: `不认识的审批动作：${action || '（空）'}`, reason: 'bad_action' }
  }

  const data = file.load()
  const item = data.items.find((entry) => entry.id === String(id ?? ''))
  if (!item) return { ok: false, error: '经验不存在（可能已被清理）', reason: 'no_such_item' }
  const blocked = blockReason(item, action)
  if (blocked) return { ok: false, error: blocked, reason: 'blocked', item }

  const from = item.status
  /** 迁移一律走 file.recordMove —— 它是唯一往 history 里写迁移的地方 */
  const go = (to) => {
    const head =
      action === ACTION.APPROVE ? '人工批准' : action === ACTION.REJECT ? '人工驳回' : '人工恢复（推翻反例）'
    file.recordMove(item, from, to, note ? `${head}：${note}` : head)
  }

  /*
   * 改做法：**只换「注入时说的那句话」，不碰状态**。
   *
   * 为什么必须单独一条路（而不是「先驳回再重建」）：驳回是终点，
   * 一条已经在生效的经验如果只是措辞不清楚（或者批的时候写得太笼统），
   * 让人只能把它废掉再从头攒证据，等于逼他做出比「改一句话」更大的决定。
   *
   * 三条口径：
   *   · 只有**人**能改（和批准同理，系统侧的「做法」由真实成功决定）；
   *   · 状态一动不动（verified 仍是 verified、suspended 仍是 suspended）——
   *     改措辞不是重新批准，不能借它绕过反例或状态机；
   *   · 字面没变就拒（`no_change`）：否则「每点一次都留一笔痕」会把历史灌满，
   *     而历史是排查「为什么不注入」时唯一的凭据。
   */
  if (action === ACTION.AMEND) {
    if (!actionText) {
      return { ok: false, error: '改做法得写一句新的（这句会进提示）', reason: 'needs_action', item }
    }
    const before = String(item.recommendedAction ?? '').trim()
    if (before === actionText) {
      return { ok: false, error: '新做法和原来一字不差，没有要改的', reason: 'no_change', item }
    }
    file.recordMove(item, from, from, note ? `人工修改做法：${note}` : '人工修改做法')
    item.recommendedAction = actionText
    /*
     * `approval.actionText` **保持不动**：它记的是「批准那一刻认定的做法」，
     * 是历史；当前注入的是 `recommendedAction`。两者不一致时，界面会把
     * 「当前做法」显示出来，历史在 `history` 里 —— 同一件事不留两份当前值。
     */
    item.updatedAt = at
    file.persist(data)
    writeAudit({ id: item.id, action, from, to: item.status, tool: item.tool, category: item.category })
    log.info(`经验审批：修改做法 ${item.id}（状态不变：${item.status}）`)
    return { ok: true, item }
  }

  if (action === ACTION.REJECT) {
    if (!schema.canMove(from, schema.STATUS.REJECTED)) {
      return { ok: false, error: `当前状态（${from}）不能驳回`, reason: 'blocked', item }
    }
    go(schema.STATUS.REJECTED)
  } else {
    /*
     * approve / restore 都要落到 verified。批准前提②：必须有做法 ——
     * 优先用这次人写的那句，其次用系统记下的那次成功。
     */
    const how = actionText || String(item.recommendedAction ?? '')
    if (!how) {
      return {
        ok: false,
        error: '这条没有可注入的做法（系统没记下成功的那一步，你也没填）。批准一条不知道怎么办的经验没有意义',
        reason: 'needs_action',
        item,
      }
    }
    if (!schema.canMove(from, schema.STATUS.VERIFIED)) {
      return { ok: false, error: `当前状态（${from}）不能批准`, reason: 'blocked', item }
    }
    go(schema.STATUS.VERIFIED)
    item.recommendedAction = String(how).slice(0, MAX_ACTION_TEXT)
    /*
     * 人批的那条**不看验证器版本**（见 schema.injectable）。同时把当前验证器的
     * 版本记进条目，方便日后解释「它是按哪一版系统结论批的」。
     */
    item.approval = {
      by: 'user',
      at,
      /* approve / restore 分开记：恢复意味着「我知道它被反例打过，仍然宣布它有效」 */
      action,
      note,
      /* 批准时看到的那句话 —— 日后做法被改掉时，能对上是哪一次批的 */
      actionText: String(how).slice(0, MAX_ACTION_TEXT),
      validatorVersion: schema.VALIDATOR.version,
    }
    item.validatorId = schema.VALIDATOR.id
    item.validatorVersion = schema.VALIDATOR.version
  }

  item.updatedAt = at
  file.persist(data)
  writeAudit({
    id: item.id,
    action,
    from,
    to: item.status,
    tool: item.tool,
    category: item.category,
  })
  log.info(`经验审批：${action} ${item.id}（${from} → ${item.status}）`)
  return { ok: true, item }
}

module.exports = { ACTION, MAX_ACTION_TEXT, MAX_NOTE, review, blockReason }

/**
 * 存量清理的闸门：**一次要删很多时，先问过用户没有**
 *
 * ── 为什么要有它（2026-11-07，用户明确要求）──
 *
 * 上一轮把三个「写了却没人调」的清理接进了启动链（`growth-retention.steps()`）。
 * 那修的是「机制不生效」，但顺手造出一个新风险：
 *
 *   下次 Harbor 一启动，就会按 `keep=50` 把 **1128 个**改动事务删到 50 个，
 *   按 `KEEP=10` 删掉超量的备份，还会删掉过期的审计日志。
 *
 * 这些是**用户第一次见到这套保留策略**之前就攒下的东西 —— 他没批过。
 * 「增长可控」不该以「静默删掉他没同意删的数据」为代价。
 *
 * ── 判据：日常增量 vs 首次积压 ────────────────────────────────
 *
 * 不分阈值而一律拦住，会让日常清理永不生效（等于回到「机制不生效」）；
 * 一律放行，就是这次要修的问题。所以按**一批要删多少**分：
 *
 *   · `≤ SAFE_BATCH` —— 日常量级。正常跑一天也就多出几个事务，
 *     这说明策略已经在稳定工作，直接清（每个动作都记日志，可追溯）。
 *   · `> SAFE_BATCH` —— 积压。可能是首次启用、也可能是跑很久没人管。
 *     一律**只盘点不删**，把清单写进 `data/retention-pending.json`，
 *     等用户看过之后放一个 `data/retention-armed.json({armed:true})` 再执行。
 *
 * ── 为什么「授权依据」是一个文件，而不是一个配置项 ──
 *
 * 配置项（`config.json`）能由程序自己 `patch()` 写 —— 那等于「程序自己给自己授权」。
 * 这个文件只在用户批准之后由**人**放上去（或由一条明确说「清理吧」的指令驱动），
 * 清理代码自己**从不**写它。所以它是一份可核对的外部凭据，不是运行时开关。
 *
 * 三条纪律照旧：绝不抛、不删进行中的、删了要留痕。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')

/**
 * 「一批删这么多还算日常」的上限。
 *
 * 定这几个数的依据：
 *   · `changesets` —— 一轮对话通常产生 1 个事务。一天正常运行也就超 keep 几个；
 *     20 已经是很宽松的余量，超过它说明攒了很久没清。
 *   · `backups`    —— 一天最多备一份（`AUTO_INTERVAL_MS` = 24h），
 *     超量 2 份意味着至少两天没清。
 *   · `audit`      —— 过期是按天算的。一次掉 3 天以上，通常意味着很久没启动过。
 *
 * ★ 这套阈值**只在「非首次清扫」时生效**，见下面的 `isFirstSweep()`。
 */
const SAFE_BATCH = { audit: 3, changesets: 20, backups: 2 }

/** 用户放这个文件 = 批准清存量。清理代码**不写**它。 */
function armedFile() {
  return path.join(DIRS.data, 'retention-armed.json')
}

/** 攒下的待清理清单（人看的，也是「事先能看到的」那一份） */
function pendingFile() {
  return path.join(DIRS.data, 'retention-pending.json')
}

/**
 * 「这套保留策略开始工作的时刻」——文件不在 = 还没跑过 = **首次**。
 *
 * ── 为什么单靠数量阈值不够（2026-11-07 真机盘点后修正）──
 *
 * 一开始我用的是「一批删超过 N 个才拦」。真机一盘点就发现它漏了：
 * Dev 那台只有 **1 份** 345MB 的旧备份超量 —— 1 ≤ 2，判成「日常量级」直接删。
 * 可对用户来说，那是他**没批过**的 345MB 历史备份，删了就是删了。
 *
 * 数量少不等于「日常」：真正的日常是「策略已经在稳定工作之后多出来的那几个」，
 * 而**第一次**清扫看到的全部都是积压 —— 不论一个还是一千个。
 *
 * 所以判据换成时间线：没跑过 → 一律只盘点；跑过之后 → 才按数量阈值。
 */
function stateFile() {
  return path.join(DIRS.data, 'retention-state.json')
}

/** 这套策略跑过完整一轮了吗 */
function isFirstSweep() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return !(Number(raw?.firstSweepAt) > 0)
  } catch {
    return true
  }
}

/**
 * 记下「完整跑过一轮了」。
 *
 * 由 `pruneAll` 在**全部步骤跑完之后**统一调一次（不是每步各调）——
 * 否则第一步写完之后，后面两步就都看到「非首次」了，等于没拦。
 * 中途抛错就不写，下次仍按首次处理（fail-safe：宁可多拦一轮）。
 */
function markSwept() {
  try {
    fs.mkdirSync(DIRS.data, { recursive: true })
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ firstSweepAt: Date.now(), version: 1 }, null, 2),
    )
  } catch (error) {
    log.warn(`记清扫状态失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 用户批准过清存量吗。读不到 / 形状不对一律当「没批准」（fail-closed）。 */
function isArmed() {
  try {
    const raw = JSON.parse(fs.readFileSync(armedFile(), 'utf8'))
    return raw?.armed === true
  } catch {
    return false
  }
}

/**
 * 这一批能不能真删。
 *
 * 判定顺序（任一条命中就只盘点）：
 *   ① 用户放了 `retention-armed.json` → **放行**（他明确批准过；首次也放行，
 *      否则批准了还拦，等于批准没用）
 *   ② 首次清扫 → 一律只盘点（他没见过这套策略，删什么都是没批过）
 *   ③ 一批超过 `SAFE_BATCH` → 只盘点（积压，可能是跑很久没人管）
 *   ④ 其余 → 真删
 *
 * @param {{ key: string, would: number }} input
 * @returns {'apply'|'report'} `report` = 只盘点，不删
 */
function decide({ key, would }) {
  if (!(would > 0)) return 'apply'
  if (isArmed()) return 'apply'
  if (isFirstSweep()) return 'report'
  const safe = SAFE_BATCH[key] ?? 0
  return would <= safe ? 'apply' : 'report'
}

/** 读已有清单（坏掉就当空，不抛） */
function readPending() {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/**
 * 把「本来想删、但还没批准」的那批记下来。
 *
 * 会**合并**进同一份文件（三处清理各写各的键），并且每次都重算 ——
 * 清单要反映「现在」的积压，不是第一次看到的那一份。
 *
 * @param {{ key: string, items?: string[], bytes?: number }} input
 */
function notePending({ key, items = [], bytes = 0 }) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return 0
  const all = readPending()
  all[key] = { count: list.length, bytes, names: list.slice(0, 200), at: Date.now() }
  all.armed = isArmed()
  try {
    fs.mkdirSync(DIRS.data, { recursive: true })
    fs.writeFileSync(pendingFile(), JSON.stringify(all, null, 2))
  } catch (error) {
    log.warn(`写待清理清单失败：${error instanceof Error ? error.message : error}`)
  }
  return list.length
}

/** 批准并清完之后把它抹掉（清单不留过期的，否则下次看着像还有一堆） */
function clearPending() {
  try {
    fs.rmSync(pendingFile(), { force: true })
  } catch {
    /* 删不掉不算事 */
  }
}

/** 把「已清扫」状态抹掉，回到「首次」—— 自检用（生产不调） */
function clearState() {
  try {
    fs.rmSync(stateFile(), { force: true })
  } catch {
    /* 删不掉不算事 */
  }
}

module.exports = {
  SAFE_BATCH,
  armedFile,
  pendingFile,
  stateFile,
  isArmed,
  isFirstSweep,
  markSwept,
  clearState,
  decide,
  notePending,
  readPending,
  clearPending,
}

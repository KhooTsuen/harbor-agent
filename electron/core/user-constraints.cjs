/**
 * 用户这轮说的运行时约束（「只分析，不修改」这类）
 *
 * 为什么单独立一个文件：
 *   · 判据是**正则启发式**。启发式只有能被直接调用才钉得住 —— 原来它内联在
 *     `loop.cjs` 造 ctx 的那一段里，自检碰不到（2026-10-15 那次误判就是这么漏过去的）。
 *   · 「用户这一轮说了什么」本来就是一件事，抠法该只有一处（硬约束 9）。
 *
 * ★ 2026-10-15 修掉的误判（用户报「内置浏览器调不动」）
 *
 *   原来是一条大正则，其中 **`不许写` 太泛**：用户给模型的**输出要求**
 *   「一律标注『未验证』，不许写成确定的事实」里就带着它，于是整整一轮
 *   `allowWrite=false`，`browse` / `run_shell` / `write_file` 全被拒
 *   （装机版 errors/2026-10-15.jsonl 16:46–16:49 六条全是这个）。
 *
 *   现在拆成两半，**任一半命中才算「别动东西」**：① 明确短语（「只分析」这类
 *   语义自足、不需要宾语）；② 否定词 + 泛动词 + 文件类对象（必须同现，
 *   `(?!成)` 挡「写成…」那种输出要求）。
 *   代价写下了：**光说「不许写」而没说写什么，不再算约束** —— 这比反过来安全得多。
 */

/* ── ⓪ 「停手，等我点头」的说法清单 —— **唯一真相源** ──────────
 *
 * 系统提示里那句「用户说了『先别动 / 等我确认 / …』这类话就别自作主张」
 * 必须由这张表生成（`prompt-rules.cjs` 的 PLAN_GATE_RULE）。两边各写一套的结局
 * 已经实测过（2026-11-01）：
 *
 *   提示词列了 6 种说法，内核只认「先别动」1 种 —— 用户照着提示词说
 *   「等我确认」，模型照做停下了，可内核那道门根本没合上：
 *   `noWriteIn('等我确认')` 返回 false → `allowWrite` 还是 true → 写工具照常放行。
 *
 * 这正是硬约束 9 说的那类事故：契约两边各写一份，谁也不知道对方写了什么。
 *
 * ★ 只收**语义自足**的说法（整句都是「停手」的意思，不需要宾语）。
 *   `别动` 单独一个词**故意不收**：「别动那个文件」指的是某一个对象，
 *   收进来会把「别的随便改」判成整轮锁死 —— 那是 2026-10-17 踩过三次的坑。
 *   `别动手` 收：「动手」本身就是「开工」，没有宾语歧义。
 */
const STOP_PHRASES = [
  '先别动',
  '别动手',
  '等我确认',
  '等我点头',
  '等我的确认',
  '先分析再决定',
  '先看看再说',
  '先看不要动',
  '先给我方案',
  '等我拍板',
]

/* ── ① 明确短语（语义自足，不需要宾语）──────────────────────
 *
 * 只放**只有一种解释**的：「只分析」「不执行修改」。
 * 「不要修改」「禁止修改」**不在这里** —— 它们配上非文件宾语（「不要修改结论」）
 * 就是输出要求，挪到 ② 去要求带宾语（2026-10-15 实测：「不要修改结论」曾被误判）。
 *
 * 停手那几条（STOP_PHRASES）并进来：它们和「只分析」是同一种语义自足的短语，
 * 只是**意图不同** —— 前者是「等我拍板」，后者是「这一轮只读」。对写工具来说
 * 结局一样：不许落盘。
 */
const NO_WRITE_PHRASE = new RegExp(`(只分析|不执行修改|不执行写入|${STOP_PHRASES.join('|')})`)

/* ── ①′ 「提及」不等于「下达」（2026-11-06 真机误判）────────────
 *
 * 病：用户在同一段话里既**授权**改源码、又要写验收标准 ——
 *   「5. 用户明确要求只分析、不修改：仍然严格遵守。」
 *   「之前消息中出现的「只分析、不修改」只是测试场景。」
 * 两处都命中明确短语，整轮 `allowWrite=false`，而这轮正在授权动手。病根是判据
 * 不区分**引述**和**发令**。只收两条有客观标记的判据，不猜语义：
 *   ⓐ 引号里的是**提到**某句话，不是发出它 → 剥掉（「」『』“”""）。
 *   ⓑ 短语前 12 字内有**转述主语**（用户明确要求 / 如果 / 场景 / 验收 / 测试…）→ 不算命令。
 * 代价：**「我要求只分析」仍拦**（清单只收第三方的「用户要求」）。漏放只是那一轮
 * 没锁上（PermissionBar 兜底），错拦则整轮全废 —— 方向不能反。
 */
const QUOTED_TEXT = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g

const MENTION_SUBJECT = /(用户(明确)?(要求|说|提到|表示)|如果|假如|当|场景|验收|测试|示例|描述|说的是)/

/** 把「引号里的话」抹成空格 —— 被提到的文本不是指令 */
function stripQuoted(text) {
  return text.replace(QUOTED_TEXT, ' ')
}

/** 明确短语有没有真的命中（逐处看前文，跳过「转述」的那几处） */
function phraseHits(text) {
  const re = new RegExp(NO_WRITE_PHRASE.source, 'g')
  let m = re.exec(text)
  while (m !== null) {
    if (!MENTION_SUBJECT.test(text.slice(Math.max(0, m.index - 12), m.index))) return true
    /* 零宽匹配时手动前移，避免 exec 原地打转 */
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1
    m = re.exec(text)
  }
  return false
}

/* ── ①-b 分阶段要求：写入**还没被授权** ────────────────────────
 *
 * 「先调查，未经批准不要修改」—— 这句禁的不是某个对象，而是「现在还不许写」。
 * 它没有宾语，② 抓不到，所以必须单独列一条，否则修 ② 之后它会被**放行**
 * （要求 6：不得把尚未授权的写入自动放行）。
 *
 * ★ 只收「缺授权」的强信号。「先分析一下这个 bug 再改」这种**已经授权、
 *   只是要求顺序**的不在此列 —— 那句话本轮就该能改，拦它是又一次误判。
 *
 * ★ 2026-10-17 修掉的第三次误判（3B-1 实测，上一轮报告的根因是错的，在此更正）：
 *
 *   用户写「**未经批准**创建新的 Git commit」—— 那是在**保护一个具体动作**
 *   （提交要单独批准），不是"整轮别动"。旧判据只看「未经批准」四个字就整轮锁死，
 *   开发 Agent 连 run_shell / write_file 全被拒（而被误判的那句话本身是**授权**
 *   开发源码修改的同一段话里的）。
 *
 *   判据：短语之后 10 字内必须出现**写类动作**才算数（「未经批准不要修改」算，
 *   「未经批准创建 commit」不算）。方向仍是"宁可漏放"：漏放由 PermissionBar 兜底，
 *   错拦则整轮全废。
 */
const PHASED_LACK =
  '(未经(我)?(明确)?(批准|同意|确认|授权)|未获(得)?(批准|授权)|等(我|用户)(来)?(批准|确认)|待(我|用户)(来)?(批准|确认))'

const NO_WRITE_PHASED = new RegExp(
  `${PHASED_LACK}[^。！？；\\n]{0,10}(写|改|改动|修改|编辑|覆盖|删除|落盘|动)` +
    '|经(我|用户)确认后再|确认后再(写|改|修改|动)',
)

/* ── ② 泛动词 + 文件类对象（必须同现）────────────────────────
 *
 * `(?!成)` 挡的是「写成/改成」这类**输出要求**的固定搭配：
 *   「不许写成确定的事实」「不要写成代码」都不该算「别动文件」。
 * 窗口 `{0,12}` 且不跨句末标点 —— 免得隔了半句话的两个词凑成一次命中。
 *
 * ★ 宾语清单**只收具体对象**（文件 / 代码 / 仓库…）。「东西」这类泛名词
 *   收过一次又删了：它会把「不要写，先讲清楚这个东西」误判成禁写 ——
 *   宾语越泛，误判越多，而漏判（罕见说法没拦住）最多只是那一轮没生效。
 */
const NO_WRITE_VERB_OBJECT =
  /(不许|不要|不准|严禁|禁止|不能|别|切勿|不)(再|去|自己|乱|随便)?(写|改|改动|修改|动|碰|删|删除|覆盖)(?!成)([^。！？；\n]{0,12})(文件|代码|脚本|配置|仓库|目录|磁盘|硬盘|项目|数据库|落盘|产物)/

/* ── ②-b 修饰段的**具体限定**：禁的是「某几个特定对象」，不是整轮 ──
 *
 * ★ 2026-10-17 修掉的误判（本轮之前连拦三次正常开发）
 *
 *   用户写「不修改用户全局 Codex 配置」—— 那是在**保护一个特定对象**，
 *   其余已授权的修改照做。旧判据只看「否定词 + 泛动词 + 12 字内 + 文件类宾语」，
 *   于是整轮 `allowWrite=false`，`run_shell` / `write_file` 全被拒，
 *   而那句话的本意只是"别碰全局那份配置"。
 *
 *   判据：看**动词与宾语之间**那段修饰语（第 4 组）。含下列强信号 = 指向特定对象。
 *     · 拉丁字母 / 数字 / 点 —— 专名（Codex / Harbor.exe / config.json）
 *     · 指示与限定：该 此 这个 那个 上述 前述 前面 现有 原有 既有 指定 特定 被保护
 *     · 范围与版本：正式 历史 生产 稳定版 测试版 打包版 用户全局
 *
 * ★ 2026-10-17（3C-2）再补一类：**文件类别**（测试 / 单测 / 自检 / 文档 / 注释）。
 *   真机踩到：「不要改测试文件去迁就实现」被判成整轮只读，于是 `run_project_test`
 *   与 `apply_test_fix` 一起被拒 —— 那句话的本意恰恰是**只保护测试文件**，
 *   好让修复必须改源码。它和「不要修改任何测试文件」（全量词，仍拦）不是一回事。
 *
 * ★ 为什么「我的」**不在**清单里：「不要改我的文件」指的是说话人**全部**文件，
 *   实质上就是整轮 —— 自检 153 组钉着这条，别为了省事把它放进来。
 * ★ 为什么清单只收**强信号**：漏放一个罕见说法，最多是那一轮没生效（无害）；
 *   错拦一次，整轮工具全废（正是这次要修的病）。方向必须是"宁可漏放"。
 */
const SCOPED_MODIFIER =
  /[A-Za-z]|\d|\.|该|此|这个|那个|上述|前述|前面|现有|原有|既有|指定|特定|被保护|正式|历史|生产|稳定版|测试版|打包版|用户全局|测试|单测|自检/

/* ── ②-c 修饰段的**全量词**：反过来，一定是整轮 ──
 *
 * ★ 为什么必须有这一条（自测逮到的漏放）：
 *   「不要修改**任何** .js 文件」「不要修改**所有** config.json」——
 *   修饰段里带着 `.` 和拉丁字母，被 ②-b 判成"具体对象"就**放行**了。
 *   但这两句指的是"那一整类/那一整套"，就是整轮。没这一条会真的漏放。
 *
 * 优先级：全量词 > 具体限定。含义不明确时按整轮处理（要求 7：保持安全边界）。
 */
const EXHAUSTIVE_MODIFIER = /任何|所有|全部|一切|每个|每一|任一|各个|都/

/* ── 联网（判据保持原样，只是搬了个家）──────────────────────── */

const NO_NETWORK_PHRASE = /(不联网|不要联网|禁止联网|离线)/

/**
 * ② 的「逐个匹配」版本：命中的那几处里，**只要有一处**说的是"全部"就算整轮禁写。
 *
 * 为什么不能直接用 `NO_WRITE_VERB_OBJECT.test()`：它只回 true/false，
 * 拿不到「动词与宾语之间到底是什么」，于是区分不了
 * 「不要改**我的**文件」（全部）和「不修改**用户全局 Codex** 配置」（特定一个）。
 *
 * @param {string} text
 * @returns {boolean}
 */
function blocksAllWrites(text) {
  const re = new RegExp(NO_WRITE_VERB_OBJECT.source, 'g')
  let m = re.exec(text)
  while (m !== null) {
    const modifier = String(m[4] ?? '')
    /* 全量词（任何 / 所有 / 全部…）→ 无论后面点了什么名，都是整轮 */
    if (EXHAUSTIVE_MODIFIER.test(modifier)) return true
    /* 这一段是"具体的某一个对象" → 这句不升级为整轮只读 */
    if (!SCOPED_MODIFIER.test(modifier)) return true
    /* 零宽匹配时手动前移，避免 exec 原地打转 */
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1
    m = re.exec(text)
  }
  return false
}

/**
 * 这轮算不算「别动东西」。
 *
 * 三层：① 明确短语（语义自足）· ①-b 缺授权的分阶段要求 · ② 泛动词 + 宾语且**没说具体是哪一个**。
 *
 * @param {string} [userText] 历史里最后一条用户消息的原文（`loop-route.lastUserText`）
 * @returns {boolean}
 */
function noWriteIn(userText) {
  const raw = typeof userText === 'string' ? userText : ''
  /* 先剥引号：被**提到**的那句话不是这一轮的命令（见 ①′） */
  const text = stripQuoted(raw)
  if (phraseHits(text)) return true
  if (NO_WRITE_PHASED.test(text)) return true
  return blocksAllWrites(text)
}

/* ── ⑤ 本轮**明确授权动手**的说法（2026-11-06）────────────────
 *
 * 用途：写工具前面那道「覆盖已有文件要先问一声」（`tools/pre-write-gate.cjs` 的 C 闸）
 * 靠它判断「这条已经批过了，别再问一遍」。
 * 本轮真机现场就是它：用户原话「本轮明确授权修改相关源码、测试、规范及必要的构建产物」，
 * C 闸照样拦下第一次覆盖 —— 把已经批过的事又问了一遍。
 * 只收**给了范围或明确许可**的强信号；不收裸的「可以」（「这个可以吗」不是授权）。
 */
const GRANT_PHRASE =
  /(明确授权|授权你|我授权|允许(你)?(修改|改动|编辑|写入|更新)|可以直接(改|修改|动手)|不用(再)?(问|确认)|别问我|你看着办|自行决定|放手做)/

/** 这一轮用户是不是**明确授权动手**了 */
function grantsWriteIn(userText) {
  const text = typeof userText === 'string' ? userText : ''
  return GRANT_PHRASE.test(text)
}

/**
 * 这轮算不算「别联网」。
 *
 * @param {string} [userText]
 * @returns {boolean}
 */
function noNetworkIn(userText) {
  const text = typeof userText === 'string' ? userText : ''
  return NO_NETWORK_PHRASE.test(text)
}

/**
 * 这轮允许写 / 改东西吗。
 *
 * 显式设置（`threadSettings.allowWrite`，会话级开关）**优先于**文本启发式：
 * 用户/界面明确关了就是关了；明确开着（undefined 也算没关）再看他说了什么。
 * `mode === 'plan'` 是既有的硬规则（计划模式不落地改动）。
 *
 * @param {{ userText?: string, mode?: string, threadAllowWrite?: boolean }} input
 * @returns {boolean}
 */
function allowsWrite(input = {}) {
  const { userText = '', mode = '', threadAllowWrite } = input
  if (threadAllowWrite === false) return false
  if (mode === 'plan') return false
  return !noWriteIn(userText)
}

/**
 * 这轮允许联网吗。
 *
 * @param {{ userText?: string, threadAllowNetwork?: boolean }} input
 * @returns {boolean}
 */
function allowsNetwork(input = {}) {
  const { userText = '', threadAllowNetwork } = input
  if (threadAllowNetwork === false) return false
  return !noNetworkIn(userText)
}

module.exports = {
  STOP_PHRASES,
  NO_WRITE_PHRASE,
  NO_WRITE_PHASED,
  NO_WRITE_VERB_OBJECT,
  SCOPED_MODIFIER,
  EXHAUSTIVE_MODIFIER,
  NO_NETWORK_PHRASE,
  GRANT_PHRASE,
  noWriteIn,
  grantsWriteIn,
  blocksAllWrites,
  stripQuoted,
  noNetworkIn,
  allowsWrite,
  allowsNetwork,
}

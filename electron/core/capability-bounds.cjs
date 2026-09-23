/**
 * 能力边界：哪些活我干不了（②-5）
 *
 * ── 要解决的问题 ──
 * README 里有一张「任务类型矩阵」（哪些稳定、哪些实验性、哪些不做），
 * 但**界面上没有任何提示**。用户说「帮我一直盯着这个页面」时，
 * 它会一本正经地跑一轮，然后停下来 —— 用户才从行为里反推出「原来不做常驻」。
 * 这一类期望落差是体验里最贵的一种：不是功能缺失，是**预期没对齐**。
 *
 * ── 三条讲究 ──
 *
 * ① **提前说，但不拦**。命中只出一条提示，消息照发、活照跑。
 *    判断「这事做不做得了」是用户的事，我们只负责在他动手之前把边界摆出来。
 *    拦下来反而更糟：模式匹配一定会误伤（「监控面板」不是「常驻监控」）。
 *
 * ② **模式写窄，不写宽**。「监控」这种词太泛 —— 正常的「帮我看看这个监控面板」
 *    会被误报，而误报一次用户就再也不看这类提示了。宁可漏，不要吵。
 *
 * ③ **给出去路，不只是拒绝**。「不做常驻后台」后面必须跟一句
 *    「要按点跑可以用定时任务」——否则用户只知道此路不通。
 *
 * ── 和 README 的关系 ──
 * 这份清单是 README「任务类型矩阵」的**可执行版本**。改了一边记得改另一边：
 * 矩阵里说「不做」的，这里该有；矩阵升格的（比如以后真支持跨仓库了），
 * 这里要摘掉。测试里钉着几条对应关系（见 78-bounds.mjs）。
 */

/**
 * `level` 只有两种：
 *   · `never`        —— 明确不做。提示里说清「不做」，并给替代路径
 *   · `experimental` —— 能做，但别指望它靠谱（README 里标「实验性」的那几条）
 */
const BOUNDS = [
  {
    key: 'background',
    level: 'never',
    label: '常驻后台盯着',
    /* 窄到只认「一直在盯」这种说法，别把「看一眼」也算进来 */
    patterns: [/一直(盯着|看着|守着|监听着)/, /一有(变化|更新|动静|消息)就(告诉我|通知我|提醒我)/, /24 ?小时/, /全天候/],
    note: '不做常驻后台：它只在你说一句话之后跑一轮。要按点自动跑，用「设置 → 定时任务」——每一轮仍受预算上限管着，不会没完没了地烧 token。',
  },
  {
    key: 'cloud',
    level: 'never',
    label: '云同步 / 多人协作',
    patterns: [/同步到云/, /(团队|同事|多人)(一起|共享|协作)/, /分享给(同事|别人|团队)/],
    note: '不做云同步和多人协作：所有数据只在本机 `data/` 里。要给别人看，只能手动把文件发过去。',
  },
  {
    key: 'mobile',
    level: 'never',
    label: '手机端',
    patterns: [/手机上(也能)?(用|看|跑)/, /手机(端|App)/],
    note: '没有手机端，也不打算做 —— Harbor 是本机桌面应用。',
  },
  {
    key: 'longrun',
    level: 'never',
    label: '跑一整天没人看',
    patterns: [/跑一整天/, /不用管它|别管它|自动跑完/, /(通宵|整晚)(跑|干)/],
    note: '不做「无人值守跑一整天」——轮数 / token / 时长三个上限就是为这件事装的。撞上限时它会停下来等你，不是失败。',
  },
  {
    key: 'crossRepo',
    level: 'experimental',
    label: '跨仓库操作',
    patterns: [/(两个|几个|多个)仓库/, /跨仓库/, /另一个仓库/],
    note: '跨仓库是实验性的：没有多项目隔离模型，一次只在一个工作目录里干活。真要做，拆成两轮、每轮换一次工作目录更稳。',
  },
  {
    key: 'prod',
    level: 'experimental',
    label: '动弹生产环境',
    patterns: [/(线上|生产|正式)(数据库|环境|服务器)/, /部署到(线上|生产)/],
    note: '别拿它碰生产：风险分级会拦下 critical 的操作，但「拦得住」不等于「该试」。这类改动建议自己手动做。',
  },
]

/**
 * 这句话碰到边界了吗。
 *
 * @param {string} text 用户说的话
 * @returns {{ key: string, level: string, label: string, note: string, matched: string } | null}
 *   `null` = 没碰到（绝大多数消息都是）。`matched` 是命中的原文片段，用来告诉用户
 *   「我是从哪句看出来的」—— 提示里给出来，误报时他才好判断。
 */
function check(text) {
  const value = String(text ?? '')
  if (!value.trim()) return null
  for (const bound of BOUNDS) {
    for (const pattern of bound.patterns) {
      const hit = pattern.exec(value)
      if (hit) {
        return {
          key: bound.key,
          level: bound.level,
          label: bound.label,
          note: bound.note,
          matched: hit[0],
        }
      }
    }
  }
  return null
}

/** 给设置页 / 文档用：整张表 */
function list() {
  return BOUNDS.map((item) => ({
    key: item.key,
    level: item.level,
    label: item.label,
    note: item.note,
  }))
}

module.exports = { BOUNDS, check, list }

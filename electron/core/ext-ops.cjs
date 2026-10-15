/**
 * 主进程侧：扩展通道的**分派表**（kind → 处理函数）—— Phase 3a
 *
 * ── 为什么从 ext-bridge.cjs 拆出来 ───────────────────────────
 *
 * bridge 已经 288 行，再加「分派 + 应答 + 推送 + 裸 JSON 兜底」会超 300 红线。
 * 而这块逻辑本身自洽（「拿 payload → 干活 → 给结果」），且**依赖注入** ——
 * 自检能喂假 session / 假 audit 直接跑，不必起管道服务器。
 *
 * ── ★ 处理函数一律**同步** ──────────────────────────────────
 *
 * 落会话、读会话列表都是本地同步 I/O。保持同步有两个好处：
 *   ① bridge 的管道回调里能**同步处理、同步回写**，不引入时序问题；
 *   ② 自检可以直接调，不用 await。
 * （真正的异步只在 `ext-client.cjs` 那一侧 —— 那是网络 I/O。）
 *
 * ⚠️ 本模块**不 require electron**（bridge 与 host 侧都要能加载它）。
 */

const P = require('./ext-protocol.cjs')
/* M03：观察结果 → markdown。纯函数，单独一个文件（ext-ops 贴 300 红线） */
const { renderObservation } = require('./ext-observe.cjs')

/**
 * @param {{
 *   session: { list: Function, load: Function, create: Function, append: Function },
 *   audit: { record: Function },
 *   wrap: (input: { url?: string, title?: string, text?: string, truncated?: boolean }) => string,
 *   send: (name: string, payload: object) => void,
 *   getActiveSession?: () => string,
 *   chat?: {
 *     handleSend: Function,
 *     handleResume: Function,
 *     handleSelect: Function,
 *     handleNew: Function,
 *   },
 * }} deps
 */
function createOps(deps) {
  const session = deps.session
  const audit = deps.audit
  const wrap = deps.wrap
  const send = deps.send
  const getActiveSession = deps.getActiveSession ?? (() => '')
  /* 侧边栏发消息那条路（Phase 3b）—— 它自己会回 `{ok:false,error}`（见下面 handle） */
  const chat = deps.chat ?? null

  /**
   * 把渲染好的文本落进会话 + 审计 + 推渲染层。
   *
   * ★ `ext:page`（M03 前的读页面）与 `page:observe`（M03 的结构化观察）**共用这一条**：
   *   落哪条会话、审计字段、推渲染层这三件事只有一份实现（硬约束 #9）。
   *   差别只在**传进来的 `content` 长什么样** —— 调用方各自渲染好。
   */
  function ingest(sessionTitleHint, content, auditTool, extras) {
    /* 决定落进哪条会话：优先「界面当前打开的那条」，否则新建一条专用会话 */
    let sessionId = String(getActiveSession() ?? '')
    let created = false
    /*
     * ★ 判「这条会话还在不在」必须**容错** —— `session.load` 对非法 id 会**抛**
     *   （session-io.cjs 校验 `sess_` 前缀）。自检真逮到过：渲染层报来一个怪 id，
     *   异常冒到 socket 层被兜成「消息不是合法 JSON」→ 内容静默丢 + 用户看到误导的错。
     */
    const alive = (id) => {
      if (!id) return false
      try {
        return Boolean(session.load(id).meta)
      } catch {
        return false
      }
    }
    if (!alive(sessionId)) {
      const meta = session.create({ title: `浏览器：${sessionTitleHint || '未命名页面'}`, mode: 'pair' })
      sessionId = meta.id
      created = true
    }

    const appended = session.append(sessionId, {
      role: 'user',
      content,
      ts: Date.now(),
      /* 标出这条不是用户手打的 —— 界面可以据此区别显示 */
      source: 'extension',
    })

    audit.record({
      sessionId,
      tool: auditTool,
      ok: appended.ok !== false,
      extras: { source: 'extension', createdSession: created, ...extras },
    })

    send('ext:page', { sessionId, created, ...extras })

    return { sessionId, created }
  }

  /**
   * `ext:page`：扩展读到的页面正文 → 包装 → 落会话。
   *
   * `payload` 的字段在**顶层**（不是嵌套的 `payload.payload`）—— 因为这条路
   * 同时服务两种调用：新协议（bridge 把 `message.payload` 拆出来）与旧单向路径
   * （老 host 的字段就在消息顶层，见 ext-bridge.cjs 的裸 JSON 兜底）。
   */
  function ingestPage(payload) {
    const url = String(payload?.url ?? '')
    const title = String(payload?.title ?? '')
    const text = String(payload?.text ?? '')
    const truncated = payload?.truncated === true

    /* ★ 包装是**安全职责**，必须做，且只做一次（和 browse 工具同一份实现） */
    const wrapped = wrap({ url, title, text, truncated })

    const res = ingest(title || url || '未命名页面', wrapped, P.KIND.EXT_PAGE, {
      url,
      title,
      chars: text.length,
      truncated,
    })
    return { sessionId: res.sessionId, chars: text.length, created: res.created }
  }

  /**
   * `page:observe`：M03 的结构化观察 → 包装 → 落会话。
   *
   * ★ 也过 `wrapWebText` —— 观察结果里**含网页上的文字**（元素标签、选区），
   *   那些同样是**不可信数据**，必须按「网页内容」对待（文档 §5.2 第 1 条：
   *   网页文本伪装系统指令）。包装在**渲染之后**做：先给人读的 markdown，
   *   再整体套上防注入抬头。
   */
  function observePage(payload) {
    const obs = payload?.observation && typeof payload.observation === 'object' ? payload.observation : null
    if (!obs) return fail(P.ERR.INTERNAL, '没收到观察数据')

    const url = String(obs.url ?? '')
    const title = String(obs.title ?? '')
    const rendered = renderObservation(obs)
    const wrapped = wrap({ url, title, text: rendered.markdown, truncated: rendered.truncated === true })

    const res = ingest(title || url || '未命名页面', wrapped, P.KIND.PAGE_OBSERVE, {
      url,
      title,
      chars: rendered.chars,
      truncated: rendered.truncated === true,
      pageVersion: String(obs.pageVersion ?? ''),
      elements: Number(obs?.stats?.elements ?? 0),
    })
    return {
      sessionId: res.sessionId,
      created: res.created,
      chars: rendered.chars,
      pageVersion: String(obs.pageVersion ?? ''),
      elements: Number(obs?.stats?.elements ?? 0),
      truncated: rendered.truncated === true,
    }
  }

  /** 统一的自给人话失败（与 chat 那几条同形状 —— bridge 才拿得到 code） */
  function fail(code, message) {
    return { ok: false, error: { code, message } }
  }

  /**
   * `session:list`：会话摘要（Phase 3a 新增）。
   *
   * ★ 字段**直接用 `session.list()` 的**，不另造形状（硬约束 #9）—— 侧边栏要的
   *   「id + 标题 + 最后活跃时间」正好是 `id` / `title` / `updatedAt`，都在里面。
   */
  function listSessions() {
    const list = session.list() ?? []
    return {
      sessions: list.map((s) => ({
        id: String(s.id ?? ''),
        title: String(s.title ?? ''),
        mode: String(s.mode ?? ''),
        model: String(s.model ?? ''),
        workdir: String(s.workdir ?? ''),
        projectId: String(s.projectId ?? ''),
        messageCount: Number(s.messageCount ?? 0),
        createdAt: Number(s.createdAt ?? 0),
        updatedAt: Number(s.updatedAt ?? 0),
      })),
    }
  }

  const table = {
    [P.KIND.EXT_PAGE]: (payload) => ingestPage(payload),
    [P.KIND.SESSION_LIST]: () => listSessions(),
    /* Phase 3b：侧边栏发消息 → 交给渲染层跑；重连要流快照；问「当前打开哪条」 */
    [P.KIND.CHAT_SEND]: (payload) => chat.handleSend(payload),
    [P.KIND.CHAT_RESUME]: (payload) => chat.handleResume(payload),
    [P.KIND.SESSION_ACTIVE]: () => ({ sessionId: String(getActiveSession() ?? '') }),
    /* Phase 3c：选一条（只切侧边栏）/ 新建一条（两侧都切） */
    [P.KIND.SESSION_SELECT]: (payload) => chat.handleSelect(payload),
    [P.KIND.SESSION_NEW]: () => chat.handleNew(),
    /* M03：结构化页面观察（选区 / 元素列表 / iframe / 页面版本号） */
    [P.KIND.PAGE_OBSERVE]: (payload) => observePage(payload),
  }

  /**
   * 处理一条请求。**不抛** —— 一切都变成 `{ok:false,error}`。
   *
   * @param {string} kind
   * @param {object} [payload]
   * @returns {{ ok: true, data: object } | { ok: false, error: { code: string, message: string } }}
   */
  function handle(kind, payload) {
    const key = String(kind ?? '')
    const fn = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null
    if (!fn) {
      return {
        ok: false,
        error: { code: P.ERR.UNKNOWN_KIND, message: `不认识的消息类型：${key || '(空)'}` },
      }
    }
    try {
      const data = fn(payload)
      /*
       * ★ `chat:send` / `chat:resume` 这类**自己**给 `{ok:false,error:{code,message}}`
       *   （忙 / 没窗口 / 没会话都是正常业务分支，不是异常）—— 原样透传，
       *   别再用 `{ok:true,data:…}` 套一层（那会让 bridge 拿不到 code）。
       */
      if (data && typeof data === 'object' && data.ok === false && data.error) return data
      return { ok: true, data }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: P.ERR.INTERNAL,
          message: `Harbor 处理失败：${error instanceof Error ? error.message : error}`,
        },
      }
    }
  }

  return { handle, kinds: () => Object.keys(table) }
}

module.exports = { createOps }

/**
 * 主进程侧：扩展通道的**分派表**（kind → 处理函数）
 * 从 `ext-bridge.cjs` 拆出来的（那边要超 300 红线）。这块逻辑自洽（「拿 payload →
 * 干活 → 给结果」）且**依赖注入** —— 自检能喂假 session / 假 audit 直接跑。
 * ★ 处理函数一律**同步**：bridge 的管道回调里能同步处理、同步回写（不引时序问题），
 *   自检也能直接调。真正的异步只在 `ext-client.cjs` 那一侧（网络 I/O）。
 * ⚠️ 本模块**不 require electron**（bridge 与 host 侧都要能加载它）。
 */

const P = require('./ext-protocol.cjs')
const { renderObservation, renderElements, renderAction } = require('./ext-observe.cjs')
/* M04：ref 失效判据（`inspectRef`）只有那一处 —— 这里只调，不另写一套 */
const { inspectRef } = require('./ext-command.cjs')
/* 2026-10-20：「这条内容落哪条会话」的判定**只有那一处**（修侧边栏串线） */
const { decideSessionId } = require('./ext-route.cjs')
/* 2026-10-20：站点黑名单（用户拉黑的站点 → 读不了也点不动） */
const sites = require('./ext-sites.cjs')
/* 2026-10-21：页面上下文槽（页面内容不进对话流，改装进提示词） */
const pageCtx = require('./page-context-slot.cjs')
const { ingestPageContext } = require('./page-context-ingest.cjs')

/**
 * @param {{
 *   session: { list: Function, load: Function, create: Function, append: Function },
 *   audit: { record: Function },
 *   wrap: (input: { url?: string, title?: string, text?: string, truncated?: boolean, source?: string }) => string,
 *   send: (name: string, payload: object) => void,
 *   getActiveSession?: () => string, getSelectedSession?: () => string,
 *   chat?: { handleSend: Function, handleResume: Function, handleSelect: Function,
 *            handleNew: Function, handleAbort: Function, handleRegenerate: Function },
 *   command?: { handleResult: Function },
 * }} deps
 */
function createOps(deps) {
  const session = deps.session
  const audit = deps.audit
  const wrap = deps.wrap
  const send = deps.send
  const getActiveSession = deps.getActiveSession ?? (() => '')
  /* 侧边栏选中的那条 —— 与「主窗口当前打开」是两个概念，判定顺序见 ext-route.cjs */
  const getSelectedSession = deps.getSelectedSession ?? (() => '')
  /* 侧边栏发消息那条路（Phase 3b）—— 它自己会回 `{ok:false,error}`（见下面 handle） */
  const chat = deps.chat ?? null
  /* M04：下行指令的回执配对（扩展执行完回一帧，见 core/ext-command.cjs） */
  const command = deps.command ?? null

  /** 把渲染好的文本落进会话 + 审计 + 推渲染层（`ext:page` / `page:observe` / `page:elements` 共用，硬约束 #9） */
  function ingest(sessionTitleHint, content, auditTool, extras, explicitSessionId) {
    /* 落哪条会话：判定只有一处（ext-route.cjs）。2026-10-20 修两处串线：
       以前只认 getActiveSession()；现在明确指定但已失效也会拒绝（不回退）。 */
    const decided = decideSessionId({
      explicit: explicitSessionId,
      selected: getSelectedSession(),
      active: getActiveSession(),
      /* 容错：session.load 对非法 id 会抛（session-io 校验 sess_ 前缀），
         不兜住的话异常冒到 socket 层会被当成「消息不是合法 JSON」。 */
      alive: (id) => {
        try {
          return Boolean(session.load(id).meta)
        } catch {
          return false
        }
      },
    })
    /* ★ 明确指定但已失效 → 不写、不新建、不回退（回退就是换个条件再串一次线） */
    if (decided.error) return { sessionId: '', created: false, error: decided.error }
    let sessionId = decided.sessionId
    let created = false
    if (!sessionId) {
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
      extras: { source: 'extension', createdSession: created, routedBy: decided.source, ...extras },
    })

    send('ext:page', { sessionId, created, ...extras })

    return { sessionId, created }
  }

  /** `ext:page`：扩展读到的页面正文 → 包装 → 落会话。字段在**顶层**（同时服务旧单向路径）。 */
  function ingestPage(payload) {
    const url = String(payload?.url ?? '')
    const title = String(payload?.title ?? '')
    const text = String(payload?.text ?? '')
    const truncated = payload?.truncated === true

    /* ★ 包装是**安全职责**，必须做，且只做一次（和 browse 工具同一份实现） */
    const wrapped = wrap({ url, title, text, truncated, source: 'edge' })
    /* 扩展带来的 sessionId 一律优先（它最清楚读到的东西属于哪条对话） */
    const res = ingest(
      title || url || '未命名页面',
      wrapped,
      P.KIND.EXT_PAGE,
      { url, title, chars: text.length, truncated },
      payload?.sessionId,
    )
    if (res.error) return fail(P.ERR.NO_SESSION, res.error)
    return { sessionId: res.sessionId, chars: text.length, created: res.created }
  }

  /**
   * `page:observe`：M03 的结构化观察 → 包装 → 落会话。
   *
   * ★ 也过 `wrapWebText`：观察结果里含网页上的文字（元素标签、选区），那同样是
   *   **不可信数据**（网页文本可伪装系统指令）。包装在渲染**之后**做。
   */
  function observePage(payload) {
    const obs = payload?.observation && typeof payload.observation === 'object' ? payload.observation : null
    if (!obs) return fail(P.ERR.INTERNAL, '没收到观察数据')

    const url = String(obs.url ?? '')
    const title = String(obs.title ?? '')
    const rendered = renderObservation(obs)
    const wrapped = wrap({ url, title, text: rendered.markdown, truncated: rendered.truncated === true, source: 'edge' })

    const res = ingest(
      title || url || '未命名页面',
      wrapped,
      P.KIND.PAGE_OBSERVE,
      {
        url,
        title,
        chars: rendered.chars,
        truncated: rendered.truncated === true,
        pageVersion: String(obs.pageVersion ?? ''),
        elements: Number(obs?.stats?.elements ?? 0),
      },
      payload?.sessionId,
    )
    if (res.error) return fail(P.ERR.NO_SESSION, res.error)
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

  /** `session:list`：会话摘要。字段直接用 `session.list()` 的，不另造形状（硬约束 #9） */
  function listSessions() {
    const list = session.list() ?? []
    return {
      sessions: list.map((s) => ({
        id: String(s.id ?? ''), title: String(s.title ?? ''), mode: String(s.mode ?? ''), model: String(s.model ?? ''),
        workdir: String(s.workdir ?? ''), projectId: String(s.projectId ?? ''), messageCount: Number(s.messageCount ?? 0),
        createdAt: Number(s.createdAt ?? 0), updatedAt: Number(s.updatedAt ?? 0),
      })),
    }
  }

  /**
   * `page:elements`：元素列表视图（M04-1 `browser.getElements`）。与 `page:observe`
   * **同一份采集**，只是渲染成「只要元素」的视图并解析调用方给的 ref。
   */
  function ingestElements(payload) {
    const obs = payload?.observation && typeof payload.observation === 'object' ? payload.observation : null
    if (!obs) return fail(P.ERR.INTERNAL, '没收到页面元素数据（扩展侧采集失败？）')
    const ref = String(payload?.ref ?? '')
    const elements = Array.isArray(obs.elements) ? obs.elements : []
    const pageVersion = String(obs.pageVersion ?? '')
    const parsed = inspectRef(ref, pageVersion, elements)
    const rendered = renderElements(obs, { ref, parsed })
    const url = String(obs.url ?? '')
    const title = String(obs.title ?? '')
    const wrapped = wrap({ url, title, text: rendered.markdown, truncated: rendered.truncated === true, source: 'edge' })
    const extras = {
      url,
      title,
      chars: rendered.chars,
      truncated: rendered.truncated === true,
      pageVersion,
      elements: elements.length,
      ref,
      stale: parsed.stale === true,
    }

    const res = ingest(title || url || '未命名页面', wrapped, P.KIND.PAGE_ELEMENTS, extras, payload?.sessionId)
    if (res.error) return fail(P.ERR.NO_SESSION, res.error)
    return {
      sessionId: res.sessionId,
      created: res.created,
      chars: rendered.chars,
      pageVersion,
      elements: elements.length,
      ref,
      stale: parsed.stale === true,
      reason: parsed.reason,
      truncated: rendered.truncated === true,
    }
  }

  /** **操作结果落盘**（M04-2）—— click / verify 走这条。不在分派表里：它不是扩展发来的
   *  消息，是主进程内部「干完活记一笔」，由 `ext-bridge.landAction()` 直接调。 */
  function ingestAction(kind, result, meta) {
    const k = String(kind ?? 'click')
    const rendered = renderAction(k, result, meta)
    const url = String(meta?.url ?? '')
    const title = String(meta?.title ?? '')
    const wrapped = wrap({ url, title, text: rendered.markdown, truncated: rendered.truncated === true, source: 'edge' })
    const res = ingest(title || url || '未命名页面', wrapped, `page:${k}`, {
      url,
      title,
      chars: rendered.chars,
      truncated: rendered.truncated === true,
      action: k,
      ref: String(result?.ref ?? ''),
      ok: result?.ok === true,
      reason: String(result?.reason ?? ''),
      durationMs: Number(meta?.durationMs ?? 0),
    })
    /* ★ `markdown` 一起返回：工具直接用这份讲给模型听 ——「操作结果 → 文本」只有这一处实现。 */
    return { sessionId: res.sessionId, chars: rendered.chars, truncated: rendered.truncated === true, markdown: rendered.markdown }
  }

  const table = {
    [P.KIND.EXT_PAGE]: (payload) => ingestPage(payload),
    /* 页面上下文槽（2026-10-21）：只更新槽，**不写会话文件** —— 不进对话流。
       两条来源（正文 / 结构化观察）的判定搬到 `page-context-ingest.cjs`。 */
    [P.KIND.PAGE_CONTEXT]: (payload) => ingestPageContext(payload, { selected: getSelectedSession }),
    [P.KIND.SESSION_LIST]: () => listSessions(),
    /* Phase 3b：侧边栏发消息 → 交给渲染层跑；重连要流快照；问「当前打开哪条」 */
    [P.KIND.CHAT_SEND]: (payload) => chat.handleSend(payload),
    [P.KIND.CHAT_RESUME]: (payload) => chat.handleResume(payload),
    /* M02-A2：侧边栏点「停止」→ 请渲染层停那条会话（回执如实，没在跑就说没停） */
    [P.KIND.CHAT_ABORT]: (payload) => chat.handleAbort(payload),
    [P.KIND.CHAT_REGENERATE]: (payload) => chat.handleRegenerate(payload),
    [P.KIND.SESSION_ACTIVE]: () => ({ sessionId: String(getActiveSession() ?? '') }),
    /* Phase 3c：选一条（只切侧边栏）/ 新建一条（两侧都切） */
    [P.KIND.SESSION_SELECT]: (payload) => {
      const id = String(payload?.sessionId ?? '')
      try {
        return id && session.load(id).meta ? chat.handleSelect(payload) : fail(P.ERR.NO_SESSION, '这条对话已不存在，请刷新列表后重试')
      } catch { return fail(P.ERR.NO_SESSION, '这条对话已不存在，请刷新列表后重试') }
    },
    [P.KIND.SESSION_NEW]: () => chat.handleNew(),
    /* M03：结构化观察 / M04-1：元素列表视图（ref 失效由 inspectRef 判） */
    [P.KIND.PAGE_OBSERVE]: (payload) => observePage(payload),
    [P.KIND.PAGE_ELEMENTS]: (payload) => ingestElements(payload),
    /* M04：扩展执行完下行指令的回执 —— 按 id 配对（见 core/ext-command.cjs） */
    [P.KIND.PAGE_RESULT]: (payload) => (command ? command.handleResult(payload) : { ok: true, matched: false }),
    /* 站点策略在 ext-sites.cjs 判定；不缓存，撤销立即生效。 */
    [P.KIND.SITE_POLICY]: (payload) => sites.handleRequest(payload),
  }

  /** 处理一条请求。**不抛** —— 一切都变成 `{ok:false,error}`。自己给了 `ok:false` 的原样透传，
   *  别用 `{ok:true,data:…}` 套一层（那会让 bridge 拿不到 code）。 */
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
      /* 自己给了 {ok:false,error} 的原样透传（别套 {ok:true,data} —— bridge 会拿不到 code） */
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

  return { handle, kinds: () => Object.keys(table), ingestAction }
}

module.exports = { createOps }

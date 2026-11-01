/**
 * `tools/e2e-scroll-return.mjs` 的夹具与动作库（拆出来只为守住 300 行红线）
 *
 * 这里只放**两样**：隔离数据的种子会话，以及「在页面里怎么量、怎么点」的表达式。
 * 判据和流程留在主文件里 —— 那是这次验收真正要读的东西，不该埋进工具函数。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { sleep, evaluate } from './shot/cdp.mjs'

export const ID_A = 'sess_probea1'
export const ID_B = 'sess_probeb1'
export const TITLE_A = 'PROBE 长对话 A'
export const TITLE_B = 'PROBE 短对话 B'

/** 视口顶那条消息 + 它的相对偏移（判据口径和实现同一套：消息顶 − 视口顶） */
export const PROBE_TOP = `(function(){
  var sc = document.querySelector('div[tabindex="-1"]');
  if (!sc) return null;
  var s = sc.getBoundingClientRect().top;
  var els = [...document.querySelectorAll('[data-message-id]')];
  for (var i=0;i<els.length;i++){
    var r = els[i].getBoundingClientRect();
    if (r.bottom > s+1) return { id: els[i].getAttribute('data-message-id'), top: Math.round(r.top - s), total: els.length, scrollTop: Math.round(sc.scrollTop), bottomGap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
  }
  return { id: null, top: 0, total: els.length, scrollTop: Math.round(sc.scrollTop), bottomGap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
})()`

/** 某条消息此刻相对视口顶的像素（读不到 = null，别当成 0） */
export const offsetOf = (id) => `(function(){
  var el = document.querySelector('[data-message-id="'+${JSON.stringify(id)}+'"]');
  if (!el) return null;
  var sc = document.querySelector('div[tabindex="-1"]');
  if (!sc) return null;
  return Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top);
})()`

/** 滚到「某条消息的顶落在视口顶往上 offset 像素」处（等价于拖滚动条） */
export const scrollToMsg = (id, offset) => `(function(){
  var sc = document.querySelector('div[tabindex="-1"]');
  var el = document.querySelector('[data-message-id="'+${JSON.stringify(id)}+'"]');
  if (!sc || !el) return 'missing';
  var s = sc.getBoundingClientRect().top;
  sc.scrollTop = sc.scrollTop + (el.getBoundingClientRect().top - s) - (${offset});
  return Math.round(sc.scrollTop);
})()`

export const PROCESS_OPEN = `(function(){
  var b = document.querySelector('button[aria-label="查看过程"]');
  return b ? b.getAttribute('aria-expanded') : 'none';
})()`

/** 种子：60 条 A + 1 条 B（会话 id 只用合法形态 sess_[a-z0-9]+） */
export function seedSessions(root, isoDir) {
  const sess = resolve(isoDir, 'sessions')
  mkdirSync(sess, { recursive: true })
  const now = Date.now()
  const line = (o) => JSON.stringify(o)
  const msgs = []
  for (let i = 0; i < 60; i += 1) {
    msgs.push(
      i % 2 === 0
        ? {
            type: 'message',
            role: 'assistant',
            key: `pa${i}`,
            content: `A 的第 ${i} 条回答。\n\n这里还有第二段，让它高一点。`,
            reasoning: i === 30 ? '这一段思考是用来展开过程面板的。' : '',
            ts: now - 900000 + i * 1000,
          }
        : {
            type: 'message',
            role: 'user',
            key: `pu${i}`,
            content: `A 的第 ${i} 条提问`,
            ts: now - 900000 + i * 1000,
          },
    )
  }
  const meta = (id, title, t) => ({
    type: 'meta',
    id,
    title,
    mode: 'pair',
    model: 'deepseek-flash',
    reasoning: 'high',
    workdir: '',
    createdAt: t,
    updatedAt: t,
  })
  const join = (rows) => rows.map(line).join('\n') + '\n'
  writeFileSync(
    resolve(sess, `${ID_A}.jsonl`),
    join([meta(ID_A, TITLE_A, now - 900000), ...msgs]),
  )
  writeFileSync(
    resolve(sess, `${ID_B}.jsonl`),
    join([
      meta(ID_B, TITLE_B, now),
      { type: 'message', role: 'user', key: 'pb1', content: 'B 的唯一提问', ts: now },
    ]),
  )
  /* 配置照抄主数据那份（密钥走 credentials，不在 config 里） */
  const conf = resolve(isoDir, 'config.json')
  if (!existsSync(conf)) {
    writeFileSync(
      conf,
      JSON.stringify(JSON.parse(readFileSync(resolve(root, 'data', 'config.json'), 'utf8')), null, 2),
    )
  }
  return [ID_A, ID_B]
}

/** 页面上的一串动作（都走同一个 evaluate，只是省掉每处重复的包装） */
export function actions(cdp) {
  const ev = (expr, label) => evaluate(cdp, expr, { label })
  const clickTitle = (title) =>
    ev(
      `(function(){
        var row = [...document.querySelectorAll('div[role="button"]')].find(function(e){ return (e.textContent||'').indexOf(${JSON.stringify(title)}) >= 0 });
        if (!row) return 'missing';
        row.click();
        return 'ok';
      })()`,
      `点会话 ${title}`,
    )
  /** 点「载入更早」直到消息全摊开（或点到 max 次） */
  const expandAll = async (want) => {
    /* 「载入更早」此刻在不在（补片过程中它会被藏起来，那不是「点到头了」） */
    const moreBtn = () =>
      ev(
        `(function(){
          var b = [...document.querySelectorAll('button')].find(function(x){ return (x.textContent||'').indexOf('载入更早') >= 0 });
          return b ? 'yes' : 'none';
        })()`,
        '找载入更早',
      )
    for (let i = 0; i < 12; i += 1) {
      const s = await ev(PROBE_TOP, '采样条数')
      if (s && s.total >= want) return s
      const clicked = await ev(
        `(function(){
          var b = [...document.querySelectorAll('button')].find(function(x){ return (x.textContent||'').indexOf('载入更早') >= 0 });
          if (!b) return 'none';
          b.click();
          return 'ok';
        })()`,
        '点载入更早',
      )
      if (clicked === 'none') {
        /*
         * ★ 按钮不在 ≠ 没有更多了：分片渲染期间按钮是**藏起来**的（`autoGrowing`），
         *   一次只补 1~4 条。以前这里直接 return，于是「摊开到 60 条」实际只到 25 条 ——
         *   后面的场景全在一个小窗口上跑，看着像恢复失败（真机抓过一次假失败）。
         *   现在等它回来再点。
         */
        let back = 'none'
        for (let k = 0; k < 40 && back === 'none'; k += 1) {
          await sleep(150)
          back = await moreBtn()
        }
        if (back === 'none') return ev(PROBE_TOP, '采样条数')
        continue
      }
      await sleep(700)
    }
    return ev(PROBE_TOP, '采样条数')
  }
  /** 真滚轮事件（走 CDP 的 Input 域，不是直接改 scrollTop） */
  const wheel = async (deltaY) => {
    const box = await ev(
      `(function(){ var sc = document.querySelector('div[tabindex="-1"]'); if(!sc) return null; var r = sc.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`,
      '滚动容器中心',
    )
    if (!box) return
    for (let i = 0; i < 3; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: box.x,
        y: box.y,
        deltaX: 0,
        deltaY,
      })
      await sleep(120)
    }
  }
  return { ev, clickTitle, expandAll, wheel }
}

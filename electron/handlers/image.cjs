const imageWatch = require('../core/image-watch.cjs')
const imageSave = require('../core/image-save.cjs')
const sessionWrite = require('../core/session-write.cjs')
const log = require('../core/log.cjs')

/* ══════════════════════════════════════════════════════════════
   生图出图之后干什么

   从 main.cjs 抽出来的（那边 350 行打不住了）。

   ── 为什么会有这个文件 ──

   生图是**异步**的：上游排队就要 5 分钟左右，所以 `generate_image`
   工具提交完立刻就返回了，不干等（干等会让界面卡五六分钟，一旦超时
   图还丢了）。真正出图时人早就不在那儿了 —— 所以由主进程负责：

     落盘 → 写成一条对话消息 → 通知前端刷新

   把这段放在 handlers/ 而不是 core/：core 层不该碰会话文件和窗口。
   ══════════════════════════════════════════════════════════════ */

function register({ send }) {
  imageWatch.setHandlers({
    onReady: async ({ taskId, image, model, sessionId, workdir, prompt }) => {
      try {
        const saved = await imageSave.saveImage(image, { workdir, sessionId })
        const alt = String(prompt ?? '')
          .replace(/[[\]]/g, '')
          .slice(0, 60)
        const content = [
          `图片生成好了（${model}）。`,
          '',
          `![${alt || '生成的图片'}](${saved.url})`,
          '',
          `已存到：${saved.file}`,
        ].join('\n')

        /* 写进会话 —— 刷新/重启后这条消息还在（不是只弹一下就没了） */
        if (sessionId) {
          sessionWrite.append(sessionId, { role: 'assistant', content, ts: Date.now() })
        }

        log.info(`生图完成：${taskId} → ${saved.file}`)
        send('image:progress', { taskId, sessionId, status: 'done', elapsedMs: 0 })
        send('image:ready', {
          taskId,
          sessionId,
          file: saved.file,
          url: saved.url,
          model,
          content,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn(`生图落盘失败：${message}`)
        send('image:failed', { taskId, sessionId, error: `图好了但保存失败：${message}` })
      }
    },

    /*
     * 每一轮的实时状态推给界面。
     * 用户要的是「看得见它在干什么」—— 排队中 / 正在画 / 已等待多久。
     * 只转圈不给信息，看着就像死了。
     */
    onProgress: ({ taskId, sessionId, status, elapsedMs }) => {
      send('image:progress', { taskId, sessionId, status, elapsedMs })
    },

    onFail: ({ taskId, sessionId, error }) => {
      log.warn(`生图失败：${taskId} — ${error}`)
      send('image:progress', { taskId, sessionId, status: 'failed', elapsedMs: 0 })
      send('image:failed', { taskId, sessionId, error })
    },
  })
}

module.exports = { register }

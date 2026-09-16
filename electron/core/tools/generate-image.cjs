const scene = require('../scene.cjs')
const { saveImage } = require('../image-save.cjs')

/*
 * generate_image —— 让 Agent 自己画图
 *
 * 用哪家、哪个模型，走的是「设置 → 对话 → 场景 → 画图」那一个配置 ——
 * 和输入框工具栏里那个「画图」按钮是同一个。配一次，两边都能用。
 *
 * ── 为什么是「提交完就返回」，而不是等出图 ──
 *
 * APIMart 光**排队**就要 5 分钟左右（实测：提交 02:51:32 → 任务 02:56:35
 * 才创建 → 02:56:47 完成，真正画只用 12 秒）。
 *
 * 早先的版本让工具同步干等，结果很难看：
 *   · 界面卡五六分钟，用户以为程序死了
 *   · 超时上限怎么调都不对 —— 180 秒不够，5 分钟还是差十几秒
 *   · 一旦超时图就丢了，模型被逼着用 `run_shell sleep` 硬等（真发生过）
 *
 * 现在：提交 → 立刻拿到 task_id 返回 → `image-watch` 在后台盯着 →
 * 出图后由 main 落盘并把图片**推进这条对话**。用户什么都不用管。
 *
 * ── 模型看不到图 ──
 * 返回给人看的是 markdown 图片；模型自己不认图（除非是多模态的）。
 * 所以文字里也要说清楚东西存在哪，方便下一步（比如塞进文档）。
 */

module.exports = {
  name: 'generate_image',
  description:
    '生成图片（文生图）。用「设置 → 场景 → 画图」里配的那个生图模型。prompt 要具体：主体、动作、环境、光线、风格。可选 size 指定比例（如 "16:9"、"1:1"）。★ 这个工具**只负责提交**，立刻返回任务号，不等待出图（上游要排队好几分钟）—— 出图后图片会自动出现在这条对话里。所以提交完**不要说「画好了」**，说「已提交，稍后出图」。要查进度时传 taskId + wait:false 看一眼上游状态。',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '画面描述，中英文都行。写具体：主体 / 动作 / 环境 / 光线 / 风格',
      },
      size: {
        type: 'string',
        description: '比例或像素，如 "16:9"、"1:1"、"1024x1024"。不填用服务端默认',
      },
      taskId: {
        type: 'string',
        description: '查已有任务、不重新生成（上一次提交拿到的那串 task_id）',
      },
      wait: {
        type: 'boolean',
        description:
          '配合 taskId 用：传 false 就只查一眼上游状态、立即返回（不等出图）。用户问「那个任务怎么样了」时用',
      },
    },
    /*
     * 不写 required：prompt 和 taskId 是「二选一」，
     * JSON Schema 的 required 表达不了或的关系。具体在 run 里查，报错也更清楚。
     */
  },

  /** 联网 + 花钱 + 往工作目录写文件 —— 归到需要确认那一类 */
  network: true,

  summarize(args) {
    const taskId = String(args?.taskId ?? '').trim()
    if (taskId && !String(args?.prompt ?? '').trim()) return `查询图片任务 ${taskId}`
    const prompt = String(args?.prompt ?? '').trim()
    const short = prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt
    return `生成图片：${short || '(空描述)'}`
  },

  async run(args, ctx = {}) {
    const prompt = String(args?.prompt ?? '').trim()
    const taskId = String(args?.taskId ?? '').trim()
    const size = String(args?.size ?? '').trim()
    const onlyCheck = args?.wait === false

    if (!prompt && !taskId) {
      throw new Error('要给我画面描述（prompt）；或者给一个 taskId，让我去查那张图')
    }

    /* ── ① 只查一眼：不等待、不下载，直接报上游状态 ── */
    if (taskId && onlyCheck) {
      const peek = await scene.generateImage({ taskId, once: true })
      if (peek.ok && peek.image) {
        const saved = await saveImage(peek.image, ctx)
        return [
          '图已经好了 ——',
          '',
          `![${altOf(prompt)}](${saved.url})`,
          '',
          `已存到：${saved.file}`,
        ].join('\n')
      }
      if (peek.pending) {
        return `上游现在还是「${peek.status || '未知'}」，还没出图。原始响应：${peek.raw || '(空)'}`
      }
      throw new Error(peek.error)
    }

    /* ── ② 用 taskId 把已有的图取回来（任务通常已完成，所以同步等没问题）── */
    if (taskId) {
      const got = await scene.generateImage({ taskId })
      if (!got.ok) throw new Error(got.error)
      const saved = await saveImage(got.image, ctx)
      return [
        `图取回来了（${got.model}）。`,
        '',
        `![${altOf(prompt)}](${saved.url})`,
        '',
        `已存到：${saved.file}`,
      ].join('\n')
    }

    /* ── ③ 提交新的：**立刻返回**，后台守望者接着盯 ── */
    const submitted = await scene.submitImage({
      prompt,
      size: size || undefined,
      sessionId: ctx.sessionId,
      workdir: ctx.workdir,
    })
    if (!submitted.ok) throw new Error(submitted.error)

    return [
      `已经提交给上游了（任务号 \`${submitted.taskId}\`，模型 ${submitted.model}）。`,
      '',
      '上游要**排队几分钟**才真正开始画（实测大约 5 分钟），所以我没有在这里干等 ——',
      '出图后图片会**自动出现在这条对话里**，不用你催、也不用再问一次。',
      '',
      '**现在还没画好**，跟用户说「已提交，稍等」就行，别说「画好了」。',
      '用户要查进度的话，用 `generate_image({ taskId: "' +
        submitted.taskId +
        '", wait: false })` 看一眼。',
    ].join('\n')
  },
}

/** markdown 图片的 alt 用 prompt 摘要；`[` `]` 会破坏语法，去掉 */
function altOf(prompt) {
  return (
    String(prompt ?? '')
      .replace(/[[\]]/g, '')
      .slice(0, 60) || '生成的图片'
  )
}

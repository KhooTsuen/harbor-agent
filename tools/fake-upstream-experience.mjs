/**
 * 假上游的 `experience` 模式：自我纠错闭环的真机验收
 *
 * 从 `fake-upstream.mjs` 拆出来的（那边贴 300 行红线）。为什么值得独立一个文件：
 * 别的坏法都是「造一个坏响应」，这一模式是**每轮都发同一条 `run_shell` 命令**，
 * 让内核真的经历「失败 → 候选 → 同一修法成功 → 升级 → 反例暂停」。
 *
 * 命令是 `type harbor-e2e-flag.txt`：文件在就退出码 0、不在就 1，
 * 于是「失败 / 成功 / 再失败」全由验收脚本在旁边改文件来决定，内核经历的是真实执行。
 * 为什么用 run_shell 而不是 read_file：独立验证器对命令类只认**结构化退出码**
 * （`experience-verify.cjs` 的 `shell_exit_zero`），这条链能把「不信模型自述」验到真处。
 *
 * ⚠️ 每轮**多一个空格**：`loop-guard` 会把「同一个调用连续 3 次」判成转圈并打断
 * （那是它的正事，不该为这套验收去放宽）。而经验那边看的是**做法签名**
 * （`experience-text.recipeOf` → `normalizeText` 会把连续空白压成一个）与**目标**
 * （`targetOf` → 按空白切前三段），所以空格多少不影响「这是同一条命令」。
 */

/** 轮次计数（一次验收一个进程） */
let rounds = 0
/** 上限：到顶就收尾，避免模型一直调工具把脚本拖死 */
const MAX_ROUNDS = Number(process.env.FAKE_EXPERIENCE_ROUNDS ?? 40)
/**
 * 每轮之间的节奏（毫秒）。脚本要在这段时间里改文件状态：不放开节奏的话 5 轮会在
 * 一秒内跑完，脚本还没来得及「造出文件」，就永远等不到那次成功 —— 那不是内核的问题，
 * 是这一幕没编排好。
 */
const PACE_MS = Number(process.env.FAKE_EXPERIENCE_PACE_MS ?? 1200)

/**
 * 被 `type` 的那个标志文件。**默认相对路径，验收脚本要传绝对路径** ——
 * 原因（2026-11-02 真机逮到）：`run_shell` 在**会话的工作目录**里跑命令，而新建的对话
 * 会继承上一次的目录（实测是 `E:\CodexWorkbench\tmp\p2-demo\beta0`），
 * 脚本却把文件写在隔离区的 `workspace/` 下 → 命令永远找不到它、永远失败，
 * 于是「失败之后怎么都等不到成功」，验收假红。
 */
const FLAG = String(process.env.FAKE_EXPERIENCE_FLAG ?? '').trim() || 'harbor-e2e-flag.txt'

const command = (round) => `type${' '.repeat(round)}"${FLAG}"`

/** 本地小睡（只为给验收脚本留出改文件状态的时间窗） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 应答一轮。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {(delta: object) => string} sseChunk SSE 分片格式 —— 唯一一份留在 `fake-upstream.mjs`
 *   （不在这里再写一遍，否则两处形状漂了就没人发现）
 */
async function streamExperienceRound(res, sseChunk) {
  rounds += 1
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  if (rounds <= MAX_ROUNDS) {
    /* 先静一下，让脚本能在「上一轮已经落地」之后改文件状态（见 PACE_MS） */
    await sleep(PACE_MS)
    res.write(sseChunk({ content: `第 ${rounds} 轮：再试一次同一条命令。` }))
    const call = {
      index: 0,
      id: `call_exp_${rounds}`,
      type: 'function',
      function: { name: 'run_shell', arguments: JSON.stringify({ command: command(rounds) }) },
    }
    res.write(sseChunk({ tool_calls: [call] }))
  } else {
    res.write(sseChunk({ content: '这一轮到此为止。' }))
  }
  res.write('data: [DONE]' + String.fromCharCode(10, 10))
  res.end()
}

export { command as experienceCommand, streamExperienceRound, MAX_ROUNDS as EXPERIENCE_ROUNDS }

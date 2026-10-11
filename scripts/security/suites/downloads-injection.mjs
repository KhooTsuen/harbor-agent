/**
 * 失败注入（文档 §12）—— 从 `downloads.mjs` 拆出来（那边顶到 300 行红线）。
 *
 * 这里做的是**真注入**，不是模拟：真掐断连接、真 SIGKILL 子进程、真往不可用路径写。
 * 观察的是行为（有没有半截成品、.part 留没留），不看源码字符串。
 *
 * `binaryServer` 由调用方传进来（它定义在 downloads.mjs）—— 这样两个文件不互相 require，
 * 不会形成环。
 */

import { sec } from '../harness.mjs'
import { fs, path, require, ROOT, tmpDir, startMockServer } from '../sandbox.mjs'
import { spawn } from 'node:child_process'

const join = path.join
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function failureInjection(engine, binaryServer) {
  /* ① 网络中断：服务器发一半就掐断连接（不 end）→ 明确失败、不留半截成品 */
  {
    const size = 256 * 1024
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'none' })
      res.write(Buffer.alloc(size / 4, 3))
      setTimeout(() => res.destroy(), 20)
    })
    try {
      const file = join(tmpDir('inj-net'), 'f.bin')
      let failed = false
      try {
        await engine.downloadFile({ url: `${server.url}/f.bin`, file })
      } catch {
        failed = true
      }
      sec('SEC-050', failed, '网络中断：中途断连 → 明确失败（不静默当成功）')
      sec('SEC-050', !fs.existsSync(file), '网络中断：不留半截成品（rename 没发生）')
    } finally {
      await server.close()
    }
  }

  /* ② 进程退出：真起子进程下到一半 SIGKILL —— .part 留着（可续传），没有成品 */
  {
    const size = 12 * 1024 * 1024
    let served = 0
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'none' })
      const chunk = Buffer.alloc(32 * 1024, 9)
      const pump = () => {
        if (res.writableEnded || res.destroyed || served >= size) return res.end()
        res.write(chunk)
        served += chunk.length
        setTimeout(pump, 10) /* 慢速：给足时间在中途把它杀掉 */
      }
      pump()
    })
    try {
      const dir = tmpDir('inj-kill')
      const file = join(dir, 'big.bin')
      const script = [
        `const e=require(${JSON.stringify(join(ROOT, 'electron/core/download-engine.cjs'))})`,
        `e.downloadFile({url:${JSON.stringify(`${server.url}/big.bin`)},file:${JSON.stringify(file)}}).then(()=>process.exit(0)).catch(()=>process.exit(2))`,
      ].join(';')
      const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
      const part = `${file}.part`
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !(fs.existsSync(part) && fs.statSync(part).size > 0)) await sleep(50)
      const midFlight = fs.existsSync(part) && fs.statSync(part).size > 0
      child.kill('SIGKILL')
      await sleep(300)
      sec('SEC-051', midFlight, '强杀前确实在下（.part 有字节）')
      sec('SEC-051', !fs.existsSync(file), '强杀后没有半截成品（rename 未发生）')
      sec('SEC-051', fs.existsSync(part), '强杀后 .part 保留 → 可续传（不白下）')
    } finally {
      await server.close()
    }
  }

  /* ③ 权限 / 路径拒绝：写到不可用的路径 → 明确失败，不误报成功 */
  {
    const bad = process.platform === 'win32' ? 'Z:\\__nope__\\f.bin' : '/no/such/dir/f.bin'
    const server = await binaryServer(1000)
    try {
      let failed = false
      try {
        await engine.downloadFile({ url: `${server.url}/f.bin`, file: bad })
      } catch {
        failed = true
      }
      sec('SEC-053', failed, '写不进去（路径不可用）→ 明确失败（不误报成功）')
    } finally {
      await server.close()
    }
  }
}

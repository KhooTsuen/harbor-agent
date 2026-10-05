/**
 * GitHub Release 的两件小事：认仓库、拿凭据、发请求。
 *
 * 为什么单独一个文件（硬约束 #9：同一段逻辑只能有一份实现）：
 * 「从 origin 认 owner/repo」「走 `git credential fill` 拿 token」「拼请求头」
 * 这几段，上传脚本和清理脚本都要用 —— 各写一遍就是又一个「改一处忘另一处」。
 * 注意：**token 只在内存里**，任何路径都不打印。
 */

import { spawnSync } from 'node:child_process'

const CWD = process.cwd()

/*
 * 让 fetch 走代理 —— 环境变量从 **git 自己的配置** 来（`http.proxy`，推代码用的就是它），
 * 口径只有一处，不用谁再手工设一遍。
 *
 * Node 24 的 fetch 认 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`，所以这里把 git 的配置
 * 翻译成那两个变量。**已经显式设了环境变量的不覆盖**（声明式的优先）。
 * 放在模块顶层：必须在第一个 fetch 之前生效。
 */
if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
  const proxy = (spawnSync('git', ['config', '--get', 'http.proxy'], { encoding: 'utf8' }).stdout ?? '').trim()
  if (proxy) {
    process.env.NODE_USE_ENV_PROXY = '1'
    process.env.HTTPS_PROXY = proxy
    process.env.HTTP_PROXY = proxy
  }
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: CWD,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

/** 从 origin 的地址认 owner/repo（https 与 ssh 两种写法都认） */
export function repoOf(remoteOverride = '') {
  const remote = String(remoteOverride || run('git', ['remote', 'get-url', 'origin']).stdout || '').trim()
  const found = /github\.com[:/]([^/]+)\/([^/.\s]+)/.exec(remote)
  if (!found) throw new Error(`认不出 origin 是哪个 GitHub 仓库：${remote || '（空）'}`)
  return { owner: found[1], repo: found[2], remote }
}

/**
 * 凭据：走 git 自己的 credential helper（和 `git push` 同一份）。
 * 拿不到就抛 —— 让人先 push 一次把凭据存好，而不是在这儿猜。
 */
export function readToken() {
  const filled = run('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
  })
  const row = (filled.stdout ?? '').split('\n').find((line) => line.startsWith('password='))
  if (!row) throw new Error('git credential fill 没给出 token —— 先 git push 一次把凭据存好')
  return row.slice('password='.length)
}

/**
 * 发一个请求。
 *
 * @param {string} path `/repos/...`；上传资产时传 `UPLOAD/repos/...`（走 uploads.github.com）
 * @param {{ token: string, method?: string, headers?: object, body?: any }} options
 */
export async function ghApi(path, { token, method = 'GET', headers = {}, body } = {}) {
  const upload = path.startsWith('UPLOAD')
  const url = upload
    ? `https://uploads.github.com${path.slice('UPLOAD'.length)}`
    : `https://api.github.com${path}`
  const response = await fetch(url, {
    method,
    body,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'harbor-release',
      ...headers,
    },
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 就只留文本 */
  }
  return { ok: response.ok, status: response.status, json, text }
}

/** 一页页翻（默认 30/页太窄； Releases 不会太多，100 足够） */
export async function listReleases({ token, owner, repo }) {
  const result = await ghApi(`/repos/${owner}/${repo}/releases?per_page=100`, { token })
  if (!result.ok) throw new Error(`列 Release 失败（${result.status}）：${result.text.slice(0, 300)}`)
  return Array.isArray(result.json) ? result.json : []
}

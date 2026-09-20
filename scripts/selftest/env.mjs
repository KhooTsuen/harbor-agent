/**
 * 自检：公共环境
 *
 * 从 scripts/selftest.mjs 拆出来的（那边 1193 行了）。
 *
 * 这里把「所有测试组都要用的东西」集中一次：被 require 的内核模块、路径、
 * 沙箱目录。各测试组只 import 自己用到的名字。
 *
 * 注意 ROOT 是**项目根**，不是这个文件所在目录 —— 组里要 require 别的模块
 * 时用 `join(ROOT, 'electron/core/xxx.cjs')`。
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const paths = require(join(ROOT, 'electron/core/paths.cjs'))
const configModule = require(join(ROOT, 'electron/core/config.cjs'))
const session = require(join(ROOT, 'electron/core/session.cjs'))
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
const skills = require(join(ROOT, 'electron/core/skills.cjs'))
const memory = require(join(ROOT, 'electron/core/memory.cjs'))
const searchCore = require(join(ROOT, 'electron/core/search.cjs'))
const statsCore = require(join(ROOT, 'electron/core/stats.cjs'))
const backupCore = require(join(ROOT, 'electron/core/backup.cjs'))
const fsCore = require('node:fs')
const fsHandler = require(join(ROOT, 'electron/handlers/fs.cjs'))
const llmCore = require(join(ROOT, 'electron/core/llm.cjs'))
const redactCore = require(join(ROOT, 'electron/core/redact.cjs'))
const promptStackCore = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
const conversationStateCore = require(join(ROOT, 'electron/core/conversation-state.cjs'))
const contextBuilderCore = require(join(ROOT, 'electron/core/context-builder.cjs'))
const modeRouterCore = require(join(ROOT, 'electron/core/mode-router.cjs'))
const credentialCore = require(join(ROOT, 'electron/core/credentials.cjs'))
const riskCore = require(join(ROOT, 'electron/core/risk.cjs'))
const capabilityCore = require(join(ROOT, 'electron/core/capability.cjs'))
const auditCore = require(join(ROOT, 'electron/core/audit.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const changesetCore = require(join(ROOT, 'electron/core/changeset.cjs'))
const errorsCore = require(join(ROOT, 'electron/core/errors.cjs'))
const routerCore = require(join(ROOT, 'electron/core/router.cjs'))
const projectCore = require(join(ROOT, 'electron/core/project.cjs'))
const memSim = require(join(ROOT, 'electron/core/memory-similarity.cjs'))

/* 测试用的沙箱目录，跑完删掉 */
const SANDBOX = join(ROOT, 'data', 'selftest-workspace')

/*
 * data/ 是 .gitignore 里的（应用运行时才建），干净 clone 里**没有**这个目录。
 * 而有些测试在 import 阶段就会往 data/ 里写东西（setupSandbox 还没被调到），
 * 于是“本地好好的、CI 上 ENOENT”。在模块加载时先把 data/ 建出来。
 */
mkdirSync(join(ROOT, 'data'), { recursive: true })

function setupSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  writeFileSync(join(SANDBOX, 'hello.txt'), 'line one\nline two\nline three\n', 'utf8')
  writeFileSync(join(SANDBOX, 'dup.txt'), 'same\n', 'utf8')
}

/*
 * 工具执行用的公共上下文。
 *
 * 这是**跨测试组共享**的（01 里声明、03 里继续用）—— 原本它写在
 * 「工具 / read_file」那一组里，拆文件时才发现它是共享状态。
 * 想改 confirm 的行为：用 `{ ...ctx, confirm: ... }` 覆盖，别改这个对象。
 */
const asked = []
const ctx = {
  workdir: SANDBOX,
  permission: 'full',
  shellTimeout: 20,
  log: console,
  sessionId: 'selftest',
  taskId: 'selftest-task',
  shellPolicy: { medium: 'allow', high: 'ask', critical: 'block' },
  confirm: async (request) => {
    asked.push(request)
    return true
  },
}

export {
  require,
  ROOT,
  SANDBOX,
  setupSandbox,
  ctx,
  asked,
  createRequire,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  fileURLToPath,
  dirname,
  join,
  resolve,
  paths,
  configModule,
  session,
  tools,
  skills,
  memory,
  searchCore,
  statsCore,
  backupCore,
  fsCore,
  fsHandler,
  llmCore,
  redactCore,
  promptStackCore,
  conversationStateCore,
  contextBuilderCore,
  modeRouterCore,
  credentialCore,
  riskCore,
  capabilityCore,
  auditCore,
  taskCore,
  changesetCore,
  errorsCore,
  routerCore,
  projectCore,
  memSim,
}

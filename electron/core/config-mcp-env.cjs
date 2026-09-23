/**
 * 配置：MCP 子进程的环境变量白名单
 *
 * 单独一个文件：`config-defaults.cjs` 加完网络策略那一段就过 300 行了，而这一块
 * 是**纯数据 + 一段必须挨着它的解释**，正好按职责切出来。
 *
 * 为什么非要留这几个（别手贱删）：Windows 上少了 `SystemRoot` / `windir`，
 * 很多程序**根本起不来**（加载 DLL 失败），报的错还和权限无关，极难排查。
 * 这几个是「让进程能跑」的最小集，**不含任何密钥**。
 *
 * 默认策略是「**不继承**环境变量、只给白名单里的键」（见 `mcp-connection.cjs`
 * 的 `buildEnv`）—— 以前是 `{ ...process.env }`，等于把所有 API Key 递给
 * 每一个 MCP 服务器。
 */

const MCP_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'ProgramFiles',
  'ProgramData',
  'LANG',
  'LC_ALL',
  'PYTHONIOENCODING',
]

module.exports = { MCP_ENV_ALLOWLIST }

/* ══════════════════════════════════════════════════════════════
   会话内容加密：桥上的形状

   单独一个文件而不是塞进 `types/models.ts` / `types/backend.ts` —— 那两个都
   正好 300 行（硬约束 #2）。这里只有类型，没有逻辑。
   ══════════════════════════════════════════════════════════════ */

/** `security:sessionCrypto` 的返回 */
export interface SessionCryptoBridgeState {
  ok: boolean
  /** 配置里那个开关的状态 */
  enabled: boolean
  /** 密钥能不能拿到（拿不到 = 已加密的历史会话解不开） */
  key: { available: boolean; ref?: string; error?: string }
  /** 盘上的会话文件数 */
  files: number
  /** 其中已经是密文的行数 */
  encrypted: number
  /** 还是明文的行数（开关开着但这里 > 0 = 上次转换没跑完，界面要显眼提示） */
  plain: number
}

/** `security:setSessionCrypto` 的返回（内核 `session-crypto.migrate` 的形状） */
export interface SessionCryptoMigrateResult {
  ok: boolean
  /** 真正被改写的文件数 */
  files?: number
  /** 真正被改写的行数 */
  lines?: number
  /** 转换失败的文件数（> 0 时 ok 一定为 false） */
  failed?: number
  /** 转换前的备份名 —— 出事时用户靠它找回来，界面必须显示 */
  backup?: string
  error?: string
}

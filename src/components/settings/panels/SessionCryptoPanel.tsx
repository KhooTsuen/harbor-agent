import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Lock } from 'lucide-react'
import { Row, SectionTitle } from '../parts'
import { useUIStore } from '@/stores/useUIStore'
import { colorOf } from '@/lib/statusLanguage'
import {
  fetchSessionCrypto,
  setSessionCrypto,
  sessionCryptoBridgeReady,
  type SessionCryptoState,
} from '@/lib/sessionCryptoApi'

/* ══════════════════════════════════════════════════════════════
   会话内容加密（可选）

   ★ 这个面板最重要的信息不是那个开关，而是**盘上到底有多少行还是明文**。
     配置说「开着」而文件还是明文（上次转换中途失败、或换过 Windows 账户）
     是最危险的状态 —— 「以为加密了，其实没有」。所以这里**数真实文件**，
     并且两个数都对不上时把话说出来。

   ★ 开关不是「改个设置就完事」：打开会**重写全部会话文件**（先自动备份）。
     所以文案必须提前说清代价，而不是点完再解释。
   ══════════════════════════════════════════════════════════════ */

export function SessionCryptoPanel() {
  const showToast = useUIStore((s) => s.showToast)
  const [state, setState] = useState<SessionCryptoState | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready] = useState(sessionCryptoBridgeReady)

  const refresh = useCallback(async () => {
    setState(await fetchSessionCrypto())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!ready) {
    return (
      <>
        <SectionTitle>会话内容加密</SectionTitle>
        <p className="px-2 py-1 text-dense text-fg-tertiary">
          当前版本没接上这个桥（security:sessionCrypto），所以看不到加密状态。
          会话本身的读写不受影响。
        </p>
      </>
    )
  }

  const toggle = async (next: boolean) => {
    setBusy(true)
    const result = await setSessionCrypto(next)
    setBusy(false)

    if (!result.ok) {
      /* 失败必须说清「什么都没动」—— 否则用户不知道自己的数据现在是什么状态 */
      showToast('error', '没有改动', result.error ?? '转换失败，文件保持原样')
      await refresh()
      return
    }
    showToast('success', next ? '会话已加密' : '会话已解密', `备份：${result.backup}`)
    await refresh()
  }

  const enabled = state?.enabled === true
  /* 配置说开着、但盘上还有明文 → 这是「以为加密了其实没有」，必须显眼 */
  const mismatch = enabled && (state?.plain ?? 0) > 0
  const keyBroken = state?.key?.available === false

  return (
    <>
      <SectionTitle>会话内容加密</SectionTitle>

      <Row
        label="对话内容在磁盘上加密"
        hint="逐行加密（追加式写不受影响）。开启会重写全部现有会话文件，转换前自动备份。默认关闭。"
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-dense text-fg-primary">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => void toggle(e.target.checked)}
            />
            {busy ? '转换中…' : enabled ? '已开启' : '未开启'}
          </label>
          <Lock size={12} className="text-fg-tertiary" />
        </div>
      </Row>

      {state ? (
        <p className="px-2 py-1 text-dense leading-relaxed text-fg-secondary">
          盘上现在有 <span className="text-fg-primary">{state.files}</span> 个会话文件： 已加密{' '}
          <span className="text-fg-primary">{state.encrypted}</span> 行、 明文{' '}
          <span className="text-fg-primary">{state.plain}</span> 行。
        </p>
      ) : null}

      {mismatch ? (
        <p
          className="mx-2 mb-1 flex gap-1.5 rounded-base border px-3 py-2 text-dense leading-relaxed text-fg-secondary"
          style={{ borderColor: colorOf('warning') }}
        >
          <AlertTriangle
            size={12}
            className="mt-0.5 shrink-0"
            style={{ color: colorOf('warning') }}
          />
          <span>
            开关是开着的，但盘上还有明文行 —— 上一次转换没跑完（可能中途失败）。
            再点一次开关（关掉再打开）会重新转换一遍。
          </span>
        </p>
      ) : null}

      {keyBroken ? (
        <p className="mx-2 mb-1 px-3 py-2 text-2xs leading-relaxed text-fg-tertiary">
          密钥当前读不出来：{state?.key?.error}
          <br />
          密钥绑当前 Windows 账户（走系统加密），换账户或把 data/ 拷到别的机器就会这样。
          <b>已加密的历史会话会解不开</b>（读的时候跳过那一行，其余内容不受影响）。
        </p>
      ) : null}

      <p className="px-2 pb-2 text-2xs leading-relaxed text-fg-tertiary">
        密钥存在凭证库里（不在 config.json，也不进备份包）。这只防「文件被直接拷走」，
        <b>不防正在运行的程序</b> —— 应用开着的时候内容是能读的。
      </p>
    </>
  )
}

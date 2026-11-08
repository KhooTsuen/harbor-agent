import { AlertTriangle, KeyRound, Lock } from 'lucide-react'
import { Row, SectionTitle } from '../parts'
import { SessionCryptoPanel } from '../panels/SessionCryptoPanel'
import { colorOf } from '@/lib/statusLanguage'
import { useAccessData } from './useAccessData'

/* ══════════════════════════════════════════════════════════════
   数据与会话保护 —— 「我的东西被怎么保护着」

   ── 三样东西必须分开摆（这是本组存在的全部理由）───────────────
   用户看到一排开关，会以为它们都是「可以调的保护」。实际是三层：

     ① **可以改**    会话内容加密（真有个开关，真会重写文件）
     ② **只读状态**  凭证库用的是什么加密（改成别的没意义 —— 是环境给的）
     ③ **内核强制**  敏感文件、凭证不外发、审计脱敏（没有开关，绕不过去）

   ② 和 ③ 如果做成开关，就是「假开关」：按下去什么都不变，或者更糟 ——
   按下去让用户以为保护被关掉了。所以它们在这里只**如实显示**。
   ══════════════════════════════════════════════════════════════ */

export function AccessProtectionGroup(): React.ReactElement {
  const { creds } = useAccessData()

  return (
    <>
      <SectionTitle hint="这一项真的能改，改完会重写现有会话文件">可以改的</SectionTitle>

      <SessionCryptoPanel />

      <SectionTitle hint="只说状态 —— 这几项不是开关，内核里写死的">怎么被保护的</SectionTitle>

      <Row
        label="API Key 存哪"
        hint="不写进 config.json，单独存在凭证库里。系统加密可用时用 Windows DPAPI。"
      >
        <div className="flex items-center gap-2 text-2xs">
          <KeyRound size={13} className="text-fg-tertiary" />
          {creds ? (
            creds.encryptionAvailable ? (
              <span className="text-fg-secondary">
                已用系统加密（{creds.backend}）· {creds.count} 条
              </span>
            ) : (
              <span className="flex items-center gap-1" style={{ color: colorOf('warning') }}>
                <AlertTriangle size={12} />
                当前环境拿不到系统加密，密钥是明文存在本机文件里（别把 data/ 拷给别人）
              </span>
            )
          ) : (
            <span className="text-fg-tertiary">读不到（浏览器预览没有凭证库）</span>
          )}
        </div>
      </Row>

      <Row
        label="敏感文件与凭证"
        hint=".env、私钥、credentials 这类路径的读写会被内核单独审一次 —— 不在这三档权限里，也不受 Shell 策略影响"
      >
        <span className="flex items-center gap-1.5 text-2xs text-fg-tertiary">
          <Lock size={11} className="shrink-0" />
          强制（无配置项）
        </span>
      </Row>

      <Row
        label="审计里的敏感内容"
        hint="落盘前一律过脱敏：参数里的密钥、输出里的 token 会被打码。这一条没有开关。"
      >
        <span className="flex items-center gap-1.5 text-2xs text-fg-tertiary">
          <Lock size={11} className="shrink-0" />
          强制（无配置项）
        </span>
      </Row>

      <p className="px-3 py-2 text-2xs leading-relaxed text-fg-tertiary">
        上面两条写在这里是为了让你**知道有这么回事**，不是让你去关 —— 真做成了开关，
        关掉就等于把「别把密钥发出去」这条规矩交出去。要看具体拦了什么，去「授权与审计」。
      </p>
    </>
  )
}

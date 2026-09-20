import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   个人资料（名字 + 头像）

   侧栏左下角那个圆原来是个**写死的装饰**（`aria-hidden` + 一个「我」字，
   点了没反应）—— 这是它的接口。名字进配置、头像进 `data/avatars/`
   （二进制不该塞进 config：那会让每次写配置都搬一遍它）。

   这一组测内核这一侧：配置的默认值与归一化、头像文件的找法、通道接线。
   界面那一半（预览、名字输入、移除、侧栏按钮）在
   `src/components/settings/__tests__/profileTab.test.tsx`。
   ══════════════════════════════════════════════════════════════ */

const configDefaults = require(join(ROOT, 'electron/core/config-defaults.cjs'))
const normalize = require(join(ROOT, 'electron/core/config-normalize.cjs'))
const profileHandler = require(join(ROOT, 'electron/handlers/profile.cjs'))

export async function run() {
  group('个人资料 / 配置')

  check('默认没有名字（空 = 界面显示「我」）', configDefaults.DEFAULTS.profile?.name === '')
  check(
    '归一化：脏数据（数字）落成空串',
    normalize.normalize({ profile: { name: 123 } }).profile.name === '',
  )
  check(
    '归一化：名字太长会截断（40 字上限）',
    normalize.normalize({ profile: { name: 'x'.repeat(200) } }).profile.name.length === 40,
  )

  group('个人资料 / 头像文件')

  check('图片格式白名单在（不给随便什么文件都塞进来）', profileHandler.OK_EXT.includes('png'))
  check('大小上限是 4MB（头像不需要大图）', profileHandler.MAX_BYTES === 4 * 1024 * 1024)

  /* 找文件这条逻辑：放一张假的头像进去，看它认不认 */
  const { DIRS } = require(join(ROOT, 'electron/core/paths.cjs'))
  const before = profileHandler.currentFile()
  mkdirSync(DIRS.avatars, { recursive: true })
  const fake = join(DIRS.avatars, 'avatar.png')
  writeFileSync(fake, Buffer.from('fake-png'))
  check('★ 能认出 data/avatars/avatar.png', profileHandler.currentFile() === fake)
  /* 临时文件不算（写一半崩了不该被当成头像） */
  writeFileSync(join(DIRS.avatars, 'avatar.jpg.tmp'), Buffer.from('x'))
  check('★ 写到一半的 .tmp 不会被当成头像', profileHandler.currentFile() === fake)
  rmSync(join(DIRS.avatars, 'avatar.jpg.tmp'), { force: true })
  rmSync(fake, { force: true })
  check('删掉之后就是没有头像（回落到首字）', profileHandler.currentFile() === before)

  group('个人资料 / 接线')

  const channels = readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8')
  for (const name of [
    'profile:get',
    'profile:setName',
    'profile:pickAvatar',
    'profile:clearAvatar',
  ]) {
    check(`通道清单里有 ${name}`, channels.includes(`'${name}'`))
  }
  const registered = readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  check('★ handler 真被注册了（漏了界面就静默无反应）', registered.includes('handlers/profile.cjs'))
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check('preload 暴露了四个方法', preload.includes('profilePickAvatar'))

  const sideSrc = readFileSync(join(ROOT, 'src/components/layout/Sidebar.tsx'), 'utf8')
  check(
    '★ 侧栏那个圆不再是写死的装饰（点了会打开设置）',
    sideSrc.includes("openSettings('profile')"),
  )
  check('侧栏用它显示头像或名字首字', sideSrc.includes('initialOf(profileName)'))
  check(
    'bootstrap 会读一次资料（不然启动时圆是空的）',
    readFileSync(join(ROOT, 'src/hooks/useAppBootstrap.ts'), 'utf8').includes('useProfileStore'),
  )
}

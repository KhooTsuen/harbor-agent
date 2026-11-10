import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FileProbe } from '@/types/deliverables'

const { probeInside } = require('../../../electron/handlers/fs-probe.cjs') as {
  probeInside: (target: string, root: string) => Promise<FileProbe>
}
let temporary = ''
let root = ''
const prefix = path.join(os.tmpdir(), 'harbor-file-probe-')

beforeEach(async () => {
  temporary = await fs.mkdtemp(prefix)
  root = path.join(temporary, 'workspace')
  await fs.mkdir(root)
})

afterEach(async () => {
  const resolved = path.resolve(temporary)
  if (
    !resolved.startsWith(path.resolve(prefix)) ||
    path.dirname(resolved) !== path.resolve(os.tmpdir())
  )
    throw new Error('Refusing cleanup outside the allocated temporary directory')
  await fs.rm(resolved, { recursive: true, force: true })
})

describe('artifact file metadata verification', () => {
  it('distinguishes files, directories, missing paths and a file removed after earlier verification', async () => {
    await fs.writeFile(path.join(root, 'result.txt'), 'result')
    expect(await probeInside('result.txt', root)).toMatchObject({
      ok: true,
      exists: true,
      file: true,
      size: 6,
    })
    expect(await probeInside('.', root)).toMatchObject({ ok: true, exists: true, file: false })
    expect(await probeInside('missing.txt', root)).toEqual({ ok: true, exists: false })
    await fs.unlink(path.join(root, 'result.txt'))
    expect(await probeInside('result.txt', root)).toEqual({ ok: true, exists: false })
  })

  it('rejects lexical and real-path escapes, including Windows junctions', async () => {
    const outside = path.join(temporary, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside')
    await fs.symlink(
      outside,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(await probeInside('../outside/secret.txt', root)).toMatchObject({ ok: false })
    expect(await probeInside('link/secret.txt', root)).toMatchObject({ ok: false })
    expect(await probeInside('', root)).toMatchObject({ ok: false })
  })
})

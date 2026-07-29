import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  createCapabilityToken,
  defineKernelModule,
} from '@velaros-ai/core/kernel/abi'
import { KernelClient } from '@velaros-ai/kernel-client'

import { bootKernelDaemon } from '../src/daemon/boot'
import { InProcessKernelTransport } from '../src/internal/in-process-transport'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('mods RPC', () => {
  test('lists, installs, and toggles packs through KernelClient', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-mods-rpc-'))
    directories.push(root)
    const packDir = join(root, 'echo-pack')
    await mkdir(packDir, { recursive: true })
    await writeFile(
      join(packDir, 'index.mjs'),
      `export default {
  manifest: {
    id: 'module.user-echo',
    version: '1.0.0',
    apiVersion: 1,
    provides: [{ id: 'test.user.echo', version: '1.0.0' }],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'in-process',
  },
  activate() {},
}
`,
    )
    await writeFile(
      join(packDir, 'velaros.mod.json'),
      JSON.stringify({
        module: {
          id: 'user.echo',
          version: '1.0.0',
          apiVersion: 1,
          entry: './index.mjs',
          // Shape tolerance: a bare capability id means the same as {id, version}.
          provides: ['test.user.echo'],
        },
      }),
    )

    const booted = await bootKernelDaemon({
      kernelVersion: '0.3.0-test',
      modStorePaths: {
        userModsDirectory: join(root, 'mods'),
        indexPath: join(root, 'mod-index.json'),
      },
      modules: [
        defineKernelModule({
          manifest: {
            id: 'module.seed',
            version: '1.0.0',
            apiVersion: 1,
            provides: [createCapabilityToken('test.seed')],
            requires: [],
            optionalRequires: [],
            permissions: [],
            isolation: 'in-process',
          },
          activate() {},
        }),
      ],
    })

    const client = new KernelClient(new InProcessKernelTransport(booted.service))
    const before = await client.listMods()
    expect(before.packs.some((pack) => pack.id === 'user.echo')).toBe(false)

    const installed = await client.installModFromDirectory(packDir)
    expect(installed.pack.id).toBe('user.echo')
    expect(installed.reloadRequired).toBe(true)

    const listed = await client.listMods()
    expect(listed.packs.some((pack) => pack.id === 'user.echo' && pack.enabled)).toBe(true)

    const disabled = await client.setModEnabled('user.echo', false)
    expect(disabled.ok).toBe(true)
    expect(disabled.reloadRequired).toBe(true)
    const afterDisable = await client.listMods()
    expect(afterDisable.packs.find((pack) => pack.id === 'user.echo')?.enabled).toBe(false)

    await booted.stop()
  })
})

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  defaultRemoteNodeCredentialsPath,
  FileRemoteNodeCredentialStore,
} from '../../src/remote/client/credential-store'
import { defaultHostBridgeSocketPath } from '../../src/runtime/host/sidecar-bridge'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-remote-credentials-'))
  directories.push(directory)
  return directory
}

describe('远程节点凭据落点', () => {
  test('没有 HOME 时落在用户主目录，而不是共享的 /tmp', () => {
    // Windows 通常没有 HOME：原来的 '/tmp' 兜底会把 Ed25519 私钥写到当前盘根的
    // \tmp\.velaros\，NTFS 上 0600 不生效，同机其他用户可读。
    expect(defaultRemoteNodeCredentialsPath('example-host', undefined))
      .toBe(join(homedir(), '.velaros', 'remote-nodes', 'example-host.json'))
    expect(defaultRemoteNodeCredentialsPath('example-host', '   '))
      .toBe(join(homedir(), '.velaros', 'remote-nodes', 'example-host.json'))
    expect(defaultHostBridgeSocketPath(undefined))
      .toBe(`${homedir()}/.velaros/host-bridge.sock`)
  })

  test('显式给出的主目录照用', () => {
    expect(defaultRemoteNodeCredentialsPath('example-host', '/home/someone'))
      .toBe(join('/home/someone', '.velaros', 'remote-nodes', 'example-host.json'))
  })

  test('凭据文件按 0600 落盘并能原样读回', async () => {
    const path = join(await temporaryDirectory(), 'nested', 'host.json')
    const store = new FileRemoteNodeCredentialStore(path)

    expect(await store.load()).toBeNull()

    const credentials = {
      clientId: 'client-1',
      privateKey: 'private-key-material',
      publicKey: 'public-key-material',
      node: {
        nodeId: 'node-1',
        nodeName: 'Example node',
        platform: 'darwin' as const,
        arch: 'arm64',
        nodeVersion: '0.3.0',
        epoch: 'epoch-1',
      },
    }
    await store.save(credentials)

    expect(await store.load()).toEqual(credentials)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }

    await store.clear()
    expect(await store.load()).toBeNull()
  })
})

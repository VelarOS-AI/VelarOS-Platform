import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { VelarHostConfigStore } from '../src/config'

/** 默认的关闭态远程节点；每条 update 都得带这一节，故抽成常量。 */
const LoopbackRemoteNode = {
  enabled: false,
  bindHost: '127.0.0.1',
  portStart: 43_180,
  portEnd: 43_190,
} as const

describe('Velar Host config authority', () => {
  let temporaryRoot: string | undefined

  afterEach(async () => {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('creates a fail-closed persistent default', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const path = join(temporaryRoot, 'host-config.json')
    const store = await VelarHostConfigStore.open(path)

    expect(store.snapshot().value.capabilities).toEqual({
      project: { read: true, write: false, execute: false },
      system: { observe: false, read: false, write: false, execute: false },
      computer: { observe: false, control: false },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(4)
    expect(store.snapshot().value.remoteNode).toEqual({
      enabled: false,
      bindHost: '127.0.0.1',
      portStart: 43_180,
      portEnd: 43_190,
    })
  })

  test('requires explicit confirmation before broadening dangerous capabilities', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const store = await VelarHostConfigStore.open(join(temporaryRoot, 'host-config.json'))
    const value = {
      capabilities: {
        project: { read: true, write: false, execute: false },
        system: { observe: false, read: false, write: false, execute: false },
        computer: { observe: true, control: true },
      },
      computer: { resourceRoots: ['/opt/velaros/computer'] },
      remoteNode: LoopbackRemoteNode,
    }

    await expect(store.update({ ...value, confirmations: [] }))
      .rejects.toThrow('computer-observe, computer-control')
    const updated = await store.update({
      ...value,
      confirmations: ['computer-observe', 'computer-control'],
    })
    expect(updated.value.capabilities.computer).toEqual({ observe: true, control: true })
    expect(updated.value.computer.resourceRoots).toEqual(['/opt/velaros/computer'])
  })

  test('rejects unsafe dependent capability combinations', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const store = await VelarHostConfigStore.open(join(temporaryRoot, 'host-config.json'))

    await expect(store.update({
      capabilities: {
        project: { read: false, write: true, execute: false },
        system: { observe: false, read: false, write: false, execute: false },
        computer: { observe: false, control: false },
      },
      computer: { resourceRoots: [] },
      remoteNode: LoopbackRemoteNode,
      confirmations: ['project-write'],
    })).rejects.toThrow('requires project read')
  })

  test('requires explicit confirmation before exposing the remote node', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const store = await VelarHostConfigStore.open(join(temporaryRoot, 'host-config.json'))
    const capabilities = {
      project: { read: true, write: false, execute: false },
      system: { observe: false, read: false, write: false, execute: false },
      computer: { observe: false, control: false },
    }

    await expect(store.update({
      capabilities,
      computer: { resourceRoots: [] },
      remoteNode: { ...LoopbackRemoteNode, enabled: true, bindHost: '0.0.0.0' },
      confirmations: [],
    })).rejects.toThrow('remote-node-enable, remote-node-expose')

    const enabled = await store.update({
      capabilities,
      computer: { resourceRoots: [] },
      remoteNode: { ...LoopbackRemoteNode, enabled: true, bindHost: '0.0.0.0' },
      confirmations: ['remote-node-enable', 'remote-node-expose'],
    })
    expect(enabled.value.remoteNode).toEqual({
      enabled: true,
      bindHost: '0.0.0.0',
      portStart: 43_180,
      portEnd: 43_190,
    })

    // 收紧永远不该被拦：关掉开关、收回回环都不需要任何确认。
    const disabled = await store.update({
      capabilities,
      computer: { resourceRoots: [] },
      remoteNode: LoopbackRemoteNode,
      confirmations: [],
    })
    expect(disabled.value.remoteNode.enabled).toBe(false)
    expect(disabled.value.remoteNode.bindHost).toBe('127.0.0.1')
  })

  test('upgrades a v3 config by adding a closed remote node section', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const path = join(temporaryRoot, 'host-config.json')
    await writeFile(path, JSON.stringify({
      schemaVersion: 3,
      capabilities: {
        project: { read: true, write: true, execute: false },
        system: { observe: false, read: false, write: false, execute: false },
        computer: { observe: false, control: false },
      },
      computer: { resourceRoots: [] },
    }))

    const store = await VelarHostConfigStore.open(path)

    expect(store.snapshot().value.remoteNode).toEqual({
      enabled: false,
      bindHost: '127.0.0.1',
      portStart: 43_180,
      portEnd: 43_190,
    })
    expect(store.snapshot().value.capabilities.project.write).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(4)
  })
})

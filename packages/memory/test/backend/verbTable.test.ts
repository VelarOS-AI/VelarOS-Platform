/**
 * 动词表 4+2（2026-08-05 产品裁决）的机械锁。
 *
 * 锁的是**契约**而不是实现细节：动词表是直接印在用户设置页与工具契约上的东西，一旦有人
 * 把 `archive` 改回 `erase`、或者交一个缺归档的权威层，界面与模型立刻开始说假话。
 */

import { describe, expect, test } from 'bun:test'

import { createMemoryStoreCapabilityToken, resolveMemoryStoreBackend } from '../../src/adapter-kernel'
import {
  listMissingAuthorityMemoryVerbs,
  type MemoryBackendVerb,
  type MemoryStoreBackend,
  RequiredAuthorityMemoryVerbs,
  supportsMemoryBackendVerb,
} from '../../src/backend'
import { createMemoryFilesBackend } from '../../src/files'

function createStubBackend(
  verbs: readonly MemoryBackendVerb[],
  options: { role?: 'authority' | 'derived-index'; omitArchiveImplementation?: boolean } = {}
): MemoryStoreBackend {
  const backend: MemoryStoreBackend = {
    descriptor: {
      id: 'stub',
      role: options.role ?? 'authority',
      displayName: 'Stub',
      verbs,
    },
    capture: () => {
      throw new Error('not used')
    },
    captureBatch: () => {
      throw new Error('not used')
    },
    recall: () => [],
    getItem: () => null,
    inspect: () => ({ backendId: 'stub', itemCount: 0, pendingCount: 0, version: 0 }),
  }
  if (!options.omitArchiveImplementation) {
    backend.archive = (id: string) => ({ claimId: id, affectedEvidenceIds: [], treeVersion: 0 })
  }
  return backend
}

describe('memory backend verb table', () => {
  test('权威层必备动词是 capture/recall/inspect/archive 四个', () => {
    expect([...RequiredAuthorityMemoryVerbs]).toEqual([
      'capture',
      'recall',
      'inspect',
      'archive',
    ])
  })

  test('bundled 文件后端声明四必备、不声明 dream/govern', () => {
    const backend = createMemoryFilesBackend({ roots: [] })
    expect([...backend.descriptor.verbs]).toEqual(['capture', 'recall', 'inspect', 'archive'])
    expect(listMissingAuthorityMemoryVerbs(backend)).toEqual([])
    expect(supportsMemoryBackendVerb(backend, 'dream')).toBe(false)
    expect(supportsMemoryBackendVerb(backend, 'govern')).toBe(false)
  })

  test('声明了 archive 但没实现 = 不支持（声明与实现必须一致）', () => {
    const declaredOnly = createStubBackend(['capture', 'recall', 'inspect', 'archive'], {
      omitArchiveImplementation: true,
    })
    expect(supportsMemoryBackendVerb(declaredOnly, 'archive')).toBe(false)
    expect(listMissingAuthorityMemoryVerbs(declaredOnly)).toEqual(['archive'])
  })

  test('缺必备动词的权威层解析不出来——半个真相层等于没装', () => {
    const halfBackend = createStubBackend(['capture', 'recall', 'inspect'])
    const token = createMemoryStoreCapabilityToken('stub')
    const registry = {
      getOptionalService: <TService extends object>(requested: { id: string }) =>
        (requested.id === token.id
          ? ({ backend: halfBackend } as unknown as TService)
          : undefined),
    }

    expect(resolveMemoryStoreBackend({ registry, preference: ['stub'] })).toBeUndefined()
  })
})

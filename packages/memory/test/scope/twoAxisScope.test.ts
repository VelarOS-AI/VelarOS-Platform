/**
 * 记忆作用域**两轴模型**的机械锁（2026-08-06 判决：session-identity + workspaceRoot）。
 *
 * 锁的是隔离语义，不是检索偏好：
 *  - 轴一 `scopeId`（会话身份 / 空间实体派生）在场即权威；
 *  - 轴二 `workspaceRoot` 只在轴一缺席时物化出 `project:<root>`；
 *  - 匹配**精确**，不是前缀也不是后缀。
 *
 * 这三条以前散在文件后端、向量索引与 `memory:get` 读门里各写了一遍，写得还不一样。
 * 本文件锁「同一条真值表」，回归的形状是**跨作用域读到了不该读的东西**。
 */

import { describe, expect, test } from 'bun:test'

import { createInMemoryMemoryFilesIo,createMemoryFilesBackend } from '../../src/files'
import {
  buildProjectMemoryScope,
  isMemoryVisibleInScope,
  resolveMemoryScopeSelector,
} from '../../src/MemoryScope'

describe('两轴作用域解析', () => {
  test('轴一在场即权威：同时给两轴时 workspaceRoot 不产生第二个候选', () => {
    expect(
      resolveMemoryScopeSelector({
        scopeId: 'site:https://github.com',
        workspaceRoot: '/workspace/repo',
      })
    ).toBe('site:https://github.com')
  })

  test('轴一缺席时由轴二物化出 project 作用域', () => {
    expect(resolveMemoryScopeSelector({ workspaceRoot: '/workspace/repo' })).toBe(
      buildProjectMemoryScope('/workspace/repo')
    )
  })

  test('两轴皆空 = 不过滤', () => {
    expect(resolveMemoryScopeSelector({})).toBe('')
    expect(isMemoryVisibleInScope({ scopeType: 'workspace', scopeId: 'project:/x' }, {})).toBe(true)
  })

  test('空白串与缺席等价（宿主传 "" 不该悄悄变成一个真作用域）', () => {
    expect(resolveMemoryScopeSelector({ scopeId: '  ', workspaceRoot: '  ' })).toBe('')
  })
})

describe('可见性真值表', () => {
  const projectItem = { scopeType: 'workspace', scopeId: 'project:/workspace/repo' }
  const siteItem = { scopeType: 'site', scopeId: 'site:https://github.com' }
  const globalItem = { scopeType: 'global', scopeId: 'global' }

  test('精确相等才可见', () => {
    expect(isMemoryVisibleInScope(projectItem, { workspaceRoot: '/workspace/repo' })).toBe(true)
    expect(isMemoryVisibleInScope(siteItem, { scopeId: 'site:https://github.com' })).toBe(true)
  })

  test('后缀不算命中——两个项目共享路径尾巴不得互读', () => {
    // 曾经的 `scopeId.endsWith(workspaceRoot)` 会让备份副本读到正本的记忆。
    expect(
      isMemoryVisibleInScope(
        { scopeType: 'workspace', scopeId: 'project:/Volumes/backup/workspace/repo' },
        { workspaceRoot: '/workspace/repo' }
      )
    ).toBe(false)
  })

  test('前缀不算命中——父目录不得读到子项目', () => {
    expect(
      isMemoryVisibleInScope(
        { scopeType: 'workspace', scopeId: 'project:/workspace/repo/packages/inner' },
        { workspaceRoot: '/workspace/repo' }
      )
    ).toBe(false)
  })

  test('跨空间不得泄漏：浏览器空间的会话仍有活动项目根时读不到项目记忆', () => {
    expect(
      isMemoryVisibleInScope(projectItem, {
        scopeId: 'site:https://github.com',
        workspaceRoot: '/workspace/repo',
      })
    ).toBe(false)
  })

  test('global 记忆默认处处可见，includeGlobal:false 时严格隔离', () => {
    expect(isMemoryVisibleInScope(globalItem, { workspaceRoot: '/workspace/repo' })).toBe(true)
    expect(
      isMemoryVisibleInScope(globalItem, { workspaceRoot: '/workspace/repo', includeGlobal: false })
    ).toBe(false)
  })

  test('global 管理面（scopeId = global）代表「全部」', () => {
    expect(isMemoryVisibleInScope(projectItem, { scopeId: 'global' })).toBe(true)
    expect(isMemoryVisibleInScope(siteItem, { scopeId: 'global' })).toBe(true)
  })

  test('system 共享池只在 system 作用域可见，不随每次召回并入', () => {
    const systemItem = { scopeType: 'system', scopeId: 'system' }
    expect(isMemoryVisibleInScope(systemItem, { scopeId: 'system' })).toBe(true)
    expect(isMemoryVisibleInScope(systemItem, { workspaceRoot: '/workspace/repo' })).toBe(false)
  })
})

describe('文件后端按两轴选根', () => {
  const roots = [
    { scopeType: 'system' as const, scopeId: 'system', directory: '/data/memory' },
    {
      scopeType: 'workspace' as const,
      scopeId: buildProjectMemoryScope('/workspace/repo'),
      directory: '/workspace/repo/.velaros/memory',
    },
    {
      scopeType: 'site' as const,
      scopeId: 'site:https://github.com',
      directory: '/data/memory/sites/github.com',
    },
  ]

  function createBackend() {
    return createMemoryFilesBackend({ io: createInMemoryMemoryFilesIo(), roots })
  }

  test('写入落在轴一选定的根，不被轴二拽走', () => {
    const backend = createBackend()
    const captured = backend.capture({
      sourceType: 'chat_message',
      trustLevel: 'user_stated',
      content: '站点面的记忆',
      scopeType: 'site',
      scopeId: 'site:https://github.com',
      // 会话同时有活动项目根：轴二在场，但不得改变落点。
      workspaceRoot: '/workspace/repo',
    })
    expect(captured.evidence.scopeId).toBe('site:https://github.com')
  })

  test('轴一缺席时按 workspaceRoot 精确落到项目根', () => {
    const backend = createBackend()
    const captured = backend.capture({
      sourceType: 'chat_message',
      trustLevel: 'user_stated',
      content: '项目面的记忆',
      workspaceRoot: '/workspace/repo',
    })
    expect(captured.evidence.scopeId).toBe(buildProjectMemoryScope('/workspace/repo'))
  })

  test('召回按两轴收敛：站点空间读不到项目条目', () => {
    const backend = createBackend()
    void backend.capture({
      sourceType: 'chat_message',
      trustLevel: 'user_stated',
      title: '项目秘密',
      content: '只属于这个项目的东西',
      scopeType: 'workspace',
      scopeId: buildProjectMemoryScope('/workspace/repo'),
      workspaceRoot: '/workspace/repo',
    })

    const inProject = backend.recall('项目秘密', {
      scopeId: buildProjectMemoryScope('/workspace/repo'),
      workspaceRoot: '/workspace/repo',
    })
    expect(inProject.map((item) => item.title)).toContain('项目秘密')

    const inSite = backend.recall('项目秘密', {
      scopeId: 'site:https://github.com',
      workspaceRoot: '/workspace/repo',
    })
    expect(inSite.map((item) => item.title)).not.toContain('项目秘密')
  })
})

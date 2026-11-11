import { expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { FeaturesOperationContext, FeatureSummary } from '../index.js'
import { featuresOperations } from '../index.js'

test('INV-1 拒绝安装不调用写入口', async () => {
  let installed = false
  const context: FeaturesOperationContext = {
    abortSignal: new AbortController().signal,
    authorize: async () => {
      throw new AppError('PERMISSION', 'declined')
    },
    recordEffect: () => {},
    features: {
      list: async () => [],
      validate: async () => ({
        schemaVersion: 1,
        id: 'sample',
        name: 'Sample',
        description: '',
        version: '1.0.0',
        prompt: '',
        source: 'native',
        diagnostics: [],
        toolDependencies: [],
      }),
      install: async () => {
        installed = true
        throw new AppError('INVARIANT', 'unexpected')
      },
      load: async () => {
        throw new AppError('INVARIANT', 'unexpected')
      },
      remove: async () => {},
    },
  }
  await expect(featuresOperations.install({ path: './sample' }, context)).rejects.toThrow(
    'declined'
  )
  expect(installed).toBe(false)
})

test('INV-2 取消后不加载资源', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    featuresOperations.load({ id: 'sample' }, {
      abortSignal: controller.signal,
    } as FeaturesOperationContext)
  ).rejects.toThrow()
})

test('INV-3 默认引用不筛选目录，也不阻止加载未引用能力', async () => {
  const selected: FeatureSummary = {
    schemaVersion: 1,
    id: 'selected',
    name: 'Selected',
    description: '',
    version: '1.0.0',
    prompt: '',
    source: 'native',
    diagnostics: [],
    toolDependencies: [],
    generation: 'selected-installation',
    installed: true,
    builtin: false,
    grants: [],
  }
  const available = { ...selected, id: 'available', generation: 'available-installation' }
  const loaded: string[] = []
  const signal = new AbortController().signal
  const unexpected = async (): Promise<never> => {
    throw new AppError('INVARIANT', 'Discovery and loading must not request management changes.')
  }
  const context: FeaturesOperationContext = {
    abortSignal: signal,
    authorize: unexpected,
    recordEffect: () => {},
    features: {
      selection: [{ id: selected.id, generation: 'selected-installation' }],
      list: async () => [selected, available],
      load: async (input, cancellation) => {
        expect(cancellation).toBe(signal)
        loaded.push(input.id)
        return {
          feature: available,
          directory: '/features/available',
          instructions: 'Use as needed.',
        }
      },
      validate: unexpected,
      install: unexpected,
      remove: unexpected,
    },
  }
  expect(
    (await featuresOperations.list(context)).map(({ id, selected }) => ({ id, selected }))
  ).toEqual([
    { id: 'selected', selected: true },
    { id: 'available', selected: false },
  ])
  expect((await featuresOperations.load({ id: available.id }, context)).feature).toBe(available)
  expect(loaded).toEqual(['available'])
})

test('INV-1 安装授权等待期间修改原输入不改变已核验的来源与依赖脚本选择', async () => {
  const entered = Promise.withResolvers<void>()
  const approval = Promise.withResolvers<void>()
  const validated: unknown[] = []
  const approved: unknown[] = []
  const installed: unknown[] = []
  const effects: string[] = []
  const feature: FeatureSummary = {
    schemaVersion: 1,
    id: 'sample',
    name: 'Sample',
    description: '',
    version: '1.0.0',
    prompt: '',
    source: 'native',
    diagnostics: [],
    toolDependencies: [],
    generation: 'one',
    installed: true,
    builtin: false,
    grants: [],
  }
  const context: FeaturesOperationContext = {
    abortSignal: new AbortController().signal,
    authorize: async (operation, input) => {
      expect(operation).toBe('install')
      approved.push({ ...input })
      entered.resolve()
      await approval.promise
    },
    recordEffect: (effect) => effects.push(effect),
    features: {
      list: async () => [],
      validate: async (input) => {
        validated.push({ ...input })
        return feature
      },
      install: async (input) => {
        installed.push({ ...input })
        return feature
      },
      load: async () => {
        throw new AppError('INVARIANT', 'unexpected load')
      },
      remove: async () => {
        throw new AppError('INVARIANT', 'unexpected remove')
      },
    },
  }
  const input = { path: './approved', allowDependencyScripts: false }
  const pending = featuresOperations.install(input, context)
  try {
    await entered.promise
    input.path = './unapproved'
    input.allowDependencyScripts = true
  } finally {
    approval.resolve()
  }
  expect(await pending).toBe(feature)
  expect(validated).toEqual([{ path: './approved' }])
  expect(approved).toEqual([{ path: './approved', allowDependencyScripts: false }])
  expect(installed).toEqual(approved)
  expect(effects).toEqual(['none', 'unknown', 'committed'])
})

test('INV-1 卸载授权等待期间修改原输入不改变获准卸载的身份', async () => {
  const entered = Promise.withResolvers<void>()
  const approval = Promise.withResolvers<void>()
  const approved: unknown[] = []
  const removed: unknown[] = []
  const effects: string[] = []
  const context: FeaturesOperationContext = {
    abortSignal: new AbortController().signal,
    authorize: async (operation, input) => {
      expect(operation).toBe('remove')
      approved.push({ ...input })
      entered.resolve()
      await approval.promise
    },
    recordEffect: (effect) => effects.push(effect),
    features: {
      list: async () => [],
      validate: async () => {
        throw new AppError('INVARIANT', 'unexpected validate')
      },
      install: async () => {
        throw new AppError('INVARIANT', 'unexpected install')
      },
      load: async () => {
        throw new AppError('INVARIANT', 'unexpected load')
      },
      remove: async (input) => {
        removed.push({ ...input })
      },
    },
  }
  const input = { id: 'approved' }
  const pending = featuresOperations.remove(input, context)
  try {
    await entered.promise
    input.id = 'unapproved'
  } finally {
    approval.resolve()
  }
  await pending
  expect(approved).toEqual([{ id: 'approved' }])
  expect(removed).toEqual(approved)
  expect(effects).toEqual(['none', 'unknown', 'committed'])
})

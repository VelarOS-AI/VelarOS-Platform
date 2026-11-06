import { expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { FeaturesOperationContext } from '../index.js'
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
        implicit: true,
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

/**
 * @test-meta
 * title: 浏览器聚合入口首次解析即返回精确动作参数
 * summary: 扁平 provider schema 保持可发现，同时剔除其他 action 字段并展开弱模型 target aliases。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  browserActSchema,
  parseBrowserActInput,
} from '../../dist/tools/BrowserActSchema.js'
import {
  browserExtractSchema,
  parseBrowserExtractInput,
} from '../../dist/tools/BrowserExtractSchema.js'

test('browser:act overwrite keeps the flat shape while returning the exact navigate branch', () => {
  assert.ok(browserActSchema.shape.action)
  assert.ok(browserActSchema.shape.text)

  const input = {
    action: 'navigate',
    url: 'https://example.test/settings',
    text: 'belongs to the type action',
    targetRef: '@e3:g2',
  }
  const expected = {
    action: 'navigate',
    navigationAction: 'goto',
    url: 'https://example.test/settings',
  }

  assert.deepEqual(browserActSchema.parse(input), expected)
  assert.deepEqual(parseBrowserActInput(input), expected)
})

test('browser:act overwrite expands drag aliases in the first schema parse', () => {
  const parsed = browserActSchema.parse({
    action: 'drag',
    sourceRef: '@e3:g4',
    targetRef: '@e8:g4',
    text: 'belongs to another action',
  })

  assert.deepEqual(parsed, {
    action: 'drag',
    source: { ref: '@e3:g4', css: undefined },
    target: { ref: '@e8:g4', css: undefined },
  })
})

test('browser:extract overwrite returns only fields used by the selected action', () => {
  assert.ok(browserExtractSchema.shape.action)
  assert.ok(browserExtractSchema.shape.maxRows)

  const input = {
    action: 'content',
    format: 'markdown',
    maxChars: 400_000,
    maxRows: 10,
    nextPageSelector: '.next',
  }
  const expected = {
    action: 'content',
    format: 'markdown',
    maxChars: 200_000,
  }

  assert.deepEqual(browserExtractSchema.parse(input), expected)
  assert.deepEqual(parseBrowserExtractInput(input), expected)
})

test('failed exact branches remain ordinary safeParse failures', () => {
  assert.equal(browserActSchema.safeParse({ action: 'drag', targetRef: '@e8:g4' }).success, false)
  assert.equal(browserExtractSchema.safeParse({ action: 'unsupported' }).success, false)
})

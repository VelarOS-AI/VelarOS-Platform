import assert from 'node:assert/strict'

import { test } from 'bun:test'

const packageEntryPath = new URL('../dist/index.js', import.meta.url)

test('Project owns tool and project visibility policy', async () => {
  const project = await import(packageEntryPath.href)

  assert.equal(project.shouldSkipProjectDirectory('.git'), true)
  assert.equal(project.shouldRestrictProjectModelPathSegment('.git'), true)
  assert.equal(project.shouldSkipProjectDirectory('build'), true)
  assert.equal(project.shouldRestrictProjectModelPathSegment('build'), false)
  assert.equal(project.shouldSkipProjectDirectory('src'), false)
  assert.equal(
    project.shouldSkipProjectDiscoveryDirectory('.env', new Set()),
    true,
  )
  assert.equal(
    project.shouldSkipProjectDiscoveryDirectory('.xcodeproj', new Set()),
    false,
  )
  assert.equal(
    project.shouldSkipProjectDiscoveryDirectory('custom', new Set(['custom'])),
    true,
  )
})

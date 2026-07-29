import assert from 'node:assert/strict'

import { test } from 'bun:test'

const packageEntryPath = new URL('../dist/index.js', import.meta.url)

test('Workspace owns tool and project visibility policy', async () => {
  const workspace = await import(packageEntryPath.href)

  assert.equal(workspace.shouldSkipWorkspaceToolDirectory('.git'), true)
  assert.equal(workspace.shouldSkipWorkspaceToolDirectory('src'), false)
  assert.equal(
    workspace.shouldSkipProjectDiscoveryDirectory('.env', new Set()),
    true,
  )
  assert.equal(
    workspace.shouldSkipProjectDiscoveryDirectory('.xcodeproj', new Set()),
    false,
  )
  assert.equal(
    workspace.shouldSkipProjectDiscoveryDirectory('custom', new Set(['custom'])),
    true,
  )
})

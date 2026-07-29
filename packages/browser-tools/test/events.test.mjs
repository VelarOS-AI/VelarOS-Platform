/**
 * @test-meta
 * title: 浏览器阻塞事件工具动态注入
 * summary: 只有实时快照存在对应 pending 事件时，模型才能看到事件列表和处理器。
 * area: packages
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const packagePath = new URL('../dist/index.js', import.meta.url)

function createContext(pendingEvents, options = {}) {
  return {
    browser: {
      isActive: () => options.active ?? true,
      ...(options.withSnapshot === false
        ? {}
        : {
            getTurnContextSnapshot: () => ({ pendingEvents }),
          }),
    },
  }
}

test('browser pending event handlers stay hidden without pending events', async () => {
  const { browserTools } = await import(packagePath.href)
  const context = createContext({ dialog: 0, download: 0, permission: 0 })

  assert.equal(browserTools.browser_list_pending_events.isAvailable(context), false)
  assert.equal(browserTools.browser_handle_dialog.isAvailable(context), false)
  assert.equal(browserTools.browser_handle_download.isAvailable(context), false)
  assert.equal(browserTools.browser_handle_permission.isAvailable(context), false)
  assert.equal(browserTools.browser_wait_for_pending_event.isAvailable(context), true)
})

test('browser pending event handlers only expose the matching handler', async () => {
  const { browserTools } = await import(packagePath.href)
  const context = createContext({ dialog: 0, download: 0, permission: 1 })

  assert.equal(browserTools.browser_list_pending_events.isAvailable(context), true)
  assert.equal(browserTools.browser_handle_dialog.isAvailable(context), false)
  assert.equal(browserTools.browser_handle_download.isAvailable(context), false)
  assert.equal(browserTools.browser_handle_permission.isAvailable(context), true)
})

test('browser pending event handlers require an active snapshot', async () => {
  const { browserTools } = await import(packagePath.href)
  const pending = { dialog: 1, download: 1, permission: 1 }

  assert.equal(
    browserTools.browser_handle_permission.isAvailable(createContext(pending, { active: false })),
    false
  )
  assert.equal(
    browserTools.browser_handle_permission.isAvailable(
      createContext(pending, { withSnapshot: false })
    ),
    false
  )
})

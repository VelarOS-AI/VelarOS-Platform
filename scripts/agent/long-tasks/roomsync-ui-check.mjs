import assert from 'node:assert/strict'

// 按可访问名称定位编辑器；隐式 label 内 textarea 的初始正文不是字段名称。
export const roomJsonEditor = (page) =>
  page.getByRole('textbox', { name: 'JSON value', exact: true })

// 在新页面选择已存储的文档，允许可见正文或编辑器展示，避免把刚输入的值当作读取证明。
export async function readRoomDocument(page, key, text, timeoutMs = 5000) {
  await page.getByText(key, { exact: false }).first().click({ timeout: timeoutMs })
  const deadline = Date.now() + timeoutMs
  while (true) {
    const visible = await Promise.all(
      (await page.getByText(text, { exact: false }).all()).map((item) => item.isVisible())
    )
    const editor = roomJsonEditor(page)
    if (
      visible.some(Boolean) ||
      ((await editor.count()) === 1 &&
        (await editor.isVisible()) &&
        (await editor.inputValue()).includes(text))
    )
      return
    assert(Date.now() < deadline, 'Stored document content is not visibly rendered')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

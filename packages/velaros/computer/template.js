// velaros:computer 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 截图跟在程序结果后面交给你看，所以一般分两段：这一段 screenshot 看屏幕，下一段按图上量出的坐标动手，带上那张图的 snapshotId（照返回值原样抄）。
import { click, key, move, screenshot, typeText } from 'velaros:computer'

// 先看屏幕：图交给你看，返回值里是 snapshotId 与尺寸。
async function look() {
  const shot = await screenshot()
  return { snapshotId: shot.snapshotId, size: `${shot.width}×${shot.height}` }
}

// 点一下再输入：先点输入框拿到焦点，再输入文字、按回车。坐标按 snapshotId 那张截图量。
async function fillField(snapshotId, x, y, text) {
  await click({ x, y, snapshotId })
  await typeText({ text })
  return key({ keys: 'enter' })
}

// 双击打开、右键出菜单：count、button 按需给。
async function openThenMenu(snapshotId, x, y) {
  const opened = await click({ x, y, snapshotId, count: 2 })
  const menu = await click({ x, y, snapshotId, button: 'right' })
  return { opened, menu }
}

// 悬停看提示：只移过去，不点击。
async function hover(snapshotId, x, y) {
  return move({ x, y, snapshotId })
}

// 快捷键：一次一个组合键，用 + 连；macOS 用 cmd，Windows、Linux 用 ctrl。
async function selectAllAndCopy(modifier = 'cmd') {
  await key({ keys: `${modifier}+a` })
  return key({ keys: `${modifier}+c` })
}

// 屏幕变过（换了窗口、分辨率）旧坐标就作废：点失败时看 error.message，重新截一张，下一段按新图的坐标点。
async function clickOrRetake(snapshotId, x, y) {
  try {
    return await click({ x, y, snapshotId })
  } catch (error) {
    const fresh = await screenshot()
    return { failed: error.message, snapshotId: fresh.snapshotId }
  }
}

// 桌面控制不可用（插件没装、没给系统权限）时调用会抛错：把 message 原样告诉用户，不要自己去装依赖。
async function whyUnavailable() {
  try {
    await screenshot()
    return '可以用'
  } catch (error) {
    return error.message
  }
}

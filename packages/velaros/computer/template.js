// velaros:computer 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 截图跟在程序结果后面交给你看，所以一般分两段：这一段 screenshot 看屏幕，下一段按图上量出的坐标动手，带上那张图的 snapshotId（照返回值原样抄）。
import { capabilities, click, drag, invokeElement, key, keyDown, keyUp, move, record, screenshot, screenshotWindow, scroll, typeText, uiTree, windows } from 'velaros:computer'

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

// 桌面控制不可用（运行时缺失、没给系统权限）时调用会抛错：把 message 原样告诉用户，不要自己去装依赖。
async function whyUnavailable() {
  try {
    await screenshot()
    return '可以用'
  } catch (error) {
    return error.message
  }
}

// 先枚举窗口和后端能力，选定 id 后下一段再检查控件树或窗口截图。
async function discoverWindows() {
  return { capabilities: await capabilities(), windows: await windows() }
}

// 有控件树时优先查语义；没有时返回窗口截图，按该图的 window 坐标操作。
async function inspectWindow(windowId) {
  const support = await capabilities()
  if (support.uiTree) return uiTree({ windowId, maxDepth: 6, maxNodes: 200 })
  return screenshotWindow({ windowId })
}

// 控件 id 必须来自刚刚观察过的那次 uiTree；不把控件名称猜成坐标。
async function activateControl(treeId, elementId) {
  return invokeElement({ treeId, elementId })
}

// 独立滚轮与原子拖拽，坐标都携带对应截图的绑定。
async function scrollAt(snapshotId, x, y) {
  return scroll({ at: { x, y, snapshotId }, deltaY: 3 })
}

async function dragBetween(snapshotId, fromX, fromY, toX, toY) {
  return drag({ from: { x: fromX, y: fromY, snapshotId }, to: { x: toX, y: toY, snapshotId }, durationMs: 500 })
}

// 跨动作修饰键必须保证释放；原子的快捷键优先直接用 key。
async function modifiedClick(snapshotId, x, y) {
  await keyDown({ key: 'shift' })
  try {
    return await click({ x, y, snapshotId })
  } finally {
    await keyUp({ key: 'shift' })
  }
}

// 有限时长录像在编码器完全关闭后才返回；path 必须是不存在的绝对路径 MP4。
async function recordEvidence(path) {
  return record({ path, durationMs: 1000, fps: 5 })
}

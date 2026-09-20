// velaros:images 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 图不在返回值里：调用 view 就交给你看了，跟在程序结果后面；只给你看一次，你一回应就撤掉，要再看就再调一次 view。
import { view } from 'velaros:images'

// 看一张图（截图、设计稿、报错截图）：返回值里只有尺寸；sent 比原图小就说明压过。
async function look(path = 'screenshot.png') {
  const [image] = (await view({ files: [{ path }] })).files
  return image
}

// 几张一起看（改之前、改之后）：看不了的那一张单独是失败（用 'error' in 分开），别的照常。
async function compare(paths = ['before.png', 'after.png']) {
  const { files } = await view({ files: paths.map((path) => ({ path })) })
  return files.map((file) => ('error' in file ? `${file.path}：${file.error.message}` : `${file.path}：${file.width}×${file.height}`))
}

// 压小之后看不清的地方，用 region 单独要那一块（按原图像素算）；原图的宽高在上一次 view 的结果里。
async function zoom(path = 'screenshot.png', width = 2880, height = 1800) {
  const topRight = { x: Math.floor(width / 2), y: 0, width: Math.ceil(width / 2), height: Math.ceil(height / 2) }
  return (await view({ files: [{ path, region: topRight }] })).files
}

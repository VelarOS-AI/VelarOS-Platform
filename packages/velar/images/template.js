// velar:images 的代码模版：一段一个函数、一种用法，挑要的照着改。
// 图不在返回值里：调用 view 就交给你看了，跟在结果后面，只给你看一次——你一回应就撤掉，要再看就再调一次 view。
import { view } from 'velar:images'

// 看一张图：在上限以内的原样给你，大图会压小；结果里 sent 比原图小就说明压过。
async function lookAt(path = 'screen.png') {
  const [image] = (await view({ files: [{ path }] })).files
  return image
}

// 一次看几张：看不了的那一张单独是失败（用 'error' in 分开），别的照常。
async function compare(paths = ['before.png', 'after.png']) {
  const { files } = await view({ files: paths.map((path) => ({ path })) })
  return files.map((f) => ('error' in f ? { path: f.path, error: f.error.message } : { path: f.path, size: `${f.width}×${f.height}` }))
}

// 压小之后看不清的地方，用 region 单独要那一块（按原图像素算）；原图尺寸在上一次 view 的结果里。
async function zoomTopRight(path = 'screen.png', width = 3840, height = 2160) {
  const region = { x: Math.floor(width / 2), y: 0, width: Math.ceil(width / 2), height: Math.ceil(height / 2) }
  return (await view({ files: [{ path, region }] })).files
}

/** pdfjs 在 Node 里跑起来要的东西：补齐浏览器图形全局、懒加载 pdfjs、定位标准字体目录。 */

import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'

import { isFunction, isPlainObject, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { PdfjsModule, PdfjsNodeGlobals } from '../../types/pdf.js'

const log = Log.tag('OfficePdfRuntime')

/** 以本模块为基准创建的 require，用来定位 pdfjs 包的安装位置。 */
const requireFromOfficeModule = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
)

/** 判断一个模块是不是 pdfjs：只看本包真正调用的 getDocument。 */
function isPdfjsModule(value: unknown): value is PdfjsModule {
  return isPlainObject(value) && isFunction(value.getDocument)
}

/**
 * 以 pdfjs 需要的那一面看待全局作用域。
 *
 * 判据（§1.4）：`typeof globalThis` 里没有这三个浏览器全局的声明（本包不引 DOM lib——引了会
 * 让整个 Node 侧类型面凭空多出一整套浏览器 API）。所以这里在**唯一一处**把全局收窄成
 * 「可选三成员」的视图，其余代码只跟这个视图打交道，不再各自断言。
 */
function readPdfjsNodeGlobals(): PdfjsNodeGlobals {
  return globalThis as PdfjsNodeGlobals
}

/** 把 pdfjs 在 Node 环境里要用的 DOMMatrix / ImageData / Path2D 装进全局，用的是随包 canvas 的真实实现。 */
export function ensurePdfjsNodeGlobals(): void {
  const g = readPdfjsNodeGlobals()
  if (!g.DOMMatrix) g.DOMMatrix = DOMMatrix
  if (!g.ImageData) g.ImageData = ImageData
  if (!g.Path2D) g.Path2D = Path2D
}

/**
 * 懒加载 pdfjs，并在加载前先把 Node 运行时的图形全局补齐。
 *
 * 这里的 `import()` 是**故意的动态加载**：pdfjs 的模块体在求值时就会摸 DOMMatrix 这类全局，
 * 改成文件头的静态 import 会让它在 `ensurePdfjsNodeGlobals()` 之前求值，直接炸。
 */
export async function loadPdfjs(): Promise<PdfjsModule> {
  ensurePdfjsNodeGlobals()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (!isPdfjsModule(pdfjs)) {
    throw new AppError('EXECUTION_FAILED', 'pdfjs-dist 没有暴露 getDocument，PDF 运行时不可用。')
  }
  return pdfjs
}

/** pdfjs 的标准字体目录；从环境变量（登记在 OfficeEnvironmentVariables）或包安装位置推导，失败时交给 pdfjs 用它的默认策略。 */
export function getPdfjsStandardFontDataUrl(): string | undefined {
  const packagedRoot = process.env.VELAROS_PDFJS_STANDARD_FONTS_ROOT?.trim()
  if (packagedRoot) return `${resolve(packagedRoot).replaceAll('\\', '/')}/`
  try {
    const packageJsonPath = requireFromOfficeModule.resolve('pdfjs-dist/package.json')
    return `${dirname(packageJsonPath).replaceAll('\\', '/')}/standard_fonts/`
  } catch (error) {
    log.debug('解析 pdfjs 标准字体数据路径失败', { error })
    return undefined
  }
}

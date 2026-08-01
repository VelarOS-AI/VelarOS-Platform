#!/usr/bin/env node
/**
 * 把浏览器产物 `dist/browser/page.js` 再发一份成**普通 ESM 模块**：
 * `dist/browser/page-source.js` 导出它的全文字符串。
 *
 * ## 为什么要多这一份
 * 内置静态服务要把这段字节送给页面，而这段字节与主进程走的是两条打包路径：主进程被打成
 * `out/main/index.js`（`@velaros-ai/game` 在 `externalizeDeps.exclude` 里，整包打进去），
 * 页面产物是 `bun build --target=browser` 单独打的，**不在**那份 bundle 里。宿主要拿到它，
 * 只有「运行期按路径读盘」和「构建期内联成常量」两条路。
 *
 * 读盘那条在打包版会碎：包内 `import.meta.url` 指向 bundle 自己，而
 * `node_modules/@velaros-ai/game` 在本地开发时是指向 sibling 仓的符号链接——asar 跟不跟随、
 * 跟随后路径长什么样，每次动打包配置都可能变。
 *
 * 内联那条则要选「怎么内联」。用宿主构建插件（Vite 虚拟模块）也能做，但 Desktop 有**两条**
 * 主进程工具链（electron-vite 与 `scripts/dev/devFast.mjs` 的 esbuild），插件要写两遍、
 * 而且天生会漂。发成一个普通模块之后，两条工具链都只是在解析一个再平常不过的 import，
 * 一份实现覆盖全部形态——这就是本文件存在的唯一理由。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(packageRoot, 'dist/browser/page.js')
const modulePath = resolve(packageRoot, 'dist/browser/page-source.js')
const typesPath = resolve(packageRoot, 'dist/browser/page-source.d.ts')

const source = readFileSync(bundlePath, 'utf8')
if (!source.trim()) {
  throw new Error(`${bundlePath} 是空的；浏览器产物没有真的构建出来。`)
}

mkdirSync(dirname(modulePath), { recursive: true })
writeFileSync(
  modulePath,
  `// 由 scripts/emitBrowserPageSource.mjs 生成，请勿手改。\nexport const GameBrowserPageScript = ${JSON.stringify(source)}\n`,
)
writeFileSync(
  typesPath,
  `// 由 scripts/emitBrowserPageSource.mjs 生成，请勿手改。\n/** \`@velaros-ai/game\` 的浏览器运行时全文（含 phaser 与声明层投影），由宿主内置静态服务送给页面。 */\nexport declare const GameBrowserPageScript: string\n`,
)
console.info(
  `emit-browser-page-source: wrote dist/browser/page-source.js (${source.length} chars).`,
)

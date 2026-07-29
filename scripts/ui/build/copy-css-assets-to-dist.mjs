#!/usr/bin/env node
// 用途：把当前 package src 下的全部 .css 资产按原相对路径拷入 dist（CSS Modules 与 ?raw 源）。
/**
 * tsc 只发射 js/d.ts；组件里 `./X.module.css` 相对 import 与 `./X.css?raw` 源在 dist JS 中
 * 原样保留——不拷贝则纯 dist 消费（node_modules exports 解析、不走宿主 src 别名）必然断链，
 * package.json 里 css 子路径 exports 也会指向不存在的实体。
 *
 * 在各包 `package.json` 的 `build` 中、`tsc` 成功之后执行：
 * `node ../../scripts/build/copy-css-assets-to-dist.mjs`（在 `packages/<name>` 下 cwd 运行）。
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const srcDir = resolve(process.cwd(), 'src')
const distDir = resolve(process.cwd(), 'dist')

let copied = 0
walk(srcDir)

console.info(`copy-css-assets-to-dist: copied ${copied} css assets into ${distDir}.`)

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.name.endsWith('.css')) continue
    const dest = join(distDir, relative(srcDir, full))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(full, dest)
    copied += 1
  }
}

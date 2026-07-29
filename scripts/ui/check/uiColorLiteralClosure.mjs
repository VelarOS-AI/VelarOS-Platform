#!/usr/bin/env node
/**
 * 用途:内核宪章 §12.9「双色种子体系」执法门——`@velaros-ai/ui` 组件禁裸 hex/rgb/hsl 色值,只降不升。
 *
 * 法条:全产品颜色只有两个可配置种子(主题色 `--velar-primary` + 副色 `--velar-accent`);其余颜色
 * (表面/边框/文字/状态 tint/hover 态)从双种子派生为**语义令牌**,组件只引语义令牌。裸色值的唯一
 * 合法住所是**令牌层**(`packages/ui/src/styles/tokens/**`)。
 *
 * 本门扫描:
 *   - 组件样式 `packages/ui/src/styles/components/**.css`(令牌目录豁免)
 *   - 组件源码 `packages/ui/src/**.{ts,tsx}`(内联样式里的裸色值,styles/ 与 tokens 目录豁免)
 * 命中:`#rgb`/`#rrggbb`/`#rrggbbaa` 十六进制、`rgb(/rgba(`、`hsl(/hsla(` 字面量(`var(--…)` 与命名色不算)。
 *
 * 自 monorepo arch-guard-velaros 的 uiColorLiteralClosure(§12.9)收编;指纹改为「文件+字面量+序数」
 * 的行无关形态(比原行号型更稳:行位移不误判新违规,新增裸色值仍即红),语义等价=组件层不再新增裸色值。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  collectFiles,
  isInsideDirectory,
  RepoRoot,
  runRatchet,
  stripCssComments,
  stripTsComments,
  toRelativePath,
  UiSourceDir,
} from './archGateLib.mjs'

const StyleExtensions = new Set(['.css'])
const SourceExtensions = new Set(['.ts', '.tsx'])
// 十六进制 / rgb(a) / hsl(a) 数值字面量;命名色(white/black/transparent/currentColor)与 var(--…) 不计。
const ColorLiteralPattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*[\d.]|\bhsla?\(\s*[\d.]/g

function scanFile(file, stripComments, entries, perFileOrdinal) {
  const relativePath = toRelativePath(file)
  const scanned = stripComments(readFileSync(file, 'utf8'))
  scanned.split('\n').forEach((lineText, index) => {
    for (const match of lineText.matchAll(ColorLiteralPattern)) {
      const literal = match[0]
      const key = `${relativePath}::${literal}`
      const ordinal = perFileOrdinal.get(key) ?? 0
      perFileOrdinal.set(key, ordinal + 1)
      entries.push({
        fingerprint: `${relativePath}::${literal}::#${ordinal}`,
        message: `${relativePath}:${index + 1}: 裸色值 \`${literal}\`——§12.9 双色种子体系禁组件层裸 hex/rgb/hsl。改引语义令牌(从 --velar-primary/--velar-accent 派生);裸色值只许住令牌层。`,
      })
    }
  })
}

function main() {
  const componentStylesDir = resolve(UiSourceDir, 'styles/components')
  const stylesDir = resolve(UiSourceDir, 'styles')
  const tokensDir = resolve(UiSourceDir, 'styles/tokens')

  const entries = []
  const perFileOrdinal = new Map()

  for (const file of collectFiles(componentStylesDir, StyleExtensions)) {
    scanFile(file, stripCssComments, entries, perFileOrdinal)
  }

  const sourceFiles = collectFiles(UiSourceDir, SourceExtensions).filter(
    (file) =>
      !file.endsWith('.d.ts') &&
      !isInsideDirectory(file, stylesDir) &&
      !isInsideDirectory(file, tokensDir),
  )
  for (const file of sourceFiles) {
    scanFile(file, stripTsComments, entries, perFileOrdinal)
  }

  const ok = runRatchet('ui-color-literal-closure', 'UI color literal closure(§12.9 dual-seed)', entries)
  if (!ok) process.exit(1)
}

main()

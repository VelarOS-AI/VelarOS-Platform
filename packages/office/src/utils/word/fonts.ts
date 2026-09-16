/** Word 字体族与 macOS 上跑 LibreOffice 要用的 fontconfig 配置。 */

import { platform as nodePlatform } from 'node:os'
import { posix } from 'node:path'

import type { WordDocumentLanguage, WordFontFamilies } from '../../types/word.js'

/**
 * 按生成端的操作系统挑真正装得到的字体。
 *
 * 老的 SimSun/SimHei 缺省只有 Windows 有，headless LibreOffice 在 macOS/Linux 上
 * 会因此产出 CJK 字形映射损坏的 PDF。
 */
export function resolveWordFontFamilies(
  language: WordDocumentLanguage,
  hostPlatform: NodeJS.Platform = nodePlatform(),
): WordFontFamilies {
  if (language === 'en-US') return { body: 'Times New Roman', heading: 'Aptos Display' }
  if (hostPlatform === 'darwin') return { body: 'Arial Unicode MS', heading: 'Arial Unicode MS' }
  if (hostPlatform === 'win32') return { body: 'Microsoft YaHei', heading: 'Microsoft YaHei' }
  return { body: 'Noto Sans CJK SC', heading: 'Noto Sans CJK SC' }
}

/** 转义写进 fontconfig XML 的目录名。 */
function escapeFontConfigXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * 生成 macOS 上跑 LibreOffice 用的 fontconfig：列出系统与用户字体目录，并指定一个可写的缓存目录。
 *
 * 可重定位/headless 的 LibreOffice 包会把占位缓存目录当字面路径解析，结果把中日韩文本
 * 替换成不相干的字体；给它一份真实可写的缓存目录就不会。
 */
export function buildMacLibreOfficeFontConfig(input: {
  homeDir: string
  cacheDir: string
}): string {
  const directories = [
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    posix.join(input.homeDir, 'Library', 'Fonts'),
  ]
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<fontconfig>',
    ...directories.map((directory) => `  <dir>${escapeFontConfigXml(directory)}</dir>`),
    `  <cachedir>${escapeFontConfigXml(input.cacheDir)}</cachedir>`,
    '</fontconfig>',
    '',
  ].join('\n')
}

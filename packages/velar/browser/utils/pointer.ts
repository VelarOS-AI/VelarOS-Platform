/** 虚拟指针的 SVG 生成：外观常量住在合同的常量表里，这里只负责拼标记。 */

import { BrowserFallbackVirtualPointer } from '../contract/constants.js'

/** 页面注入脚本使用的无交互 SVG；所有动态位置和动画由外层元素承担。 */
export function buildBrowserFallbackVirtualPointerSvg(): string {
  const pointer = BrowserFallbackVirtualPointer
  // @arch-guard:suspend code-style/require-chinese-comments 理由：下面是 SVG 标记模板，不是说明文案；命名空间 URL 与属性名被启发式误判为英文散文。
  return `<svg width="${pointer.width}" height="${pointer.height}" viewBox="${pointer.viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="${pointer.path}" fill="${pointer.fill}" stroke="${pointer.stroke}" stroke-width="${pointer.strokeWidth}" stroke-linejoin="round"/></svg>`
}
